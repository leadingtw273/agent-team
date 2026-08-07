/**
 * Integration test for the O006 proactive Registration Probe.
 *
 * Zero-live-mutation harness:
 * - Every Linear/GitHub/Webhook credential-shaped env var is cleared before the suite runs.
 * - GitHub is faked at the `GhTransport` method boundary (`FakeGh`); it never shells out to a
 *   real `gh` binary. Git itself IS real -- a temp bare "remote" repository plus a temp working
 *   checkout -- so branch/commit/push semantics are genuine, not reimplemented.
 * - Linear is faked at the `fetch` boundary under the real `LinearGraphqlTransport`/
 *   `LinearReadModel`/`LinearMutationClient` classes (same technique as the contract tests).
 * - The Webhook Runtime is REAL: a real local HTTP server on 127.0.0.1 running the real
 *   `createLocalWebhookIngestHandler` (same code W004's own CLI uses) backed by a real
 *   `DurableInbox` directory. Every outbound webhook request additionally passes through
 *   `LoopbackOnlyTransport`, an independent test-owned guard that throws (failing the test) the
 *   instant a request would target any host other than 127.0.0.1/localhost/[::1] -- this does not
 *   rely on the application's own `allowedRuntimeBaseUrl` allowlist being correct.
 * - `RegistrationProbeProviderEventPort` reads that same real, durable Inbox; "provider-origin"
 *   events are delivered by POSTing genuinely-shaped, signed GitHub/Linear payloads to the real
 *   loopback server -- never synthesized directly into port return values -- so they are
 *   indistinguishable, from the Inbox's point of view, from a real provider delivery.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  FileRegistrationProbeJournalStore,
  RegistrationProbeBranchCleanupAdapter,
  RegistrationProbeFileAdapter,
  RegistrationProbeGitAdapter,
  RegistrationProbeGitHubCapabilityAdapter,
  RegistrationProbeLinearAdapter,
  RegistrationProbeProviderEventAdapter,
  RegistrationProbeWebhookAdapter,
} from "../../src/adapters/registration/index.js";
import { GitHubAdapter, type GhTransport } from "../../src/adapters/github/index.js";
import { createLocalWebhookIngestHandler } from "../../src/cli/ingest/index.js";
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
import type { WebhookRuntimeTransport } from "../../src/cli/probe/index.js";
import { NodeWebhookRuntimeTransport } from "../../src/cli/probe/index.js";
import { createFixedClock, domainError, err, ok } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import { DurableInbox } from "../../src/infrastructure/events/index.js";
import {
  createRegistrationProbeCoordinator,
  type RegistrationProbeAuthority,
  type RegistrationProbePorts,
  type RegistrationProbeStartCommand,
} from "../../src/application/registration/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type {
  RegistrationSetupActivationMarker,
  RegistrationSetupMergedConfigReceipt,
} from "../../src/application/registration/index.js";

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------------------------- *
 * Zero-live-mutation harness: strip every credential-shaped env var before any test runs, so a
 * production credential can never leak into a real call this suite might accidentally make.
 * -------------------------------------------------------------------------------------------- */
const clearedEnvKeys = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "LINEAR_API_KEY",
  "AGENT_TEAM_WEBHOOK_SECRET",
] as const;
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
  for (const key of clearedEnvKeys) {
    savedEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
});
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  savedEnv.clear();
});

/** Independent, test-owned defense: fails loudly rather than dialing any non-loopback host. */
class LoopbackOnlyTransport implements WebhookRuntimeTransport {
  readonly #inner: WebhookRuntimeTransport;
  constructor(inner: WebhookRuntimeTransport = new NodeWebhookRuntimeTransport()) {
    this.#inner = inner;
  }
  post(request: Parameters<WebhookRuntimeTransport["post"]>[0]) {
    const hostname = new URL(request.url).hostname;
    if (!["127.0.0.1", "::1", "[::1]", "localhost"].includes(hostname)) {
      throw new Error(`refused to dial non-loopback host: ${hostname}`);
    }
    return this.#inner.post(request);
  }
}

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function temporaryRoot(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

/* -------------------------------------------------------------------------------------------- *
 * Real temp Git repository: a bare "remote" plus a working checkout with "origin" configured,
 * standing in for the real GitHub-hosted repository without any network access.
 * -------------------------------------------------------------------------------------------- */
async function realGitRepository() {
  const root = await temporaryRoot("agent-team-o006-git-");
  const bareRemote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  await execFileAsync("git", ["init", "--bare", "-q", "-b", "main", bareRemote]);
  await execFileAsync("git", ["clone", "-q", bareRemote, checkout]);
  await execFileAsync("git", ["-C", checkout, "config", "user.email", "probe@example.test"]);
  await execFileAsync("git", ["-C", checkout, "config", "user.name", "Probe"]);
  await writeFile(join(checkout, "README.md"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", checkout, "add", "README.md"]);
  await execFileAsync("git", ["-C", checkout, "commit", "-q", "-m", "seed"]);
  await execFileAsync("git", ["-C", checkout, "push", "-q", "origin", "HEAD:refs/heads/main"]);
  const revParse = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"]);
  return { root, bareRemote, checkout, defaultBranchSha: revParse.stdout.trim() };
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

async function realCommitMessage(bareRemote: string, sha: string): Promise<string> {
  const result = await execFileAsync("git", ["-C", bareRemote, "log", "-1", "--format=%B", sha]);
  return result.stdout;
}

async function deleteRealRef(bareRemote: string, branch: string): Promise<void> {
  await execFileAsync("git", ["-C", bareRemote, "update-ref", "-d", `refs/heads/${branch}`]);
}

/* -------------------------------------------------------------------------------------------- *
 * FakeGh: implements every GhTransport-shaped surface the O006 adapters (and the real
 * GitHubAdapter SourceControlPort) touch. Branch/commit facts are answered by shelling out to the
 * *real* bare git repository above rather than duplicating git's own state; only GitHub-specific
 * concepts (PRs, check-runs, commit statuses, capability flags) are simulated in memory.
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
  admin = true;
  push = true;
  rulesetCount = 1;
  ciConclusion: "success" | "failure" | null = "success";
  statusesBySha = new Map<
    string,
    { context: string; state: string; description: string | null; targetUrl: string | null }[]
  >();
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
        permissions: { admin: this.admin, maintain: this.admin, pull: true, push: this.push },
        rulesets: { available: true, count: this.rulesetCount },
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
      mergeStateStatus: "clean" as const,
      baseSha: "2".repeat(40),
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

    if (/^repos\/[^/]+\/[^/]+$/u.test(endpoint) && method === "GET") {
      value = { defaultBranch: this.defaultBranch };
    } else if (endpoint.endsWith("/actions/workflows")) {
      value = { activeWorkflowCount: 1 };
    } else if (endpoint.endsWith("/actions/runs")) {
      value = {
        runCount: 1,
        latest: {
          headBranch: this.defaultBranch,
          status: "completed",
          conclusion: this.ciConclusion,
        },
      };
    } else if (endpoint.endsWith("/rulesets")) {
      value = { count: this.rulesetCount };
    } else if (endpoint.includes("/branches/") && endpoint.endsWith("/protection")) {
      return err(domainError("not_found"));
    } else if (endpoint.endsWith("/pulls") && method === "GET") {
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
    } else if (endpoint.includes("/check-runs")) {
      const shaMatch = /\/commits\/([0-9a-f]{40})\/check-runs/u.exec(endpoint);
      const page = /[?&]page=([0-9]+)/u.exec(endpoint)?.[1] ?? "1";
      const checks =
        shaMatch !== null && page === "1"
          ? [{ name: "CI", status: "completed" as const, conclusion: this.ciConclusion, url: null }]
          : [];
      value = { totalCount: checks.length, checks };
    } else if (endpoint.includes("/statuses/") && method === "POST") {
      const sha = endpoint.split("/statuses/")[1] ?? "";
      const list = this.statusesBySha.get(sha) ?? [];
      const entry = {
        context: fields["context"] ?? "",
        state: fields["state"] ?? "",
        description: fields["description"] ?? null,
        targetUrl: fields["target_url"] ?? null,
      };
      const existingIndex = list.findIndex((candidate) => candidate.context === entry.context);
      if (existingIndex >= 0) list[existingIndex] = entry;
      else list.push(entry);
      this.statusesBySha.set(sha, list);
      value = { context: entry.context, state: entry.state };
    } else if (/\/commits\/[0-9a-f]{40}\/status$/u.test(endpoint) && method === "GET") {
      const sha = /\/commits\/([0-9a-f]{40})\/status$/u.exec(endpoint)?.[1] ?? "";
      value = { sha, statuses: this.statusesBySha.get(sha) ?? [] };
    } else if (endpoint.includes("/git/ref/heads/")) {
      const branch = decodeURIComponent(endpoint.split("/git/ref/heads/")[1] ?? "");
      const sha = await realRefSha(this.bareRemote, branch);
      if (sha === undefined) return err(domainError("not_found"));
      value = { object: { sha } };
    } else if (/\/commits\/[0-9a-f]{40}$/u.test(endpoint) && method === "GET") {
      const sha = /\/commits\/([0-9a-f]{40})$/u.exec(endpoint)?.[1] ?? "";
      value = { commit: { message: await realCommitMessage(this.bareRemote, sha) } };
    } else {
      value = {};
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? ok(parsed.data) : err(domainError("external_failure"));
  }

  async requestVoid(arguments_: readonly string[]) {
    const endpoint = arguments_[1] ?? "";
    const methodIndex = arguments_.indexOf("--method");
    const method = methodIndex < 0 ? "GET" : (arguments_[methodIndex + 1] ?? "GET");
    if (endpoint.includes("/git/refs/heads/") && method === "DELETE") {
      const branch = decodeURIComponent(endpoint.split("/git/refs/heads/")[1] ?? "");
      await deleteRealRef(this.bareRemote, branch);
      return ok(undefined);
    }
    return err(domainError("external_failure"));
  }
}

/* -------------------------------------------------------------------------------------------- *
 * Linear -- identical fixture technique to the contract tests: real LinearGraphqlTransport/
 * LinearReadModel/LinearMutationClient driven by a fake `fetch`.
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

  async function fakeFetch(_url: string, init: RequestInit): Promise<Response> {
    await Promise.resolve();
    const parsedBody = JSON.parse(init.body as string) as {
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
  }

  const transport = new LinearGraphqlTransport({ apiKey: "test-linear-api-key", fetch: fakeFetch });
  const readModel = new LinearReadModel(transport);
  const mutationClient = new LinearMutationClient(transport, readModel);
  return {
    adapter: new RegistrationProbeLinearAdapter(readModel, mutationClient, transport),
    backlogStateId,
    issues,
  };
}

/* -------------------------------------------------------------------------------------------- *
 * Real loopback Webhook Runtime: a real HTTP server on 127.0.0.1 running the real local ingest
 * handler, backed by a real DurableInbox on disk.
 * -------------------------------------------------------------------------------------------- */
async function realLoopbackRuntime(
  agentTeamHome: string,
  githubSecret: Buffer,
  linearSecret: Buffer,
) {
  await mkdir(join(agentTeamHome, "secrets"), { recursive: true });
  const githubSecretFile = join(agentTeamHome, "secrets", "github-webhook-secret");
  const linearSecretFile = join(agentTeamHome, "secrets", "linear-webhook-secret");
  await writeFile(githubSecretFile, githubSecret, { mode: 0o600 });
  await chmod(githubSecretFile, 0o600);
  await writeFile(linearSecretFile, linearSecret, { mode: 0o600 });
  await chmod(linearSecretFile, 0o600);
  const inboxDirectory = join(agentTeamHome, "state", "inbox");
  const inbox = new DurableInbox(inboxDirectory);

  let sequence = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const rawBody = Buffer.concat(chunks);
      const path = request.url ?? "";
      const provider =
        path === "/webhooks/github" ? "github" : path === "/webhooks/linear" ? "linear" : undefined;
      if (provider === undefined) {
        response.writeHead(404).end();
        return;
      }
      const headers = Object.fromEntries(
        Object.entries(request.headers).filter(
          (entry): entry is [string, string | string[]] => entry[1] !== undefined,
        ),
      );
      const headersFile = join(agentTeamHome, `runtime-headers-${String(sequence)}.json`);
      sequence += 1;
      await writeFile(headersFile, JSON.stringify(headers), { mode: 0o600 });
      await chmod(headersFile, 0o600);
      const ingest = createLocalWebhookIngestHandler({
        agentTeamHome,
        secretFile: provider === "github" ? githubSecretFile : linearSecretFile,
        stdin: (async function* () {
          await Promise.resolve();
          yield rawBody;
        })(),
        inbox,
        clock: createFixedClock(new Date().toISOString() as never),
      });
      const outcome = await ingest({ provider, headersFile });
      await rm(headersFile, { force: true });
      let body = outcome.message ?? "";
      let statusCode = 503;
      try {
        const parsed = JSON.parse(body) as { readonly statusCode?: unknown };
        statusCode = typeof parsed.statusCode === "number" ? parsed.statusCode : statusCode;
      } catch {
        body = JSON.stringify({ accepted: false, statusCode: 500, reason: "local_failure" });
      }
      response.writeHead(outcome.state === "success" ? 200 : statusCode, {
        "content-type": "application/json",
      });
      response.end(body);
    })().catch(() => {
      response.destroy();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing server address");
  return { baseUrl: `http://127.0.0.1:${String(address.port)}`, inbox, inboxDirectory };
}

/** Delivers a genuinely-shaped, correctly-signed provider-origin event to the real loopback server. */
async function deliverProviderEvent(
  baseUrl: string,
  provider: "github" | "linear",
  secret: Buffer,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  const headers =
    provider === "github"
      ? {
          "content-type": "application/json",
          "x-github-delivery": randomUUID(),
          "x-github-event": "pull_request",
          "x-hub-signature-256": `sha256=${digest}`,
        }
      : {
          "content-type": "application/json",
          "linear-delivery": randomUUID(),
          "linear-event": "Issue",
          "linear-signature": digest,
        };
  const url = new URL(`/webhooks/${provider}`, baseUrl);
  await new Promise<void>((resolve, reject) => {
    const clientRequest = httpRequest(
      url,
      { method: "POST", headers: { ...headers, "content-length": body.byteLength.toString() } },
      (response) => {
        response.resume();
        response.on("end", resolve);
      },
    );
    clientRequest.on("error", reject);
    clientRequest.end(body);
  });
}

/* -------------------------------------------------------------------------------------------- *
 * Test project/config/activation fixtures (O005 stand-ins -- out of O006's scope, mirrored from
 * the Phase-1 coordinator unit tests' own fixtures).
 * -------------------------------------------------------------------------------------------- */
const setupSessionId = "setup-integration-018f47d2";
const mergeCommitSha = "c".repeat(40);
const setupHeadSha = "d".repeat(40);
function hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
const configDigest = hex("config");

function buildProject(
  repository: string,
  localRepositoryPath: string,
  teamId: string,
  projectId: string,
) {
  return projectSchema.parse({
    schemaVersion: 1,
    id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    displayName: "Sandbox",
    localRepositoryPath,
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: teamId, projectId },
    sourceControl: { provider: "github", repository },
  });
}

function authorityFor(command: {
  readonly projectId: string;
  readonly setupSessionId: string;
  readonly registrationRevision: number;
}): RegistrationProbeAuthority {
  return Object.freeze({
    schemaVersion: 1,
    source: "user_local_ui",
    projectId: command.projectId as never,
    setupSessionId: command.setupSessionId,
    registrationRevision: command.registrationRevision,
  });
}

describe("O006 proactive Registration Probe (loopback integration)", () => {
  it("runs the full happy path end to end with zero real external network calls, then confirms every artifact is cleaned up", async () => {
    const repository = "owner/sandbox";
    const teamId = "team-018f47d2";
    const linearProjectId = "linear-project-018f47d2";
    const { checkout, bareRemote } = await realGitRepository();
    const project = buildProject(repository, checkout, teamId, linearProjectId);
    const config = trustedProjectConfigSchema.parse({
      schemaVersion: 1,
      projectId: project.id,
      defaultBranch: project.defaultBranch,
      platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
      projectRules: ["Run quality checks."],
      roleInstructions: { implementer: ["Stay in scope."] },
      commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
    });
    const activationMarker: RegistrationSetupActivationMarker = Object.freeze({
      schemaVersion: 1,
      source: "source_control_default_branch",
      setupSessionId,
      projectId: project.id,
      repository: project.sourceControl.repository,
      changeRequestId: "PR_setup_1",
      setupHeadSha,
      mergeCommitSha,
      authoritativeRevision: mergeCommitSha,
      defaultBranch: project.defaultBranch,
      configDigest,
      linearAuditIssueId: "LINEAR-AUDIT-1",
      gateEvidenceDigest: hex("gate") as never,
      auditReceiptsDigest: hex("audit") as never,
      approvalSource: "local_ui",
      approvalReferenceDigest: hex("approval-reference") as never,
      approvalConsumeOperationDigest: hex("consume-operation") as never,
      authorityDigest: hex("authority"),
      approvalNonceDigest: hex("nonce"),
    });
    const mergedConfigReceipt: RegistrationSetupMergedConfigReceipt = Object.freeze({
      schemaVersion: 1,
      source: "source_control_default_branch",
      projectId: project.id,
      repository: project.sourceControl.repository,
      changeRequestId: activationMarker.changeRequestId,
      setupHeadSha,
      mergeCommitSha,
      defaultBranch: project.defaultBranch,
      authoritativeRevision: mergeCommitSha,
      path: ".agent-team/project.json",
      configDigest,
      config,
    });

    const agentTeamHome = await temporaryRoot("agent-team-o006-home-");
    const githubSecret = Buffer.from("integration-github-secret-0123456789");
    const linearSecret = Buffer.from("integration-linear-secret-0123456789");
    const runtime = await realLoopbackRuntime(agentTeamHome, githubSecret, linearSecret);

    const fakeGh = new FakeGh(bareRemote, repository, project.defaultBranch);
    const linear = buildLinearFixture(teamId, linearProjectId);
    const journalDirectory = await temporaryRoot("agent-team-o006-journal-");
    const journal = new FileRegistrationProbeJournalStore(journalDirectory);
    const allowedWorktreeRoot = await temporaryRoot("agent-team-o006-worktrees-");
    const runId = "integration-run-1";
    const worktreePath = join(allowedWorktreeRoot, runId);

    const ports: RegistrationProbePorts = {
      activation: {
        readActivation: (id) =>
          Promise.resolve(ok(id === setupSessionId ? activationMarker : undefined)),
      },
      mergedConfig: {
        read: () => Promise.resolve(ok(mergedConfigReceipt)),
      },
      linear: linear.adapter,
      githubCapability: new RegistrationProbeGitHubCapabilityAdapter(fakeGh),
      sourceControl: new GitHubAdapter(fakeGh),
      git: new RegistrationProbeGitAdapter(),
      files: new RegistrationProbeFileAdapter(),
      webhook: new RegistrationProbeWebhookAdapter({
        transport: new LoopbackOnlyTransport(),
        inbox: runtime.inbox,
        clock: createFixedClock(new Date().toISOString() as never),
        createDeliveryId: () => `integration-delivery-${randomUUID()}`,
      }),
      providerEvents: new RegistrationProbeProviderEventAdapter(runtime.inbox),
      branchCleanup: new RegistrationProbeBranchCleanupAdapter(fakeGh),
      journal,
    };

    let providerEventsSent = false;
    const coordinator = createRegistrationProbeCoordinator({
      ports,
      allowedWorktreeRoot,
      providerEventPoll: {
        maxAttempts: 2,
        intervalMs: 0,
        wait: async () => {
          if (providerEventsSent) return;
          providerEventsSent = true;
          const linearIssue = linear.issues[0];
          const pr = fakeGh.prs[0];
          if (linearIssue === undefined || pr === undefined) return;
          const headSha = await realRefSha(bareRemote, pr.headBranch);
          await deliverProviderEvent(runtime.baseUrl, "github", githubSecret, {
            action: "opened",
            pull_request: { number: pr.number, head: { sha: headSha } },
          });
          await deliverProviderEvent(runtime.baseUrl, "linear", linearSecret, {
            action: "update",
            type: "Issue",
            webhookTimestamp: Date.now(),
            data: { id: linearIssue.id },
          });
        },
      },
    });

    const command: RegistrationProbeStartCommand = Object.freeze({
      project,
      setupSessionId,
      registrationRevision: 1,
      runId,
      worktreePath,
      gitRemote: "origin",
      linearWorkflowStateId: linear.backlogStateId,
      authority: authorityFor({ projectId: project.id, setupSessionId, registrationRevision: 1 }),
      webhookBaseUrls: Object.freeze({ github: runtime.baseUrl, linear: runtime.baseUrl }),
      webhookSecrets: Object.freeze({ github: githubSecret, linear: linearSecret }),
    });

    const outcome = await coordinator.start(command);

    if (outcome.state !== "verified") {
      throw new Error(`expected verified, got ${JSON.stringify(outcome, null, 2)}`);
    }
    expect(outcome.state).toBe("verified");
    expect(outcome.run.linear?.issueId).toBe(linear.issues[0]?.id);
    expect(outcome.run.draftPullRequest?.number).toBe(fakeGh.prs[0]?.number);
    expect(outcome.run.providerEvents?.length).toBe(2);
    expect(outcome.run.syntheticDeliveries?.length).toBe(2);

    // -- Cleanup evidence: every created artifact must actually be gone / terminal. --
    expect(linear.issues[0]?.stateId).toBe(
      mustFind(
        Object.entries(linearWorkStatusNames).map(([status, name], index) => ({
          id: `state-${status}-${String(index)}`,
          name,
        })),
        (state) => state.name === linearWorkStatusNames.canceled,
      ).id,
    );
    expect(fakeGh.prs[0]?.state).toBe("closed");
    const remainingRef = await realRefSha(bareRemote, `agent-team/probe/${runId}`);
    expect(remainingRef).toBeUndefined();
    await expect(stat(worktreePath)).rejects.toThrow();

    // -- No unexpected leftover run state: this run is now terminal (verified). --
    const active = await journal.listActiveForProject(project.id);
    expect(active).toEqual(ok([]));
  }, 30_000);

  it("fails preflight closed (zero mutations) when the webhook Runtime URL is not loopback", async () => {
    const repository = "owner/sandbox";
    const teamId = "team-018f47d2";
    const linearProjectId = "linear-project-018f47d2";
    const { checkout, bareRemote } = await realGitRepository();
    const project = buildProject(repository, checkout, teamId, linearProjectId);
    const config = trustedProjectConfigSchema.parse({
      schemaVersion: 1,
      projectId: project.id,
      defaultBranch: project.defaultBranch,
      platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
      projectRules: ["Run quality checks."],
      roleInstructions: { implementer: ["Stay in scope."] },
      commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
    });
    const activationMarker: RegistrationSetupActivationMarker = Object.freeze({
      schemaVersion: 1,
      source: "source_control_default_branch",
      setupSessionId,
      projectId: project.id,
      repository: project.sourceControl.repository,
      changeRequestId: "PR_setup_1",
      setupHeadSha,
      mergeCommitSha,
      authoritativeRevision: mergeCommitSha,
      defaultBranch: project.defaultBranch,
      configDigest,
      linearAuditIssueId: "LINEAR-AUDIT-1",
      gateEvidenceDigest: hex("gate") as never,
      auditReceiptsDigest: hex("audit") as never,
      approvalSource: "local_ui",
      approvalReferenceDigest: hex("approval-reference") as never,
      approvalConsumeOperationDigest: hex("consume-operation") as never,
      authorityDigest: hex("authority"),
      approvalNonceDigest: hex("nonce"),
    });
    const mergedConfigReceipt: RegistrationSetupMergedConfigReceipt = Object.freeze({
      schemaVersion: 1,
      source: "source_control_default_branch",
      projectId: project.id,
      repository: project.sourceControl.repository,
      changeRequestId: activationMarker.changeRequestId,
      setupHeadSha,
      mergeCommitSha,
      defaultBranch: project.defaultBranch,
      authoritativeRevision: mergeCommitSha,
      path: ".agent-team/project.json",
      configDigest,
      config,
    });

    const fakeGh = new FakeGh(bareRemote, repository, project.defaultBranch);
    const linear = buildLinearFixture(teamId, linearProjectId);
    const journalDirectory = await temporaryRoot("agent-team-o006-journal-neg-");
    const journal = new FileRegistrationProbeJournalStore(journalDirectory);
    const allowedWorktreeRoot = await temporaryRoot("agent-team-o006-worktrees-neg-");
    const runId = "integration-run-2";

    let gitMutationCalls = 0;
    const countedLinear = Object.freeze({
      readCapability: linear.adapter.readCapability.bind(linear.adapter),
      findByMarker: linear.adapter.findByMarker.bind(linear.adapter),
      read: linear.adapter.read.bind(linear.adapter),
      cancel: linear.adapter.cancel.bind(linear.adapter),
      create: (
        command_: Parameters<typeof linear.adapter.create>[0],
        options: Parameters<typeof linear.adapter.create>[1],
      ) => {
        gitMutationCalls += 1;
        return linear.adapter.create(command_, options);
      },
    });

    // A throwing transport proves the test would fail loudly rather than silently succeed if the
    // application's own allowlist ever let a non-loopback URL through to this stage.
    const throwingWebhookTransport: WebhookRuntimeTransport = {
      post: () => {
        throw new Error("must never be called: preflight should reject this URL first");
      },
    };

    const ports: RegistrationProbePorts = {
      activation: {
        readActivation: (id) =>
          Promise.resolve(ok(id === setupSessionId ? activationMarker : undefined)),
      },
      mergedConfig: { read: () => Promise.resolve(ok(mergedConfigReceipt)) },
      linear: countedLinear,
      githubCapability: new RegistrationProbeGitHubCapabilityAdapter(fakeGh),
      sourceControl: new GitHubAdapter(fakeGh),
      git: new RegistrationProbeGitAdapter(),
      files: new RegistrationProbeFileAdapter(),
      webhook: new RegistrationProbeWebhookAdapter({
        transport: throwingWebhookTransport,
        inbox: new DurableInbox(
          join(await temporaryRoot("agent-team-o006-inbox-unused-"), "inbox"),
        ),
        clock: createFixedClock(new Date().toISOString() as never),
        createDeliveryId: () => "unused-delivery-id",
      }),
      providerEvents: new RegistrationProbeProviderEventAdapter(
        new DurableInbox(join(await temporaryRoot("agent-team-o006-inbox-unused2-"), "inbox")),
      ),
      branchCleanup: new RegistrationProbeBranchCleanupAdapter(fakeGh),
      journal,
    };

    const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
    const command: RegistrationProbeStartCommand = Object.freeze({
      project,
      setupSessionId,
      registrationRevision: 1,
      runId,
      worktreePath: join(allowedWorktreeRoot, runId),
      gitRemote: "origin",
      linearWorkflowStateId: linear.backlogStateId,
      authority: authorityFor({ projectId: project.id, setupSessionId, registrationRevision: 1 }),
      // A non-loopback plain-HTTP URL: rejected by the application's own preflight allowlist
      // before any port -- including Linear/GitHub -- is ever mutated.
      webhookBaseUrls: Object.freeze({
        github: "http://public.example.test/",
        linear: "http://public.example.test/",
      }),
      webhookSecrets: Object.freeze({
        github: Buffer.from("unused-secret-0123456789"),
        linear: Buffer.from("unused-secret-0123456789"),
      }),
    });

    const outcome = await coordinator.start(command);
    expect(outcome).toEqual({ state: "incomplete", reason: "runtime_configuration_invalid" });
    expect(gitMutationCalls).toBe(0);
    expect(linear.issues.length).toBe(0);
    expect(fakeGh.prs.length).toBe(0);
    const branchRef = await realRefSha(bareRemote, `agent-team/probe/${runId}`);
    expect(branchRef).toBeUndefined();
  });

  it("never dials a non-loopback host even when a URL would structurally satisfy the app's own https allowlist", () => {
    const transport = new LoopbackOnlyTransport();
    expect(() =>
      transport.post({
        url: "https://public.example.test/webhooks/github",
        headers: {},
        body: new Uint8Array(),
        timeoutMs: 1_000,
      }),
    ).toThrow(/refused to dial non-loopback host/u);
  });
});
