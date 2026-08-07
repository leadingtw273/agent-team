/**
 * E005 integration test: `buildProductionEvidenceCollectorPorts` (ports.ts) wired to a *real*
 * local event store (JsonlEventStore/readEventLog), a *real* Inbox (DurableInbox), a *real*
 * checkpoint fixture (LocalYamlCheckpointStore, the existing F008 production writer -- this
 * proves the harness's own checkpoint-reader.ts genuinely round-trips what that writer actually
 * produces, not a hand-crafted stand-in), and *fake* external transports for GitHub/Linear (no
 * network access). This is the harness's own "does the real wiring actually work" proof,
 * complementing collector.test.ts's pure-fake-ports proof of the core "缺任一來源即不得綠" rule.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { LocalYamlCheckpointStore } from "../../../src/adapters/checkpoint/local-yaml.js";
import type { GhTransport } from "../../../src/adapters/github/index.js";
import {
  linearAgentRoleNames,
  linearAgentStatusNames,
  linearBlockingReasonNames,
  linearReviewRequirementNames,
  linearWorkStatusNames,
} from "../../../src/adapters/linear/model.js";
import { checkpointSchema, type Checkpoint } from "../../../src/domain/checkpoint/index.js";
import { domainError, err, ok } from "../../../src/domain/foundation/index.js";
import { issueSchema } from "../../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../../src/domain/review/index.js";
import {
  createAgentTeamUserLayout,
  ensureUserLayout,
} from "../../../src/infrastructure/files/index.js";
import { DurableInbox, JsonlEventStore } from "../../../src/infrastructure/events/index.js";
import { evidenceCaseDescriptionSchema } from "./case.js";
import { collectEvidence } from "./collector.js";
import { buildProductionEvidenceCollectorPorts } from "./ports.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

interface FakePullRequest {
  id: string;
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  headSha: string;
}

/** A minimal, method-boundary GhTransport fake -- same technique as every other GitHub-facing
 * integration test in this repo (see e.g. tests/integration/registration-cli-setup.test.ts). */
function fakeGithubTransport(pullRequest: FakePullRequest) {
  return {
    inspectAuthentication: () =>
      Promise.resolve(ok({ active: true as const, host: "github.com", accountFingerprint: "fp" })),
    inspectRepositoryCapabilities: () => Promise.resolve(err(domainError("unavailable"))),
    requestVoid: () => Promise.resolve(err(domainError("unavailable"))),
    requestJson: <Output>(arguments_: readonly string[], schema: z.ZodType<Output>) => {
      const endpoint = arguments_[1] ?? "";
      let value: unknown;
      if (/\/pulls\/[1-9][0-9]*$/u.test(endpoint)) {
        value = {
          id: pullRequest.id,
          number: pullRequest.number,
          url: `https://github.test/owner/sandbox/pull/${String(pullRequest.number)}`,
          state: pullRequest.state,
          draft: pullRequest.draft,
          baseBranch: pullRequest.baseBranch,
          headBranch: pullRequest.headBranch,
          headSha: pullRequest.headSha,
          mergeability: "mergeable" as const,
          mergeStateStatus: "clean" as const,
          baseSha: "2".repeat(40),
          autoMergeEnabled: false,
          updatedAt: new Date().toISOString(),
        };
      } else if (endpoint.includes("/check-runs")) {
        const page = /[?&]page=([0-9]+)/u.exec(endpoint)?.[1] ?? "1";
        value =
          page === "1"
            ? {
                totalCount: 1,
                checks: [{ name: "CI", status: "completed", conclusion: "success", url: null }],
              }
            : { totalCount: 1, checks: [] };
      } else if (/\/commits\/[0-9a-f]{40}\/status$/u.test(endpoint)) {
        value = {
          sha: pullRequest.headSha,
          statuses: [
            {
              context: "agent-team/review",
              state: "success",
              description: null,
              targetUrl: null,
            },
          ],
        };
      } else {
        value = {};
      }
      const parsed = schema.safeParse(value);
      return Promise.resolve(
        parsed.success ? ok(parsed.data) : err(domainError("external_failure")),
      );
    },
  } satisfies Pick<
    GhTransport,
    "inspectAuthentication" | "inspectRepositoryCapabilities" | "requestJson" | "requestVoid"
  >;
}

/** Full Linear read-catalog fixture: `LinearReadModel.readContext` (buildLinearReadCatalog)
 * fails closed on any incomplete label group/work-status coverage, so this must be complete --
 * same fixture shape used throughout this repo's other Linear-facing integration tests (e.g.
 * tests/integration/registration-cli-setup-refresh.test.ts's own buildLinearAuditFixture). */
function buildLinearFixture(
  teamId: string,
  projectId: string,
  issue: { readonly id: string; readonly title: string; readonly stateName: string },
) {
  const states = Object.entries(linearWorkStatusNames).map(([status, name], index) => ({
    id: `state-${status}-${String(index)}`,
    name,
    type: status,
  }));
  const stateId = states.find((state) => state.name === issue.stateName)?.id ?? states[0]?.id ?? "";

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
  const groupIds = {
    agentRole: "label-group-agent-role",
    reviewRequirement: "label-group-review-requirement",
    agentStatus: "label-group-agent-status",
    blockingReason: "label-group-blocking-reason",
  };
  const labels: WireLinearLabel[] = [
    group("Agent 角色", groupIds.agentRole),
    ...Object.entries(linearAgentRoleNames).map(([key, name], index) =>
      child(name, groupIds.agentRole, `label-agent-role-${key}-${String(index)}`),
    ),
    group("審查需求", groupIds.reviewRequirement),
    ...Object.entries(linearReviewRequirementNames).map(([key, name], index) =>
      child(name, groupIds.reviewRequirement, `label-review-requirement-${key}-${String(index)}`),
    ),
    group("Agent 狀態", groupIds.agentStatus),
    ...Object.entries(linearAgentStatusNames).map(([key, name], index) =>
      child(name, groupIds.agentStatus, `label-agent-status-${key}-${String(index)}`),
    ),
    group("阻塞原因", groupIds.blockingReason),
    ...Object.entries(linearBlockingReasonNames).map(([key, name], index) =>
      child(name, groupIds.blockingReason, `label-blocking-reason-${key}-${String(index)}`),
    ),
  ];

  const comments: { id: string; body: string; createdAt: string }[] = [
    { id: "comment-1", body: "Fresh review passed.", createdAt: "2026-08-06T11:30:00.000Z" },
  ];

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const fetchFake: typeof fetch = async (_url, init = {}) => {
    await Promise.resolve();
    const parsedBody = JSON.parse(init.body as string) as {
      readonly operationName: string;
      readonly variables: Readonly<Record<string, unknown>>;
    };
    const emptyPage = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    switch (parsedBody.operationName) {
      case "AgentTeamReadIdentity":
        return jsonResponse({
          data: {
            team:
              parsedBody.variables["teamId"] === teamId
                ? { id: teamId, name: "Team", key: "T" }
                : null,
            project:
              parsedBody.variables["projectId"] === projectId
                ? { id: projectId, name: "Project" }
                : null,
          },
        });
      case "AgentTeamReadProjectTeams":
        return jsonResponse({
          data: { project: { teams: { nodes: [{ id: teamId }], pageInfo: emptyPage.pageInfo } } },
        });
      case "AgentTeamReadStates":
        return jsonResponse({
          data: { team: { states: { nodes: states, pageInfo: emptyPage.pageInfo } } },
        });
      case "AgentTeamReadLabels":
        return jsonResponse({
          data: { issueLabels: { nodes: labels, pageInfo: emptyPage.pageInfo } },
        });
      case "AgentTeamReadIssue":
        return jsonResponse({
          data:
            parsedBody.variables["issueId"] === issue.id
              ? {
                  issue: {
                    id: issue.id,
                    identifier: "AGT-101",
                    title: issue.title,
                    description: null,
                    priority: 2,
                    updatedAt: "2026-08-06T10:00:00.000Z",
                    team: { id: teamId },
                    project: { id: projectId },
                    state: { id: stateId },
                  },
                }
              : { issue: null },
        });
      case "AgentTeamReadIssueLabels":
        return jsonResponse({ data: { issue: { labels: emptyPage } } });
      case "AgentTeamReadIssueRelations":
        return jsonResponse({ data: { issue: { relations: emptyPage } } });
      case "AgentTeamReadIssueInverseRelations":
        return jsonResponse({ data: { issue: { inverseRelations: emptyPage } } });
      case "AgentTeamReadIssueComments":
        return jsonResponse({
          data: { issue: { comments: { nodes: comments, pageInfo: emptyPage.pageInfo } } },
        });
      default:
        throw new Error(`fixture does not model operation ${parsedBody.operationName}`);
    }
  };
  return fetchFake;
}

function realCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  const issue = issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-0000-4000-8000-000000000032",
    projectId: "project_018f47d2-0000-4000-8000-000000000031",
    externalId: "AGT-101",
    title: "Sample issue",
  });
  const requirementSnapshot = createRequirementSnapshot(issue, "2026-08-06T07:00:00.000Z" as never);
  if (!requirementSnapshot.ok) {
    throw new Error(`fixture: invalid requirement snapshot: ${requirementSnapshot.error.code}`);
  }
  return checkpointSchema.parse({
    schemaVersion: 1,
    id: "checkpoint_018f47d2-0000-4000-8000-000000000030",
    projectId: "project_018f47d2-0000-4000-8000-000000000031",
    issueId: "issue_018f47d2-0000-4000-8000-000000000032",
    jobId: "job_018f47d2-0000-4000-8000-000000000033",
    createdAt: "2026-08-06T08:00:00.000Z",
    reason: "manual",
    completedItems: ["Implemented the change"],
    remainingItems: [],
    tests: [],
    nextSteps: ["Wait for review"],
    blockers: [],
    requirementSnapshot: requirementSnapshot.value,
    model: { provider: "anthropic", model: "claude" },
    worktree: {
      path: "/tmp/e005-worktree",
      branch: "task/agt-101",
      commitSha: "a".repeat(40),
      pushed: true,
    },
    ...overrides,
  });
}

describe("buildProductionEvidenceCollectorPorts + collectEvidence: real local stores, fake external transports", () => {
  it("is green when a real event, a real inbox record, and a real checkpoint all exist inside the time window", async () => {
    const agentTeamHomeRoot = await temporaryRoot("agent-team-e005-integration-home-");
    const agentTeamHome = join(agentTeamHomeRoot, "home");
    const layout = createAgentTeamUserLayout(agentTeamHome);
    const ensured = await ensureUserLayout(layout);
    if (!ensured.ok) throw new Error(`fixture: failed to ensure layout: ${ensured.error.code}`);

    const runId = "run-e101-integration";
    const issueId = "issue_018f47d2-0000-4000-8000-000000000032";
    const teamId = "team-1";
    const linearProjectId = "linear-project-1";

    // Real event, appended through the real JsonlEventStore.
    const events = new JsonlEventStore(join(layout.state.events, `${runId}.jsonl`));
    const appended = await events.append({
      schemaVersion: 1,
      eventId: "event_018f47d2-0000-4000-8000-000000000040",
      eventType: "job.completed",
      occurredAt: "2026-08-06T11:00:00.000Z",
      recordedAt: "2026-08-06T11:00:00.001Z",
      source: { kind: "internal", producer: "e005-integration-test" },
      subject: { kind: "job", id: "job_018f47d2-0000-4000-8000-000000000033" },
      correlationId: runId,
      payload: { ok: true },
    });
    expect(appended.ok).toBe(true);

    // Real inbox record, stored through the real DurableInbox.
    const inbox = new DurableInbox(layout.state.inbox);
    const stored = await inbox.store({
      provider: "github",
      deliveryId: "delivery-e005-1",
      eventType: "pull_request",
      streamKey: "owner/sandbox#42",
      sourceTimestampMs: Date.parse("2026-08-06T09:00:00.000Z"),
      receivedAt: "2026-08-06T09:00:00.000Z" as never,
      mediaType: "application/json",
      rawBody: new TextEncoder().encode(JSON.stringify({ action: "opened" })),
    });
    expect(stored.ok).toBe(true);

    // Real checkpoint, persisted through the real, unmodified F008 production writer.
    const checkpointStore = new LocalYamlCheckpointStore(layout.state.checkpoints);
    const persisted = await checkpointStore.persist(realCheckpoint(), {
      idempotencyKey: "e005-integration-checkpoint",
    });
    expect(persisted.ok).toBe(true);

    const github = fakeGithubTransport({
      id: "PR_kwDOTest00000042",
      number: 42,
      state: "open",
      draft: false,
      baseBranch: "main",
      headBranch: "task/agt-101",
      headSha: "a".repeat(40),
    });
    const linearFetch = buildLinearFixture(teamId, linearProjectId, {
      id: issueId,
      title: "Sample issue",
      stateName: linearWorkStatusNames.in_review,
    });

    const ports = buildProductionEvidenceCollectorPorts({
      agentTeamHome,
      linearApiKey: "unused-fake-key",
      githubTransport: github,
      linearFetch,
    });

    const caseDescription = evidenceCaseDescriptionSchema.parse({
      caseId: "E101",
      runId,
      timeWindow: { from: "2026-08-06T00:00:00.000Z", to: "2026-08-06T23:59:59.999Z" },
      linear: { teamId, projectId: linearProjectId, issueId },
      github: { repository: "owner/sandbox", pullRequestNumber: 42, headSha: "a".repeat(40) },
    });

    const outcome = await collectEvidence(caseDescription, ports);

    expect(outcome.state).toBe("green");
    if (outcome.state === "green") {
      expect(outcome.bundle.linear).toMatchObject({
        status: "present",
        data: { workStatus: "in_review" },
      });
      expect(outcome.bundle.github).toMatchObject({
        status: "present",
        data: { pullRequest: { number: 42, headSha: "a".repeat(40) } },
      });
      expect(outcome.bundle.localEvents.status).toBe("present");
      if (outcome.bundle.localEvents.status === "present") {
        expect(outcome.bundle.localEvents.data.events).toHaveLength(1);
        expect(outcome.bundle.localEvents.data.inboxRecords).toHaveLength(1);
      }
      expect(outcome.bundle.checkpoints.status).toBe("present");
      if (outcome.bundle.checkpoints.status === "present") {
        expect(outcome.bundle.checkpoints.data.checkpoints).toHaveLength(1);
        expect(outcome.bundle.checkpoints.data.checkpoints[0]?.id).toBe(
          "checkpoint_018f47d2-0000-4000-8000-000000000030",
        );
      }
    }
  });

  it("is not_green (localEvents + checkpoints missing) when the time window excludes everything local, while Linear/GitHub stay present", async () => {
    const agentTeamHomeRoot = await temporaryRoot("agent-team-e005-integration-notgreen-");
    const agentTeamHome = join(agentTeamHomeRoot, "home");
    const layout = createAgentTeamUserLayout(agentTeamHome);
    const ensured = await ensureUserLayout(layout);
    if (!ensured.ok) throw new Error(`fixture: failed to ensure layout: ${ensured.error.code}`);

    const runId = "run-e101-notgreen";
    const issueId = "issue_018f47d2-0000-4000-8000-000000000032";
    const teamId = "team-1";
    const linearProjectId = "linear-project-1";

    const events = new JsonlEventStore(join(layout.state.events, `${runId}.jsonl`));
    await events.append({
      schemaVersion: 1,
      eventId: "event_018f47d2-0000-4000-8000-000000000041",
      eventType: "job.completed",
      occurredAt: "2026-08-06T11:00:00.000Z",
      recordedAt: "2026-08-06T11:00:00.001Z",
      source: { kind: "internal", producer: "e005-integration-test" },
      subject: { kind: "job", id: "job_018f47d2-0000-4000-8000-000000000033" },
      correlationId: runId,
      payload: { ok: true },
    });
    const checkpointStore = new LocalYamlCheckpointStore(layout.state.checkpoints);
    await checkpointStore.persist(realCheckpoint(), { idempotencyKey: "e005-notgreen-checkpoint" });

    const github = fakeGithubTransport({
      id: "PR_kwDOTest00000042",
      number: 42,
      state: "open",
      draft: false,
      baseBranch: "main",
      headBranch: "task/agt-101",
      headSha: "a".repeat(40),
    });
    const linearFetch = buildLinearFixture(teamId, linearProjectId, {
      id: issueId,
      title: "Sample issue",
      stateName: linearWorkStatusNames.in_review,
    });
    const ports = buildProductionEvidenceCollectorPorts({
      agentTeamHome,
      linearApiKey: "unused-fake-key",
      githubTransport: github,
      linearFetch,
    });

    // A time window that entirely predates both the real event (11:00) and the real checkpoint
    // (08:00) written above -- Linear/GitHub are date-independent fakes and stay present.
    const caseDescription = evidenceCaseDescriptionSchema.parse({
      caseId: "E101",
      runId,
      timeWindow: { from: "2020-01-01T00:00:00.000Z", to: "2020-01-01T23:59:59.999Z" },
      linear: { teamId, projectId: linearProjectId, issueId },
      github: { repository: "owner/sandbox", pullRequestNumber: 42, headSha: "a".repeat(40) },
    });

    const outcome = await collectEvidence(caseDescription, ports);

    expect(outcome.state).toBe("not_green");
    if (outcome.state === "not_green") {
      expect(new Set(outcome.missingSources)).toEqual(new Set(["localEvents", "checkpoints"]));
      expect(outcome.bundle.linear.status).toBe("present");
      expect(outcome.bundle.github.status).toBe("present");
      expect(outcome.bundle.localEvents).toMatchObject({
        status: "missing",
        reason: "empty_result",
      });
      expect(outcome.bundle.checkpoints).toMatchObject({
        status: "missing",
        reason: "empty_result",
      });
    }
  });
});
