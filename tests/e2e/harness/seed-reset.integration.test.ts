/**
 * E006 integration test: `buildProductionSeedResetPorts` (seed-reset-adapters.ts) wired to the
 * real O006-era adapters, exercised through a real temporary `E2eCaseManifestStore` -- proving
 * the actual seed->reset lifecycle end to end without touching any real sandbox.
 *
 * Zero-live-mutation harness (same techniques as tests/integration/registration-proactive-
 * probe.test.ts, reused here since E006 delegates to the exact same adapter classes):
 * - GitHub is faked at the `GhTransport` method boundary (`FakeGh`); never shells out to a real
 *   `gh` binary.
 * - Git itself is real: a temp bare "remote" repository plus a temp working checkout, so branch/
 *   commit/push/worktree semantics are genuine.
 * - Linear is faked at the `fetch` boundary under the real `LinearGraphqlTransport`/
 *   `LinearReadModel`/`LinearMutationClient` classes, driven through `buildProductionSeedResetPorts`
 *   exactly as production would (not hand-assembled adapters).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { GhTransport } from "../../../src/adapters/github/index.js";
import {
  linearAgentRoleNames,
  linearAgentStatusNames,
  linearBlockingReasonNames,
  linearReviewRequirementNames,
  linearWorkStatusNames,
  type LinearWorkflowStateRecord,
} from "../../../src/adapters/linear/model.js";
import { createFixedClock, domainError, err, ok } from "../../../src/domain/foundation/index.js";
import { buildProductionSeedResetPorts } from "./seed-reset-adapters.js";
import { E2eCaseManifestStore } from "./seed-reset-manifest.js";
import { resetCase, seedCase, type SeedCaseCommand } from "./seed-reset.js";

const execFileAsync = promisify(execFile);
const clock = createFixedClock("2026-08-06T12:00:00.000Z" as never);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

/* -------------------------------------------------------------------------------------------- *
 * Real temp Git repository -- a bare "remote" plus a working checkout with "origin" configured.
 * Same technique as tests/integration/registration-proactive-probe.test.ts.
 * -------------------------------------------------------------------------------------------- */
async function realGitRepository() {
  const root = await temporaryRoot("agent-team-e006-git-");
  const bareRemote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  await execFileAsync("git", ["init", "--bare", "-q", "-b", "main", bareRemote]);
  await execFileAsync("git", ["clone", "-q", bareRemote, checkout]);
  await execFileAsync("git", ["-C", checkout, "config", "user.email", "e2e-harness@example.test"]);
  await execFileAsync("git", ["-C", checkout, "config", "user.name", "E2E Harness"]);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(checkout, "README.md"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", checkout, "add", "README.md"]);
  await execFileAsync("git", ["-C", checkout, "commit", "-q", "-m", "seed"]);
  await execFileAsync("git", ["-C", checkout, "push", "-q", "origin", "HEAD:refs/heads/main"]);
  return { root, bareRemote, checkout };
}

async function realRefSha(bareRemote: string, branch: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", [
      "-C",
      bareRemote,
      "show-ref",
      "--verify",
      "--hash",
      `refs/heads/${branch}`,
    ]);
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------------------------- *
 * FakeGh -- implements every GhTransport-shaped surface `GitHubAdapter`/
 * `RegistrationProbeGitHubCapabilityAdapter` touch for this test's PR create/find/close flow.
 * Same fixture technique as tests/integration/registration-proactive-probe.test.ts's FakeGh,
 * trimmed to only the endpoints E006's seed/reset actually exercises.
 * -------------------------------------------------------------------------------------------- */
interface FakePullRequest {
  id: string;
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}

function collectFields(args: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-f" || args[index] === "-F") {
      const pair = args[index + 1] ?? "";
      const separator = pair.indexOf("=");
      if (separator > 0) fields[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }
  return fields;
}

class FakeGh implements Pick<
  GhTransport,
  "inspectAuthentication" | "inspectRepositoryCapabilities" | "requestJson" | "requestVoid"
> {
  readonly prs: FakePullRequest[] = [];
  #nextPrNumber = 100;

  constructor(
    readonly bareRemote: string,
    readonly repository: string,
    readonly defaultBranch: string,
  ) {}

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
        defaultBranch: this.defaultBranch,
        allowAutoMerge: false,
        deleteBranchOnMerge: true,
        permissions: { admin: true, maintain: true, pull: true, push: true },
        rulesets: { available: true, count: 1 },
        branchProtection: { available: false, failure: "not_found_or_not_configured" as const },
        requiredMergeGate: "unverified" as const,
      }),
    );
  }

  #snapshot(pr: FakePullRequest, headSha: string) {
    return {
      id: pr.id,
      number: pr.number,
      url: `https://github.test/${this.repository}/pull/${String(pr.number)}`,
      state: pr.state,
      draft: pr.draft,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha,
      mergeability: "mergeable" as const,
      autoMergeEnabled: false,
      updatedAt: new Date().toISOString(),
    };
  }

  async requestJson<Output>(arguments_: readonly string[], schema: z.ZodType<Output>) {
    const endpoint = arguments_[1] ?? "";
    const methodIndex = arguments_.indexOf("--method");
    const method = methodIndex < 0 ? "GET" : (arguments_[methodIndex + 1] ?? "GET");
    const jqIndex = arguments_.indexOf("--jq");
    const jq = jqIndex < 0 ? "" : (arguments_[jqIndex + 1] ?? "");
    const fields = collectFields(arguments_);
    let value: unknown;

    if (endpoint.endsWith("/pulls") && method === "GET") {
      const headBranch = fields["head"]?.split(":")[1];
      const matches = this.prs.filter(
        (pr) =>
          (fields["state"] === undefined || pr.state === fields["state"]) &&
          (headBranch === undefined || pr.headBranch === headBranch),
      );
      const withSha = await Promise.all(
        matches.map(async (pr) => ({
          pr,
          sha: (await realRefSha(this.bareRemote, pr.headBranch)) ?? "0".repeat(40),
        })),
      );
      value = jq.includes("snapshot")
        ? withSha.map(({ pr, sha }) => ({
            title: pr.title,
            body: pr.body,
            snapshot: this.#snapshot(pr, sha),
          }))
        : withSha.map(({ pr, sha }) => ({
            number: pr.number,
            id: pr.id,
            state: pr.state,
            draft: pr.draft,
            headRefName: pr.headBranch,
            headRefOid: sha,
            body: pr.body,
          }));
    } else if (endpoint.endsWith("/pulls") && method === "POST") {
      const number = this.#nextPrNumber;
      this.#nextPrNumber += 1;
      const pr: FakePullRequest = {
        id: `PR_db_${String(number)}`,
        number,
        state: "open",
        draft: fields["draft"] === "true",
        baseBranch: fields["base"] ?? this.defaultBranch,
        headBranch: fields["head"] ?? "",
        title: fields["title"] ?? "",
        body: fields["body"] ?? "",
      };
      this.prs.push(pr);
      const sha = (await realRefSha(this.bareRemote, pr.headBranch)) ?? "0".repeat(40);
      value = this.#snapshot(pr, sha);
    } else if (/\/pulls\/[1-9][0-9]*$/u.test(endpoint) && method === "GET") {
      const number = Number(endpoint.split("/").pop());
      const pr = this.prs.find((candidate) => candidate.number === number);
      if (pr === undefined) return err(domainError("not_found"));
      const sha = (await realRefSha(this.bareRemote, pr.headBranch)) ?? "0".repeat(40);
      value = this.#snapshot(pr, sha);
    } else if (/\/pulls\/[1-9][0-9]*$/u.test(endpoint) && method === "PATCH") {
      const number = Number(endpoint.split("/").pop());
      const pr = this.prs.find((candidate) => candidate.number === number);
      if (pr === undefined) return err(domainError("not_found"));
      if (fields["state"] === "closed") pr.state = "closed";
      const sha = (await realRefSha(this.bareRemote, pr.headBranch)) ?? "0".repeat(40);
      value = this.#snapshot(pr, sha);
    } else if (endpoint.includes("/git/ref/heads/")) {
      const branch = decodeURIComponent(endpoint.split("/git/ref/heads/")[1] ?? "");
      const sha = await realRefSha(this.bareRemote, branch);
      if (sha === undefined) return err(domainError("not_found"));
      value = { object: { sha } };
    } else {
      value = {};
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? ok(parsed.data) : err(domainError("external_failure"));
  }

  requestVoid() {
    return Promise.resolve(err(domainError("external_failure")));
  }
}

/* -------------------------------------------------------------------------------------------- *
 * Linear -- same fixture technique as tests/integration/registration-proactive-probe.test.ts's
 * buildLinearFixture, returning the raw fake `fetch` so it can be threaded through
 * `buildProductionSeedResetPorts` exactly as production wiring would use a real one.
 * -------------------------------------------------------------------------------------------- */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mustFind<Value>(values: readonly Value[], predicate: (value: Value) => boolean): Value {
  const found = values.find(predicate);
  if (found === undefined) throw new Error("fixture invariant violated: expected value not found");
  return found;
}

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

function buildLinearFixture(teamId: string, projectId: string) {
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
  const groups = {
    agentRole: "label-group-agent-role",
    reviewRequirement: "label-group-review-requirement",
    agentStatus: "label-group-agent-status",
    blockingReason: "label-group-blocking-reason",
  };
  const labels: WireLinearLabel[] = [
    group("Agent 角色", groups.agentRole),
    ...Object.entries(linearAgentRoleNames).map(([key, name], index) =>
      child(name, groups.agentRole, `label-agent-role-${key}-${String(index)}`),
    ),
    group("審查需求", groups.reviewRequirement),
    ...Object.entries(linearReviewRequirementNames).map(([key, name], index) =>
      child(name, groups.reviewRequirement, `label-review-requirement-${key}-${String(index)}`),
    ),
    group("Agent 狀態", groups.agentStatus),
    ...Object.entries(linearAgentStatusNames).map(([key, name], index) =>
      child(name, groups.agentStatus, `label-agent-status-${key}-${String(index)}`),
    ),
    group("阻塞原因", groups.blockingReason),
    ...Object.entries(linearBlockingReasonNames).map(([key, name], index) =>
      child(name, groups.blockingReason, `label-blocking-reason-${key}-${String(index)}`),
    ),
  ];

  const issues: FakeLinearIssue[] = [];
  let issueSequence = 0;

  const fakeFetch: typeof fetch = async (_input, init) => {
    await Promise.resolve();
    const parsedBody = JSON.parse((init?.body as string | undefined) ?? "{}") as {
      readonly operationName: string;
      readonly variables: Readonly<Record<string, unknown>>;
    };
    const { operationName, variables } = parsedBody;
    switch (operationName) {
      case "AgentTeamReadIdentity":
        return jsonResponse({
          data: {
            team:
              variables["teamId"] === teamId ? { id: teamId, name: "Sandbox", key: "SBX" } : null,
            project:
              variables["projectId"] === projectId
                ? { id: projectId, name: "Sandbox Project" }
                : null,
          },
        });
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
          updatedAt: new Date().toISOString(),
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
  };

  return { fetch: fakeFetch, backlogStateId, issues };
}

describe("E006 seed/reset integration (real manifest + real git + fake transports)", () => {
  it("seeds all four kinds through the real production wiring, then resets everything it can", async () => {
    const { bareRemote, checkout } = await realGitRepository();
    const manifestDirectory = await temporaryRoot("agent-team-e006-manifest-");
    const worktreeRoot = await temporaryRoot("agent-team-e006-worktrees-");
    const scratchRoot = await temporaryRoot("agent-team-e006-scratch-");

    const teamId = "team-1";
    const projectId = "linear-project-1";
    const linear = buildLinearFixture(teamId, projectId);
    const gh = new FakeGh(bareRemote, "owner/sandbox", "main");

    const ports = buildProductionSeedResetPorts({
      linearApiKey: "test-linear-api-key",
      linearFetch: linear.fetch,
      githubTransport: gh,
    });
    const manifestStore = new E2eCaseManifestStore(manifestDirectory);

    const caseRunId = "e2e-e101-abc12345";
    const command: SeedCaseCommand = {
      caseId: "E101",
      caseRunId,
      linearIssue: {
        target: { teamId, projectId, workflowStateId: linear.backlogStateId },
        title: "E101 sandbox issue",
      },
      githubBranch: {
        localRepository: { rootPath: checkout },
        worktreeRoot,
        remote: "origin",
        repository: "owner/sandbox",
        baseBranch: "main",
        branchName: "agent-team-e2e/e101",
      },
      githubDraftPullRequest: {
        repository: "owner/sandbox",
        baseBranch: "main",
        headBranch: "agent-team-e2e/e101",
        title: "E101 sandbox PR",
        body: "Seeded by the E006 harness for case E101.",
      },
      localWorktree: {
        localRepository: { rootPath: checkout },
        path: join(scratchRoot, "e101-scratch"),
        branchName: "agent-team-e2e/e101-scratch",
        startPoint: "main",
      },
    };

    const seeded = await seedCase(ports, manifestStore, command, clock);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.entries).toHaveLength(4);

    // The branch genuinely landed on the real remote.
    const branchSha = await realRefSha(bareRemote, "agent-team-e2e/e101");
    expect(branchSha).toBeDefined();
    // The draft PR genuinely exists in the fake GitHub state, referencing that real branch.
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]?.headBranch).toBe("agent-team-e2e/e101");
    // The Linear issue genuinely exists in the fake Linear state, marker-tagged.
    expect(linear.issues).toHaveLength(1);
    expect(linear.issues[0]?.description).toContain(caseRunId);
    // The local scratch worktree genuinely exists on disk.
    const scratchStat = await stat(join(scratchRoot, "e101-scratch"));
    expect(scratchStat.isDirectory()).toBe(true);

    const reset = await resetCase(ports, manifestStore, caseRunId, clock, { dryRun: false });
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    const actions = new Map(reset.value.entries.map((entry) => [entry.kind, entry.action]));
    expect(actions.get("linearIssue")).toBe("confirmed_now");
    expect(actions.get("githubDraftPullRequest")).toBe("confirmed_now");
    expect(actions.get("localWorktree")).toBe("confirmed_now");
    expect(actions.get("githubBranch")).toBe("requires_manual");

    // Real-world verification, independent of the outcome labels above.
    expect(linear.issues[0]?.stateId).toBe(
      mustFind(
        Object.entries(linearWorkStatusNames).map(([status, name], index) => ({
          id: `state-${status}-${String(index)}`,
          name,
        })),
        (state) => state.name === linearWorkStatusNames.canceled,
      ).id,
    );
    expect(gh.prs[0]?.state).toBe("closed");
    await expect(stat(join(scratchRoot, "e101-scratch"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The branch was never deleted -- the disclosed capability gap.
    const branchShaAfterReset = await realRefSha(bareRemote, "agent-team-e2e/e101");
    expect(branchShaAfterReset).toBe(branchSha);

    // Idempotent re-run: everything already confirmed is reported so, with no further effect.
    const secondReset = await resetCase(ports, manifestStore, caseRunId, clock, {
      dryRun: false,
    });
    expect(secondReset.ok).toBe(true);
    if (!secondReset.ok) return;
    const secondActions = new Map(
      secondReset.value.entries.map((entry) => [entry.kind, entry.action]),
    );
    expect(secondActions.get("linearIssue")).toBe("already_confirmed");
    expect(secondActions.get("githubDraftPullRequest")).toBe("already_confirmed");
    expect(secondActions.get("localWorktree")).toBe("already_confirmed");
  }, 30_000);

  it("dry-run mutates nothing on the real backing systems", async () => {
    const { bareRemote, checkout } = await realGitRepository();
    const manifestDirectory = await temporaryRoot("agent-team-e006-manifest-");
    const worktreeRoot = await temporaryRoot("agent-team-e006-worktrees-");

    const teamId = "team-1";
    const projectId = "linear-project-1";
    const linear = buildLinearFixture(teamId, projectId);
    const gh = new FakeGh(bareRemote, "owner/sandbox", "main");
    const ports = buildProductionSeedResetPorts({
      linearApiKey: "test-linear-api-key",
      linearFetch: linear.fetch,
      githubTransport: gh,
    });
    const manifestStore = new E2eCaseManifestStore(manifestDirectory);
    const caseRunId = "e2e-e102-cafef00d";

    await mkdir(worktreeRoot, { recursive: true });
    const seeded = await seedCase(
      ports,
      manifestStore,
      {
        caseId: "E102",
        caseRunId,
        linearIssue: {
          target: { teamId, projectId, workflowStateId: linear.backlogStateId },
          title: "E102 sandbox issue",
        },
        githubBranch: {
          localRepository: { rootPath: checkout },
          worktreeRoot,
          remote: "origin",
          repository: "owner/sandbox",
          baseBranch: "main",
          branchName: "agent-team-e2e/e102",
        },
      },
      clock,
    );
    expect(seeded.ok).toBe(true);

    const dryRun = await resetCase(ports, manifestStore, caseRunId, clock, { dryRun: true });
    expect(dryRun.ok).toBe(true);
    if (!dryRun.ok) return;
    const actions = new Map(dryRun.value.entries.map((entry) => [entry.kind, entry.action]));
    expect(actions.get("linearIssue")).toBe("would_clean");
    expect(actions.get("githubBranch")).toBe("requires_manual");

    // Nothing was actually mutated.
    expect(linear.issues[0]?.stateId).toBe(linear.backlogStateId);
    const reloaded = await manifestStore.load(caseRunId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok && reloaded.value !== undefined) {
      expect(reloaded.value.entries.every((entry) => entry.resolution === undefined)).toBe(true);
    }
  });
});
