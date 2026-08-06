/**
 * Contract tests for the O006 proactive-probe adapters.
 *
 * Each adapter under test here is exercised through the same production classes/schemas it
 * delegates to (LinearGraphqlTransport + LinearReadModel + LinearMutationClient; GhTransport's
 * own JSON schemas; a real local `git` bare repository; the real W004 WebhookRuntimeProbeClient),
 * with only the outermost transport (`fetch`, `gh`'s method-level result, or a real local git
 * remote) faked to a fixed, documented fixture. Fixtures below are annotated with their source
 * and version; none contain secrets -- every credential-shaped value is a literal test constant.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RegistrationProbeBranchCleanupAdapter,
  RegistrationProbeFileAdapter,
  RegistrationProbeGitAdapter,
  RegistrationProbeGitHubCapabilityAdapter,
  RegistrationProbeLinearAdapter,
  RegistrationProbeProviderEventAdapter,
  RegistrationProbeWebhookAdapter,
  FileRegistrationProbeJournalStore,
} from "../../src/adapters/registration/index.js";
import type { GhTransport } from "../../src/adapters/github/index.js";
import {
  LinearGraphqlTransport,
  LinearMutationClient,
  LinearReadModel,
} from "../../src/adapters/linear/index.js";
import {
  linearAgentRoleNames,
  linearAgentStatusNames,
  linearBlockingReasonNames,
  linearReviewRequirementNames,
  linearWorkStatusNames,
  type LinearWorkflowStateRecord,
} from "../../src/adapters/linear/model.js";
import { createFixedClock, domainError, err, ok } from "../../src/domain/foundation/index.js";
import type {
  RegistrationProbeBranchCleanupCommand,
  RegistrationProbeLinearCreateCommand,
  RegistrationProbeLinearTarget,
} from "../../src/application/ports/index.js";
import { registrationProbeMarker } from "../../src/application/registration/index.js";
import type {
  WebhookRuntimeProbeInbox,
  WebhookRuntimeTransport,
} from "../../src/cli/probe/index.js";

const execFileAsync = promisify(execFile);
const now = "2026-08-06T00:00:00.000Z";
const mutationOptions = Object.freeze({ idempotencyKey: "contract-test-key" });

/* -------------------------------------------------------------------------------------------- *
 * Linear -- fixture source: Linear GraphQL API v2026-06 shape, hand-derived from the same
 * `AgentTeamRead*`/`AgentTeamCreateIssue`/`AgentTeamUpdateIssue` queries the production
 * LinearReadModel/LinearMutationClient send (src/adapters/linear/read.ts, write.ts). No secret
 * values; the `apiKey` passed to LinearGraphqlTransport is a literal test string.
 * -------------------------------------------------------------------------------------------- */

interface FakeLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  updatedAt: string;
  teamId: string;
  projectId: string;
  stateId: string;
  labelIds: string[];
}

function mustFind<Value>(values: readonly Value[], predicate: (value: Value) => boolean): Value {
  const found = values.find(predicate);
  if (found === undefined) throw new Error("fixture invariant violated: expected value not found");
  return found;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildLinearFixture() {
  const teamId = "team-018f47d2";
  const projectId = "linear-project-018f47d2";
  const states: LinearWorkflowStateRecord[] = Object.entries(linearWorkStatusNames).map(
    ([status, name], index) => ({ id: `state-${status}-${String(index)}`, name, type: status }),
  );
  const backlogStateId = mustFind(
    states,
    (state) => state.name === linearWorkStatusNames.backlog,
  ).id;
  const canceledStateId = mustFind(
    states,
    (state) => state.name === linearWorkStatusNames.canceled,
  ).id;

  // Wire shape as sent over the real Linear GraphQL API (`labelSchema` in src/adapters/linear/
  // read.ts): a nested `parent: {id} | null`, not the locally-mapped `LinearLabelRecord.parentId`.
  interface WireLinearLabel {
    readonly id: string;
    readonly name: string;
    readonly isGroup: boolean;
    readonly parent: Readonly<{ id: string }> | null;
  }
  function group(groupName: string, id: string): WireLinearLabel {
    return { id, name: groupName, isGroup: true, parent: null };
  }
  function child(name: string, parentId: string, id: string): WireLinearLabel {
    return { id, name, isGroup: false, parent: { id: parentId } };
  }
  const agentRoleGroupId = "label-group-agent-role";
  const reviewRequirementGroupId = "label-group-review-requirement";
  const agentStatusGroupId = "label-group-agent-status";
  const blockingReasonGroupId = "label-group-blocking-reason";
  const labels: WireLinearLabel[] = [
    group("Agent 角色", agentRoleGroupId),
    ...Object.entries(linearAgentRoleNames).map(([key, name], index) =>
      child(name, agentRoleGroupId, `label-agent-role-${key}-${String(index)}`),
    ),
    group("審查需求", reviewRequirementGroupId),
    ...Object.entries(linearReviewRequirementNames).map(([key, name], index) =>
      child(name, reviewRequirementGroupId, `label-review-requirement-${key}-${String(index)}`),
    ),
    group("Agent 狀態", agentStatusGroupId),
    ...Object.entries(linearAgentStatusNames).map(([key, name], index) =>
      child(name, agentStatusGroupId, `label-agent-status-${key}-${String(index)}`),
    ),
    group("阻塞原因", blockingReasonGroupId),
    ...Object.entries(linearBlockingReasonNames).map(([key, name], index) =>
      child(name, blockingReasonGroupId, `label-blocking-reason-${key}-${String(index)}`),
    ),
  ];

  const issues: FakeLinearIssue[] = [];
  let issueSequence = 0;

  async function fakeFetch(_url: string, init: RequestInit): Promise<Response> {
    await Promise.resolve();
    const parsedBody = JSON.parse(init.body as string) as {
      readonly operationName: string;
      readonly variables: Readonly<Record<string, unknown>>;
    };
    const { operationName, variables } = parsedBody;
    switch (operationName) {
      case "AgentTeamReadIdentity": {
        const teamMatches = variables["teamId"] === teamId;
        const projectMatches = variables["projectId"] === projectId;
        return jsonResponse({
          data: {
            team: teamMatches ? { id: teamId, name: "Sandbox", key: "SBX" } : null,
            project: projectMatches ? { id: projectId, name: "Sandbox Project" } : null,
          },
        });
      }
      case "AgentTeamReadProjectTeams":
        return jsonResponse({
          data: {
            project: {
              teams: { nodes: [{ id: teamId }], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        });
      case "AgentTeamReadStates":
        return jsonResponse({
          data: {
            team: { states: { nodes: states, pageInfo: { hasNextPage: false, endCursor: null } } },
          },
        });
      case "AgentTeamReadLabels":
        return jsonResponse({
          data: {
            issueLabels: { nodes: labels, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        });
      case "AgentTeamCreateIssue": {
        const input = variables["input"] as Readonly<Record<string, unknown>>;
        issueSequence += 1;
        const issue: FakeLinearIssue = {
          id: `issue-${String(issueSequence)}`,
          identifier: `SBX-${String(issueSequence)}`,
          title: String(input["title"]),
          description: String(input["description"]),
          priority: Number(input["priority"]),
          updatedAt: now,
          teamId: String(input["teamId"]),
          projectId: String(input["projectId"]),
          stateId: String(input["stateId"]),
          labelIds: [...((input["labelIds"] as readonly string[] | undefined) ?? [])],
        };
        issues.push(issue);
        return jsonResponse({
          data: {
            issueCreate: { success: true, issue: { id: issue.id, identifier: issue.identifier } },
          },
        });
      }
      case "AgentTeamReadIssue": {
        const issue = issues.find((candidate) => candidate.id === variables["issueId"]);
        if (issue === undefined) return jsonResponse({ data: { issue: null } });
        return jsonResponse({
          data: {
            issue: {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description,
              priority: issue.priority,
              updatedAt: issue.updatedAt,
              team: { id: issue.teamId },
              project: { id: issue.projectId },
              state: { id: issue.stateId },
            },
          },
        });
      }
      case "AgentTeamReadIssueLabels": {
        const issue = issues.find((candidate) => candidate.id === variables["issueId"]);
        return jsonResponse({
          data: {
            issue:
              issue === undefined
                ? null
                : {
                    labels: {
                      nodes: issue.labelIds.map((id) => ({ id })),
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
          },
        });
      }
      case "AgentTeamReadIssueComments":
        return jsonResponse({
          data: {
            issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          },
        });
      case "AgentTeamReadIssueRelations":
        return jsonResponse({
          data: {
            issue: { relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          },
        });
      case "AgentTeamReadIssueInverseRelations":
        return jsonResponse({
          data: {
            issue: {
              inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        });
      case "AgentTeamUpdateIssue": {
        const issue = issues.find((candidate) => candidate.id === variables["issueId"]);
        if (issue === undefined) {
          return jsonResponse({ data: { issueUpdate: { success: false, issue: null } } });
        }
        const input = variables["input"] as Readonly<Record<string, unknown>>;
        if (typeof input["stateId"] === "string") issue.stateId = input["stateId"];
        if (Array.isArray(input["labelIds"])) issue.labelIds = [...(input["labelIds"] as string[])];
        return jsonResponse({
          data: {
            issueUpdate: { success: true, issue: { id: issue.id, identifier: issue.identifier } },
          },
        });
      }
      case "AgentTeamFindProbeIssueByMarker": {
        const matches = issues.filter(
          (issue) =>
            issue.teamId === variables["teamId"] &&
            issue.projectId === variables["projectId"] &&
            issue.description === variables["marker"],
        );
        return jsonResponse({
          data: {
            issues: {
              nodes: matches.map((issue) => ({
                id: issue.id,
                state: { type: issue.stateId === canceledStateId ? "canceled" : "backlog" },
              })),
            },
          },
        });
      }
      default:
        throw new Error(`fixture does not model operation ${operationName}`);
    }
  }

  const transport = new LinearGraphqlTransport({ apiKey: "test-linear-api-key", fetch: fakeFetch });
  const readModel = new LinearReadModel(transport);
  const mutationClient = new LinearMutationClient(transport, readModel);
  const target: RegistrationProbeLinearTarget = Object.freeze({
    teamId,
    projectId,
    workflowStateId: backlogStateId,
  });
  return {
    adapter: new RegistrationProbeLinearAdapter(readModel, mutationClient, transport),
    target,
    issues,
  };
}

describe("RegistrationProbeLinearAdapter", () => {
  it("confirms read/write and cancel capability against the real O003 backlog/canceled catalog", async () => {
    const { adapter, target } = buildLinearFixture();
    const capability = await adapter.readCapability(target);
    expect(capability).toEqual(ok({ readWrite: true, cancelable: true }));
  });

  it("fails closed when the caller-supplied workflowStateId does not match the real backlog state", async () => {
    const { adapter, target } = buildLinearFixture();
    const capability = await adapter.readCapability({
      ...target,
      workflowStateId: "wrong-state-id",
    });
    expect(capability.ok).toBe(false);
  });

  it("creates, reads, and cancels a probe issue end to end without an Agent role label", async () => {
    const { adapter, target, issues } = buildLinearFixture();
    const marker = registrationProbeMarker("contract-run-1");
    const command: RegistrationProbeLinearCreateCommand = Object.freeze({
      target,
      marker,
      title: "Agent Team 主動 Probe：contract-run-1",
      body: marker,
    });
    const created = await adapter.create(command, mutationOptions);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.code);
    expect(issues[0]?.labelIds).toEqual([]);

    const read = await adapter.read(created.value.issueId);
    expect(read).toEqual(ok({ issueId: created.value.issueId, state: "open" }));

    const cancelled = await adapter.cancel(created.value.issueId, mutationOptions);
    expect(cancelled).toEqual(ok({ issueId: created.value.issueId, state: "cancelled" }));

    const cancelledAgain = await adapter.cancel(created.value.issueId, mutationOptions);
    expect(cancelledAgain).toEqual(ok({ issueId: created.value.issueId, state: "cancelled" }));
  });

  it("recovers an unknown create outcome by exact marker rather than creating a duplicate", async () => {
    const { adapter, target } = buildLinearFixture();
    const marker = registrationProbeMarker("contract-run-2");
    const command: RegistrationProbeLinearCreateCommand = Object.freeze({
      target,
      marker,
      title: "Agent Team 主動 Probe：contract-run-2",
      body: marker,
    });
    const created = await adapter.create(command, mutationOptions);
    if (!created.ok) throw new Error(created.error.code);

    const recovered = await adapter.findByMarker(target, marker);
    expect(recovered).toEqual(ok({ issueId: created.value.issueId, state: "open" }));

    const missing = await adapter.findByMarker(target, registrationProbeMarker("contract-run-3"));
    expect(missing).toEqual(ok(undefined));
  });
});

/* -------------------------------------------------------------------------------------------- *
 * GitHub capability -- fixture source: GitHub REST API v2026-06-01 response shapes as already
 * modelled by GhTransport's own zod schemas (src/adapters/github/transport.ts); faked at the
 * GhTransport-method boundary, matching this repo's existing `github-registration-policy` and
 * `github.ts` contract-test convention rather than shelling out to a real `gh` binary.
 * -------------------------------------------------------------------------------------------- */

class FakeGhCapabilityTransport implements Pick<
  GhTransport,
  "inspectAuthentication" | "inspectRepositoryCapabilities" | "requestJson"
> {
  admin = true;
  push = true;
  rulesetCount = 1;
  ciSuccess = true;
  readonly pulls: {
    number: number;
    id: string;
    state: "open" | "closed" | "merged";
    draft: boolean;
    headRefName: string;
    headRefOid: string;
    body: string;
  }[] = [];

  inspectAuthentication() {
    return Promise.resolve(
      ok({ active: true as const, host: "github.com", accountFingerprint: "fp" }),
    );
  }

  inspectRepositoryCapabilities() {
    return Promise.resolve(
      ok({
        visibility: "private" as const,
        private: true,
        defaultBranch: "main",
        allowAutoMerge: false,
        deleteBranchOnMerge: true,
        permissions: { admin: this.admin, maintain: this.admin, pull: true, push: this.push },
        rulesets: { available: true, count: this.rulesetCount },
        branchProtection: { available: false, failure: "not_found_or_not_configured" as const },
        requiredMergeGate: "unverified" as const,
      }),
    );
  }

  requestJson<Output>(arguments_: readonly string[], schema: z.ZodType<Output>) {
    const endpoint = arguments_[1] ?? "";
    let value: unknown;
    if (endpoint.endsWith("/actions/workflows")) {
      value = { activeWorkflowCount: 1 };
    } else if (endpoint.endsWith("/actions/runs")) {
      value = {
        runCount: this.ciSuccess ? 1 : 0,
        latest: this.ciSuccess
          ? { headBranch: "main", status: "completed", conclusion: "success" }
          : null,
      };
    } else if (/^repos\/[^/]+\/[^/]+$/u.test(endpoint)) {
      value = { defaultBranch: "main" };
    } else if (endpoint.endsWith("/pulls")) {
      value = this.pulls.map((pull) => ({
        number: pull.number,
        id: pull.id,
        state: pull.state,
        draft: pull.draft,
        headRefName: pull.headRefName,
        headRefOid: pull.headRefOid,
        body: pull.body,
      }));
    } else {
      value = {};
    }
    const parsed = schema.safeParse(value);
    return Promise.resolve(
      parsed.success ? ok(parsed.data) : err(domainError("external_failure" as const)),
    );
  }
}

describe("RegistrationProbeGitHubCapabilityAdapter", () => {
  const target = Object.freeze({ repository: "owner/sandbox", defaultBranch: "main" });

  it("derives capability flags from admin permission, a provisioned ruleset, and a successful CI run", async () => {
    const transport = new FakeGhCapabilityTransport();
    const adapter = new RegistrationProbeGitHubCapabilityAdapter(transport);
    const result = await adapter.inspect(target);
    expect(result).toEqual(
      ok({
        permission: "admin",
        requiredCheckConfigured: true,
        reviewStatusSupported: true,
        ciWorkflowConfirmed: true,
        pushCapable: true,
        draftPullRequestCapable: true,
        closeCapable: true,
      }),
    );
  });

  it("reports read_only and unconfirmed CI when the identity lacks admin/push and CI never ran", async () => {
    const transport = new FakeGhCapabilityTransport();
    transport.admin = false;
    transport.push = false;
    transport.rulesetCount = 0;
    transport.ciSuccess = false;
    const adapter = new RegistrationProbeGitHubCapabilityAdapter(transport);
    const result = await adapter.inspect(target);
    expect(result).toEqual(
      ok({
        permission: "read_only",
        requiredCheckConfigured: false,
        reviewStatusSupported: false,
        ciWorkflowConfirmed: false,
        pushCapable: false,
        draftPullRequestCapable: false,
        closeCapable: false,
      }),
    );
  });

  it("recovers a Draft PR by exact head branch and marker, never by fuzzy title", async () => {
    const transport = new FakeGhCapabilityTransport();
    const marker = registrationProbeMarker("contract-run-4");
    transport.pulls.push({
      number: 77,
      id: "PR_kwDOsandbox77",
      state: "open",
      draft: true,
      headRefName: "agent-team/probe/contract-run-4",
      headRefOid: "a".repeat(40),
      body: marker,
    });
    const adapter = new RegistrationProbeGitHubCapabilityAdapter(transport);
    const found = await adapter.findDraftPullRequestByHead(
      { repository: "owner/sandbox", headBranch: "agent-team/probe/contract-run-4" },
      marker,
    );
    expect(found).toEqual(
      ok({
        changeRequestId: "77",
        number: 77,
        headSha: "a".repeat(40),
        state: "open",
        draft: true,
      }),
    );

    const wrongMarker = await adapter.findDraftPullRequestByHead(
      { repository: "owner/sandbox", headBranch: "agent-team/probe/contract-run-4" },
      registrationProbeMarker("some-other-run"),
    );
    expect(wrongMarker).toEqual(ok(undefined));
  });
});

/* -------------------------------------------------------------------------------------------- *
 * Branch cleanup -- same fake-GhTransport-method convention; models the real 204-empty-body
 * DELETE response by having `requestVoid` resolve `ok(undefined)` regardless of body, exactly as
 * a real `gh api ... --method DELETE` exit code would.
 * -------------------------------------------------------------------------------------------- */

class FakeGhCleanupTransport implements Pick<GhTransport, "requestJson" | "requestVoid"> {
  headSha = "b".repeat(40);
  commitMessage = "";
  deleted = false;
  deleteShouldFail = false;

  requestJson<Output>(arguments_: readonly string[], schema: z.ZodType<Output>) {
    const endpoint = arguments_[1] ?? "";
    let value: unknown;
    if (endpoint.includes("/git/ref/heads/")) {
      if (this.deleted) return Promise.resolve(err(domainError("not_found")));
      value = { object: { sha: this.headSha } };
    } else if (endpoint.includes("/commits/")) {
      value = { commit: { message: this.commitMessage } };
    } else {
      value = {};
    }
    const parsed = schema.safeParse(value);
    return Promise.resolve(
      parsed.success ? ok(parsed.data) : err(domainError("external_failure" as const)),
    );
  }

  requestVoid() {
    if (this.deleteShouldFail)
      return Promise.resolve(err(domainError("external_failure" as const)));
    this.deleted = true;
    return Promise.resolve(ok(undefined));
  }
}

function branchCleanupCommand(
  overrides: Partial<RegistrationProbeBranchCleanupCommand> = {},
): RegistrationProbeBranchCleanupCommand {
  return Object.freeze({
    repository: "owner/sandbox",
    branch: "agent-team/probe/contract-run-5",
    marker: registrationProbeMarker("contract-run-5"),
    expectedHeadSha: "b".repeat(40),
    ...overrides,
  });
}

describe("RegistrationProbeBranchCleanupAdapter", () => {
  it("deletes only after an independent server-side head-SHA and marker read-back match, then confirms via a second read-back", async () => {
    const transport = new FakeGhCleanupTransport();
    const command = branchCleanupCommand();
    transport.commitMessage = `agent-team: ${command.marker}`;
    const adapter = new RegistrationProbeBranchCleanupAdapter(transport);
    const result = await adapter.deleteOwnedBranch(command, mutationOptions);
    expect(result).toEqual(ok({ state: "deleted" }));
  });

  it("refuses to delete when the remote head SHA does not match, even though the caller claims it does", async () => {
    const transport = new FakeGhCleanupTransport();
    transport.headSha = "c".repeat(40);
    transport.commitMessage = `agent-team: ${registrationProbeMarker("contract-run-5")}`;
    const adapter = new RegistrationProbeBranchCleanupAdapter(transport);
    const result = await adapter.deleteOwnedBranch(branchCleanupCommand(), mutationOptions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("refuses to delete when the head commit does not carry the exact run marker", async () => {
    const transport = new FakeGhCleanupTransport();
    transport.commitMessage = "some unrelated commit";
    const adapter = new RegistrationProbeBranchCleanupAdapter(transport);
    const result = await adapter.deleteOwnedBranch(branchCleanupCommand(), mutationOptions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("treats an already-absent branch as idempotently cleaned up", async () => {
    const transport = new FakeGhCleanupTransport();
    transport.deleted = true;
    const adapter = new RegistrationProbeBranchCleanupAdapter(transport);
    const result = await adapter.deleteOwnedBranch(branchCleanupCommand(), mutationOptions);
    expect(result).toEqual(ok({ state: "not_found" }));
  });
});

/* -------------------------------------------------------------------------------------------- *
 * Webhook synthetic probe -- fixture source: W004's own real WebhookRuntimeProbeClient (src/cli/
 * probe/webhook-runtime.ts), driven through fake transport/inbox at the same interface boundary
 * W004's own tests (tests/integration/webhook-runtime-probe.test.ts) use.
 * -------------------------------------------------------------------------------------------- */

describe("RegistrationProbeWebhookAdapter", () => {
  it("maps a verified W004 synthetic delivery into the narrower registration outcome", async () => {
    const secret = Buffer.from("contract-webhook-secret-0123456789");
    const inboxRecords = new Map<
      string,
      { sha256: string; bodyBase64: string; streamKey: string }
    >();
    const transport: WebhookRuntimeTransport = {
      post: (request) => {
        const sha256 = createHash("sha256").update(request.body).digest("hex");
        const deliveryId =
          request.headers["x-github-delivery"] ?? request.headers["linear-delivery"];
        inboxRecords.set(String(deliveryId), {
          sha256,
          bodyBase64: Buffer.from(request.body).toString("base64"),
          streamKey: String(deliveryId),
        });
        return Promise.resolve(
          ok({
            statusCode: 200,
            elapsedMs: 5,
            body: new TextEncoder().encode(
              JSON.stringify({
                accepted: true,
                statusCode: 200,
                provider: "github",
                deliveryId: String(deliveryId),
                eventType: "agent_team_probe",
                inboxSha256: sha256,
              }),
            ),
          }),
        );
      },
    };
    const inbox: WebhookRuntimeProbeInbox = {
      read: (provider, deliveryId) => {
        const record = inboxRecords.get(deliveryId);
        if (record === undefined) return Promise.resolve(err(domainError("not_found")));
        return Promise.resolve(
          ok({
            schemaVersion: 2 as const,
            provider,
            deliveryId,
            eventType: "agent_team_probe",
            streamKey: record.streamKey,
            sourceTimestampMs: Date.parse(now),
            receivedAt: now as never,
            mediaType: "application/json",
            sha256: record.sha256,
            bodyBase64: record.bodyBase64,
          }),
        );
      },
    };
    const adapter = new RegistrationProbeWebhookAdapter({
      transport,
      inbox,
      clock: createFixedClock(now as never),
      createDeliveryId: () => `contract-delivery-${randomUUID()}`,
    });
    const outcome = await adapter.runSyntheticProbe({
      provider: "github",
      baseUrl: "http://127.0.0.1:1/",
      secret,
    });
    expect(outcome.state).toBe("verified");
  });

  it("maps a W004 rejection into the matching failed reason without widening it", async () => {
    const transport: WebhookRuntimeTransport = {
      post: () => Promise.resolve(err(domainError("unavailable"))),
    };
    const inbox: WebhookRuntimeProbeInbox = {
      read: () => Promise.resolve(err(domainError("not_found"))),
    };
    const adapter = new RegistrationProbeWebhookAdapter({
      transport,
      inbox,
      clock: createFixedClock(now as never),
      createDeliveryId: () => "contract-delivery-fail",
    });
    const outcome = await adapter.runSyntheticProbe({
      provider: "linear",
      baseUrl: "http://127.0.0.1:1/",
      secret: Buffer.from("contract-webhook-secret-0123456789"),
    });
    expect(outcome).toEqual({ state: "failed", reason: "transport_failed" });
  });
});

/* -------------------------------------------------------------------------------------------- *
 * Provider-origin events -- fixture source: the exact raw payload shape W004's own
 * `githubWebhookContract`/`linearWebhookContract` (src/adapters/webhook/core.ts) already accepts
 * from a real GitHub/Linear delivery, stored as a real `InboxRecordV2`.
 * -------------------------------------------------------------------------------------------- */

function githubPullRequestRecord(overrides: {
  number: number;
  headSha: string;
  deliveryId?: string;
}) {
  const payload = {
    action: "opened",
    pull_request: { number: overrides.number, head: { sha: overrides.headSha } },
  };
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    schemaVersion: 2 as const,
    provider: "github" as const,
    deliveryId: overrides.deliveryId ?? `gh-delivery-${String(overrides.number)}`,
    eventType: "pull_request",
    streamKey: String(overrides.number),
    sourceTimestampMs: Date.parse(now),
    receivedAt: now as never,
    mediaType: "application/json",
    sha256: createHash("sha256").update(rawBody).digest("hex"),
    bodyBase64: rawBody.toString("base64"),
  };
}

function linearIssueRecord(overrides: { issueId: string; deliveryId?: string }) {
  const payload = { action: "update", type: "Issue", data: { id: overrides.issueId } };
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    schemaVersion: 2 as const,
    provider: "linear" as const,
    deliveryId: overrides.deliveryId ?? `linear-delivery-${overrides.issueId}`,
    eventType: "Issue",
    streamKey: overrides.issueId,
    sourceTimestampMs: Date.parse(now),
    receivedAt: now as never,
    mediaType: "application/json",
    sha256: createHash("sha256").update(rawBody).digest("hex"),
    bodyBase64: rawBody.toString("base64"),
  };
}

describe("RegistrationProbeProviderEventAdapter", () => {
  it("finds a genuine GitHub pull_request delivery by exact number and head SHA", async () => {
    const record = githubPullRequestRecord({ number: 42, headSha: "d".repeat(40) });
    const inbox = { list: () => Promise.resolve(ok(Object.freeze([record]))) };
    const adapter = new RegistrationProbeProviderEventAdapter(inbox);
    const found = await adapter.findProviderEvent({
      provider: "github",
      remoteObjectId: "42",
      headSha: "d".repeat(40),
    });
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value?.deliveryId).toBe(record.deliveryId);
  });

  it("finds a genuine Linear Issue delivery by exact issue ID", async () => {
    const record = linearIssueRecord({ issueId: "issue-99" });
    const inbox = { list: () => Promise.resolve(ok(Object.freeze([record]))) };
    const adapter = new RegistrationProbeProviderEventAdapter(inbox);
    const found = await adapter.findProviderEvent({
      provider: "linear",
      remoteObjectId: "issue-99",
    });
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value?.deliveryId).toBe(record.deliveryId);
  });

  it("never treats a synthetic W004 probe delivery as a provider-origin event", async () => {
    const syntheticPayload = { agentTeamProbe: true, repository: { id: "42" } };
    const rawBody = Buffer.from(JSON.stringify(syntheticPayload), "utf8");
    const syntheticRecord = {
      schemaVersion: 2 as const,
      provider: "github" as const,
      deliveryId: "synthetic-1",
      eventType: "agent_team_probe",
      streamKey: "synthetic-1",
      sourceTimestampMs: Date.parse(now),
      receivedAt: now as never,
      mediaType: "application/json",
      sha256: createHash("sha256").update(rawBody).digest("hex"),
      bodyBase64: rawBody.toString("base64"),
    };
    const inbox = { list: () => Promise.resolve(ok(Object.freeze([syntheticRecord]))) };
    const adapter = new RegistrationProbeProviderEventAdapter(inbox);
    const found = await adapter.findProviderEvent({ provider: "github", remoteObjectId: "42" });
    expect(found).toEqual(ok(undefined));
  });

  it("does not match a different PR number or the wrong provider", async () => {
    const record = githubPullRequestRecord({ number: 42, headSha: "d".repeat(40) });
    const inbox = { list: () => Promise.resolve(ok(Object.freeze([record]))) };
    const adapter = new RegistrationProbeProviderEventAdapter(inbox);
    const wrongNumber = await adapter.findProviderEvent({
      provider: "github",
      remoteObjectId: "43",
    });
    expect(wrongNumber).toEqual(ok(undefined));
    const wrongProvider = await adapter.findProviderEvent({
      provider: "linear",
      remoteObjectId: "42",
    });
    expect(wrongProvider).toEqual(ok(undefined));
  });
});

/* -------------------------------------------------------------------------------------------- *
 * Git -- fixture source: a real local `git` bare repository acting as the "remote", so `git
 * ls-remote`'s real exit codes/stdout drive the assertions rather than a hand-written stub.
 * -------------------------------------------------------------------------------------------- */

describe("RegistrationProbeGitAdapter.inspectRemoteBranch", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function realBareRemote() {
    const root = await mkdtemp(join(tmpdir(), "agent-team-o006-git-contract-"));
    roots.push(root);
    const bareRemote = join(root, "remote.git");
    const workingClone = join(root, "work");
    await execFileAsync("git", ["init", "--bare", "-q", "-b", "main", bareRemote]);
    await execFileAsync("git", ["clone", "-q", bareRemote, workingClone]);
    await execFileAsync("git", ["-C", workingClone, "config", "user.email", "probe@example.test"]);
    await execFileAsync("git", ["-C", workingClone, "config", "user.name", "Probe"]);
    await execFileAsync("git", ["-C", workingClone, "commit", "--allow-empty", "-q", "-m", "seed"]);
    await execFileAsync("git", [
      "-C",
      workingClone,
      "push",
      "-q",
      "origin",
      "HEAD:refs/heads/main",
    ]);
    await execFileAsync("git", [
      "-C",
      workingClone,
      "push",
      "-q",
      "origin",
      "HEAD:refs/heads/agent-team/probe/contract-run-6",
    ]);
    const revParse = await execFileAsync("git", ["-C", workingClone, "rev-parse", "HEAD"]);
    return { bareRemote, workingClone, headSha: revParse.stdout.trim() };
  }

  it("reads the real remote head SHA for an existing branch", async () => {
    const { workingClone, headSha } = await realBareRemote();
    const adapter = new RegistrationProbeGitAdapter();
    // `remote` is the short symbolic name (as `LocalGitAdapter.push` also expects), resolved via
    // the working clone's own `git remote get-url`, not a raw path/URL.
    const result = await adapter.inspectRemoteBranch(
      { rootPath: workingClone },
      "origin",
      "agent-team/probe/contract-run-6",
    );
    expect(result).toEqual(ok({ sha: headSha }));
  });

  it("reports undefined (never an error) for a branch that was never pushed", async () => {
    const { workingClone } = await realBareRemote();
    const adapter = new RegistrationProbeGitAdapter();
    const result = await adapter.inspectRemoteBranch(
      { rootPath: workingClone },
      "origin",
      "agent-team/probe/never-pushed",
    );
    expect(result).toEqual(ok(undefined));
  });

  it("rejects an unsafe remote name before ever invoking git", async () => {
    const adapter = new RegistrationProbeGitAdapter();
    const result = await adapter.inspectRemoteBranch(
      { rootPath: "/tmp/does-not-matter" },
      "--upload-pack=touch /tmp/pwned",
      "agent-team/probe/contract-run-6",
    );
    expect(result.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- *
 * Probe manifest file writer.
 * -------------------------------------------------------------------------------------------- */

describe("RegistrationProbeFileAdapter", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function worktree() {
    const root = await mkdtemp(join(tmpdir(), "agent-team-o006-files-contract-"));
    roots.push(root);
    return {
      repositoryRoot: root,
      path: root,
      branch: "agent-team/probe/contract-run-7",
      headSha: "e".repeat(40),
    };
  }

  function digest(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  it("writes the manifest and reads it back with a matching digest", async () => {
    const tree = await worktree();
    const content = JSON.stringify({ schemaVersion: 1, runId: "contract-run-7" });
    const adapter = new RegistrationProbeFileAdapter();
    const result = await adapter.writeProbeManifest(
      {
        worktree: tree,
        path: ".agent-team/probes/contract-run-7.json",
        content,
        contentDigest: digest(content),
      },
      mutationOptions,
    );
    expect(result).toEqual(
      ok({ path: ".agent-team/probes/contract-run-7.json", contentDigest: digest(content) }),
    );
  });

  it("is idempotent when retried with the exact same content", async () => {
    const tree = await worktree();
    const content = JSON.stringify({ schemaVersion: 1, runId: "contract-run-8" });
    const adapter = new RegistrationProbeFileAdapter();
    const command = Object.freeze({
      worktree: tree,
      path: ".agent-team/probes/contract-run-8.json",
      content,
      contentDigest: digest(content),
    });
    const first = await adapter.writeProbeManifest(command, mutationOptions);
    const second = await adapter.writeProbeManifest(command, mutationOptions);
    expect(first).toEqual(second);
  });

  it("refuses to overwrite existing different content", async () => {
    const tree = await worktree();
    const original = JSON.stringify({ schemaVersion: 1, runId: "contract-run-9" });
    const adapter = new RegistrationProbeFileAdapter();
    await adapter.writeProbeManifest(
      {
        worktree: tree,
        path: ".agent-team/probes/contract-run-9.json",
        content: original,
        contentDigest: digest(original),
      },
      mutationOptions,
    );
    const changed = JSON.stringify({ schemaVersion: 1, runId: "contract-run-9", extra: true });
    const result = await adapter.writeProbeManifest(
      {
        worktree: tree,
        path: ".agent-team/probes/contract-run-9.json",
        content: changed,
        contentDigest: digest(changed),
      },
      mutationOptions,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a path that escapes the worktree", async () => {
    const tree = await worktree();
    const content = "irrelevant";
    const adapter = new RegistrationProbeFileAdapter();
    const result = await adapter.writeProbeManifest(
      { worktree: tree, path: "../../etc/passwd", content, contentDigest: digest(content) },
      mutationOptions,
    );
    expect(result.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- *
 * Durable CAS journal store.
 * -------------------------------------------------------------------------------------------- */

describe("FileRegistrationProbeJournalStore", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function directory() {
    const root = await mkdtemp(join(tmpdir(), "agent-team-o006-journal-contract-"));
    roots.push(root);
    return root;
  }

  function draftRun(runId: string, projectId: string) {
    return Object.freeze({
      schemaVersion: 1 as const,
      phase: "reserved" as const,
      projectId: projectId as never,
      registrationRevision: 1,
      runId,
      branch: `agent-team/probe/${runId}`,
      marker: registrationProbeMarker(runId),
      worktreePath: `/tmp/agent-team-probes/${runId}`,
      activation: Object.freeze({
        setupSessionId: "setup-1",
        authoritativeRevision: "f".repeat(40),
        defaultBranch: "main",
        repository: "owner/sandbox",
        configDigest: "a".repeat(64),
      }),
      cleanup: Object.freeze({
        linearIssue: Object.freeze({ state: "pending" as const, reason: "not_created" as const }),
        draftPullRequest: Object.freeze({
          state: "pending" as const,
          reason: "not_created" as const,
        }),
        remoteBranch: Object.freeze({ state: "pending" as const, reason: "not_created" as const }),
        localWorktree: Object.freeze({ state: "pending" as const, reason: "not_created" as const }),
      }),
    });
  }

  it("reserves a brand-new run and reports undefined for one that was never reserved", async () => {
    const store = new FileRegistrationProbeJournalStore(await directory());
    expect(await store.load("contract-journal-run-1")).toEqual(ok(undefined));
    const reserved = await store.compareAndSwap(
      "contract-journal-run-1",
      null,
      draftRun("contract-journal-run-1", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
    );
    expect(reserved.ok).toBe(true);
    if (reserved.ok) expect(reserved.value.revision).toBe(0);
  });

  it("rejects a stale-revision CAS advance and a second reservation of the same run", async () => {
    const store = new FileRegistrationProbeJournalStore(await directory());
    const draft = draftRun(
      "contract-journal-run-2",
      "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    );
    await store.compareAndSwap("contract-journal-run-2", null, draft);
    const secondReservation = await store.compareAndSwap("contract-journal-run-2", null, draft);
    expect(secondReservation.ok).toBe(false);
    const staleAdvance = await store.compareAndSwap("contract-journal-run-2", 5, {
      ...draft,
      phase: "linear_mutation_started",
    });
    expect(staleAdvance.ok).toBe(false);
  });

  it("lists only active (non-terminal) runs for the given project", async () => {
    const store = new FileRegistrationProbeJournalStore(await directory());
    const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab" as never;
    const otherProjectId = "project_028f47d2-77a4-7cc1-8ef2-0123456789ab" as never;
    const active = await store.compareAndSwap(
      "contract-journal-run-3",
      null,
      draftRun("contract-journal-run-3", projectId),
    );
    if (!active.ok) throw new Error(active.error.code);
    await store.compareAndSwap("contract-journal-run-4", null, {
      ...draftRun("contract-journal-run-4", projectId),
      phase: "verified",
    });
    await store.compareAndSwap(
      "contract-journal-run-5",
      null,
      draftRun("contract-journal-run-5", otherProjectId),
    );

    const listed = await store.listActiveForProject(projectId);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.map((run) => run.runId)).toEqual(["contract-journal-run-3"]);
  });
});
