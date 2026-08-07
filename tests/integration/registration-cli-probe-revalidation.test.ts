/**
 * O009 F-1 regression test (fresh-context acceptance review, 2026-08-06): `registration probe
 * run` must never silently replay a cached `verified` journal entry as if it were a genuine
 * revalidation. The bug was entirely in this CLI's own runId derivation
 * (`deterministicRegistrationProbeRunId`, now removed): a runId computed purely from
 * projectId+revision meant every invocation for the same project reused the exact same runId
 * forever, and the O006 coordinator's own terminal-phase short-circuit
 * (`proactive-probe.ts`'s `start()`: `if (... isTerminalCleanPhase(existing.value.phase)) return
 * finalize(existing.value);`) then returned the *first* run's cached `verified` outcome on every
 * later call while touching only `journal.load` -- zero Linear/GitHub/git/webhook calls.
 *
 * This test drives the *real* O006 coordinator (createRegistrationProbeCoordinator) against a
 * *real* file-based journal (FileRegistrationProbeJournalStore) exactly like
 * tests/integration/registration-proactive-probe.test.ts already does for a single run -- the
 * fixture below (real git, FakeGh, real Linear-fixture-over-fake-fetch, real loopback webhook
 * runtime) is adapted from that same, already-proven-correct O006 test. What is new here is
 * calling `resolveRegistrationProbeRunId` (the CLI's own F-1 fix, src/cli/registration/
 * authority.ts) between two separate `coordinator.start()` calls against that one real journal,
 * and counting every fake port's mutation calls to prove the *second* run genuinely re-executes
 * every step rather than replaying the first run's cached result.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
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
import { resolveRegistrationProbeRunId } from "../../src/cli/registration/authority.js";

const execFileAsync = promisify(execFile);

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

async function realGitRepository() {
  const root = await temporaryRoot("agent-team-f1-git-");
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

async function realCommitMessage(bareRemote: string, sha: string): Promise<string> {
  const result = await execFileAsync("git", ["-C", bareRemote, "log", "-1", "--format=%B", sha]);
  return result.stdout;
}

async function deleteRealRef(bareRemote: string, branch: string): Promise<void> {
  await execFileAsync("git", ["-C", bareRemote, "update-ref", "-d", `refs/heads/${branch}`]);
}

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

/** Adapted from tests/integration/registration-proactive-probe.test.ts's own FakeGh. */
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

const setupSessionId = "setup-integration-f1-018f47d2";
const mergeCommitSha = "c".repeat(40);
const setupHeadSha = "d".repeat(40);
function hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
const configDigest = hex("config-f1");

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
    source: "user_conversation",
    projectId: command.projectId as never,
    setupSessionId: command.setupSessionId,
    registrationRevision: command.registrationRevision,
  });
}

describe("O009 F-1 regression: probe run must not replay a cached verified result", () => {
  it("mints a brand-new runId and genuinely re-invokes every port on a second run after the first verified", async () => {
    const repository = "owner/sandbox";
    const teamId = "team-f1";
    const linearProjectId = "linear-project-f1";
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
      gateEvidenceDigest: hex("gate-f1") as never,
      auditReceiptsDigest: hex("audit-f1") as never,
      approvalSource: "local_ui",
      approvalReferenceDigest: hex("approval-reference-f1") as never,
      approvalConsumeOperationDigest: hex("consume-operation-f1") as never,
      authorityDigest: hex("authority-f1"),
      approvalNonceDigest: hex("nonce-f1"),
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

    const agentTeamHome = await temporaryRoot("agent-team-f1-home-");
    const githubSecret = Buffer.from("f1-github-secret-0123456789");
    const linearSecret = Buffer.from("f1-linear-secret-0123456789");
    const runtime = await realLoopbackRuntime(agentTeamHome, githubSecret, linearSecret);

    const fakeGh = new FakeGh(bareRemote, repository, project.defaultBranch);
    const linear = buildLinearFixture(teamId, linearProjectId);
    const journalDirectory = await temporaryRoot("agent-team-f1-journal-");
    const journal = new FileRegistrationProbeJournalStore(journalDirectory);
    const allowedWorktreeRoot = await temporaryRoot("agent-team-f1-worktrees-");

    // Call counters wrap the fakes to prove, on the *second* run, that ports genuinely get
    // re-invoked rather than only `journal.load` being touched (the exact failure mode of F-1).
    const linearCreateCalls: unknown[] = [];
    const gitPushCalls: unknown[] = [];
    const countedLinear = Object.freeze({
      readCapability: linear.adapter.readCapability.bind(linear.adapter),
      findByMarker: linear.adapter.findByMarker.bind(linear.adapter),
      read: linear.adapter.read.bind(linear.adapter),
      cancel: linear.adapter.cancel.bind(linear.adapter),
      create: (
        command_: Parameters<typeof linear.adapter.create>[0],
        options: Parameters<typeof linear.adapter.create>[1],
      ) => {
        linearCreateCalls.push(command_);
        return linear.adapter.create(command_, options);
      },
    });
    const realGitAdapter = new RegistrationProbeGitAdapter();
    const countedGit: RegistrationProbePorts["git"] = Object.freeze({
      createWorktree: (
        command_: Parameters<RegistrationProbePorts["git"]["createWorktree"]>[0],
        options: Parameters<RegistrationProbePorts["git"]["createWorktree"]>[1],
      ) => {
        gitPushCalls.push(command_);
        return realGitAdapter.createWorktree(command_, options);
      },
      stagePaths: realGitAdapter.stagePaths.bind(realGitAdapter),
      commit: realGitAdapter.commit.bind(realGitAdapter),
      inspectWorkingTree: realGitAdapter.inspectWorkingTree.bind(realGitAdapter),
      push: realGitAdapter.push.bind(realGitAdapter),
      removeWorktree: realGitAdapter.removeWorktree.bind(realGitAdapter),
      inspectRepository: realGitAdapter.inspectRepository.bind(realGitAdapter),
      inspectRemoteBranch: realGitAdapter.inspectRemoteBranch.bind(realGitAdapter),
    });

    const ports: RegistrationProbePorts = {
      activation: {
        readActivation: (id) =>
          Promise.resolve(ok(id === setupSessionId ? activationMarker : undefined)),
      },
      mergedConfig: { read: () => Promise.resolve(ok(mergedConfigReceipt)) },
      linear: countedLinear,
      githubCapability: new RegistrationProbeGitHubCapabilityAdapter(fakeGh),
      sourceControl: new GitHubAdapter(fakeGh),
      git: countedGit,
      files: new RegistrationProbeFileAdapter(),
      webhook: new RegistrationProbeWebhookAdapter({
        transport: new NodeWebhookRuntimeTransport(),
        inbox: runtime.inbox,
        clock: createFixedClock(new Date().toISOString() as never),
        createDeliveryId: () => `f1-delivery-${randomUUID()}`,
      }),
      providerEvents: new RegistrationProbeProviderEventAdapter(runtime.inbox),
      branchCleanup: new RegistrationProbeBranchCleanupAdapter(fakeGh),
      journal,
    };

    async function runOnceToVerified(runId: string) {
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
            const linearIssue = linear.issues.at(-1);
            const pr = fakeGh.prs.at(-1);
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
        worktreePath: join(allowedWorktreeRoot, runId),
        gitRemote: "origin",
        linearWorkflowStateId: linear.backlogStateId,
        authority: authorityFor({ projectId: project.id, setupSessionId, registrationRevision: 1 }),
        webhookBaseUrls: Object.freeze({ github: runtime.baseUrl, linear: runtime.baseUrl }),
        webhookSecrets: Object.freeze({ github: githubSecret, linear: linearSecret }),
      });
      return coordinator.start(command);
    }

    // --- Run 1: resolve a runId (no active run yet -> fresh), and complete it to verified. ---
    const firstResolved = await resolveRegistrationProbeRunId(journal, project.id);
    if (!firstResolved.ok) throw new Error(firstResolved.error.code);
    expect(firstResolved.value.resumed).toBe(false);
    const firstRunId = firstResolved.value.runId;

    const firstOutcome = await runOnceToVerified(firstRunId);
    if (firstOutcome.state !== "verified") {
      throw new Error(`expected first run verified, got ${JSON.stringify(firstOutcome, null, 2)}`);
    }
    expect(firstOutcome.run.runId).toBe(firstRunId);
    expect(linearCreateCalls).toHaveLength(1);
    expect(gitPushCalls).toHaveLength(1);

    // --- Run 2: the only journal entry for this project is now terminal (`verified`), so the
    // fix must mint a genuinely *different* runId -- never reuse or replay the first one. ---
    const secondResolved = await resolveRegistrationProbeRunId(journal, project.id);
    if (!secondResolved.ok) throw new Error(secondResolved.error.code);
    expect(secondResolved.value.resumed).toBe(false);
    const secondRunId = secondResolved.value.runId;
    expect(secondRunId).not.toBe(firstRunId);

    linear.issues.length = 0; // second run must create its own fresh Linear issue, not reuse
    const secondOutcome = await runOnceToVerified(secondRunId);
    if (secondOutcome.state !== "verified") {
      throw new Error(
        `expected second run verified, got ${JSON.stringify(secondOutcome, null, 2)}`,
      );
    }
    expect(secondOutcome.run.runId).toBe(secondRunId);
    // This is the crux of F-1: before the fix, the second call would touch only `journal.load`
    // and return the first run's cached outcome without ever calling these ports again.
    expect(linearCreateCalls).toHaveLength(2);
    expect(gitPushCalls).toHaveLength(2);
    expect(fakeGh.prs).toHaveLength(2);
  }, 30_000);

  it("resumes the exact same runId when this project already has a non-terminal (failed, pending cleanup) run", async () => {
    const repository = "owner/sandbox";
    const teamId = "team-f1-resume";
    const linearProjectId = "linear-project-f1-resume";
    const { checkout, bareRemote } = await realGitRepository();
    const project = buildProject(repository, checkout, teamId, linearProjectId);
    const journalDirectory = await temporaryRoot("agent-team-f1-resume-journal-");
    const journal = new FileRegistrationProbeJournalStore(journalDirectory);
    const allowedWorktreeRoot = await temporaryRoot("agent-team-f1-resume-worktrees-");

    const activationMarker: RegistrationSetupActivationMarker = Object.freeze({
      schemaVersion: 1,
      source: "source_control_default_branch",
      setupSessionId: `${setupSessionId}-resume`,
      projectId: project.id,
      repository: project.sourceControl.repository,
      changeRequestId: "PR_setup_resume_1",
      setupHeadSha,
      mergeCommitSha,
      authoritativeRevision: mergeCommitSha,
      defaultBranch: project.defaultBranch,
      configDigest: hex("config-f1-resume"),
      linearAuditIssueId: "LINEAR-AUDIT-RESUME-1",
      gateEvidenceDigest: hex("gate-f1-resume") as never,
      auditReceiptsDigest: hex("audit-f1-resume") as never,
      approvalSource: "local_ui",
      approvalReferenceDigest: hex("approval-reference-f1-resume") as never,
      approvalConsumeOperationDigest: hex("consume-operation-f1-resume") as never,
      authorityDigest: hex("authority-f1-resume"),
      approvalNonceDigest: hex("nonce-f1-resume"),
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
      configDigest: activationMarker.configDigest,
      config: trustedProjectConfigSchema.parse({
        schemaVersion: 1,
        projectId: project.id,
        defaultBranch: project.defaultBranch,
        platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
        projectRules: ["Run quality checks."],
        roleInstructions: { implementer: ["Stay in scope."] },
        commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
      }),
    });

    const fakeGh = new FakeGh(bareRemote, repository, project.defaultBranch);
    // Linear read/write is made to fail deterministically so the very first step
    // (ensureLinearIssue) fails, leaving the run in a non-terminal "failed" phase with its Linear
    // cleanup item still "pending" (nothing was ever created, so there is nothing to clean up) --
    // isTerminalCleanPhase excludes "failed", so listActiveForProject must still report it active.
    const failingLinear: RegistrationProbePorts["linear"] = {
      readCapability: () => Promise.resolve(ok({ readWrite: true, cancelable: true })),
      findByMarker: () => Promise.resolve(ok(undefined)),
      read: () => Promise.resolve(err(domainError("unavailable"))),
      cancel: () => Promise.resolve(err(domainError("unavailable"))),
      create: () => Promise.resolve(err(domainError("unavailable"))),
    };

    const ports: RegistrationProbePorts = {
      activation: {
        readActivation: (id) =>
          Promise.resolve(
            ok(id === activationMarker.setupSessionId ? activationMarker : undefined),
          ),
      },
      mergedConfig: { read: () => Promise.resolve(ok(mergedConfigReceipt)) },
      linear: failingLinear,
      githubCapability: new RegistrationProbeGitHubCapabilityAdapter(fakeGh),
      sourceControl: new GitHubAdapter(fakeGh),
      git: new RegistrationProbeGitAdapter(),
      files: new RegistrationProbeFileAdapter(),
      webhook: new RegistrationProbeWebhookAdapter({
        transport: {
          post: () => {
            throw new Error("must never be called: this run fails before the webhook step");
          },
        },
        inbox: new DurableInbox(join(await temporaryRoot("agent-team-f1-resume-inbox-"), "inbox")),
        clock: createFixedClock(new Date().toISOString() as never),
        createDeliveryId: () => "unused-delivery-id",
      }),
      providerEvents: new RegistrationProbeProviderEventAdapter(
        new DurableInbox(join(await temporaryRoot("agent-team-f1-resume-inbox2-"), "inbox")),
      ),
      branchCleanup: new RegistrationProbeBranchCleanupAdapter(fakeGh),
      journal,
    };
    const coordinator = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });

    const firstResolved = await resolveRegistrationProbeRunId(journal, project.id);
    if (!firstResolved.ok) throw new Error(firstResolved.error.code);
    expect(firstResolved.value.resumed).toBe(false);
    const runId = firstResolved.value.runId;
    const command: RegistrationProbeStartCommand = Object.freeze({
      project,
      setupSessionId: activationMarker.setupSessionId,
      registrationRevision: 1,
      runId,
      worktreePath: join(allowedWorktreeRoot, runId),
      gitRemote: "origin",
      linearWorkflowStateId: "state-backlog-resume",
      authority: authorityFor({
        projectId: project.id,
        setupSessionId: activationMarker.setupSessionId,
        registrationRevision: 1,
      }),
      webhookBaseUrls: Object.freeze({
        github: "https://runtime.example.test",
        linear: "https://runtime.example.test",
      }),
      webhookSecrets: Object.freeze({
        github: Buffer.from("unused-secret-0123456789"),
        linear: Buffer.from("unused-secret-0123456789"),
      }),
    });

    const firstOutcome = await coordinator.start(command);
    // Either "failed" or "cleanup_required" -- both are non-terminal per isTerminalCleanPhase
    // (only "verified"/"incomplete" are terminal); either proves the scenario this test needs.
    expect(["failed", "cleanup_required"]).toContain(firstOutcome.state);

    // The non-terminal run must still be reported active by the journal, and the F-1 fix must
    // resume its *exact* runId rather than minting a new one.
    const secondResolved = await resolveRegistrationProbeRunId(journal, project.id);
    if (!secondResolved.ok) throw new Error(secondResolved.error.code);
    expect(secondResolved.value).toEqual({ runId, resumed: true });
  }, 30_000);
});

/**
 * O009e regression test: the exact real-world deadlock this task fixes (journal evidence:
 * ~/.agent-team/state/registration-probe/journal/probe-0f7ae61f75df480f89ac7827d1bea156.json).
 * Linear issue creation succeeds, then `branch_push` fails for real (this test uses a remote name
 * that does not exist, so the real `RegistrationProbeGitAdapter`'s push genuinely fails) --
 * exactly the shape of the real incident: `linearIssue` ends up confirmed, but `draftPullRequest`/
 * `remoteBranch`/`localWorktree` never get journal evidence for this run. Before this fix, that
 * left the run stuck forever at `cleanup_required` (remoteBranch patched straight to `failed`/
 * `cleanup_failed` at the moment of failure, draftPullRequest/localWorktree stuck at `pending`
 * since their own cleanup steps were gated on evidence this run would never produce) --
 * `resolveRegistrationProbeRunId` would keep resuming the same doomed runId forever, and the
 * project could never get a fresh probe again.
 */
describe("O009e regression: a run whose draft PR/branch/worktree were never created still converges to a genuine terminal state", () => {
  it("converges to terminal failed via authoritative absence readbacks, and the next probe run gets a genuinely fresh runId that actually re-probes", async () => {
    const repository = "owner/sandbox";
    const teamId = "team-o009e";
    const linearProjectId = "linear-project-o009e";
    const { checkout, bareRemote } = await realGitRepository();
    const project = buildProject(repository, checkout, teamId, linearProjectId);
    const activationMarker: RegistrationSetupActivationMarker = Object.freeze({
      schemaVersion: 1,
      source: "source_control_default_branch",
      setupSessionId: `${setupSessionId}-o009e`,
      projectId: project.id,
      repository: project.sourceControl.repository,
      changeRequestId: "PR_setup_o009e_1",
      setupHeadSha,
      mergeCommitSha,
      authoritativeRevision: mergeCommitSha,
      defaultBranch: project.defaultBranch,
      configDigest: hex("config-o009e"),
      linearAuditIssueId: "LINEAR-AUDIT-O009E-1",
      gateEvidenceDigest: hex("gate-o009e") as never,
      auditReceiptsDigest: hex("audit-o009e") as never,
      approvalSource: "local_ui",
      approvalReferenceDigest: hex("approval-reference-o009e") as never,
      approvalConsumeOperationDigest: hex("consume-operation-o009e") as never,
      authorityDigest: hex("authority-o009e"),
      approvalNonceDigest: hex("nonce-o009e"),
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
      configDigest: activationMarker.configDigest,
      config: trustedProjectConfigSchema.parse({
        schemaVersion: 1,
        projectId: project.id,
        defaultBranch: project.defaultBranch,
        platforms: { workManagement: project.workManagement, sourceControl: project.sourceControl },
        projectRules: ["Run quality checks."],
        roleInstructions: { implementer: ["Stay in scope."] },
        commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
      }),
    });

    // O009e: rejects every push with a `pre-receive` hook, reproducing "branch_push fails for a
    // reason unrelated to the remote's own validity" (the real incident's root cause was a
    // createWorktree conflict; this test achieves the same *shape* -- push genuinely never lands
    // -- through a mechanism that keeps `origin` itself perfectly valid for reads, so
    // `inspectRemoteBranch`'s later absence check reports a clean, authoritative "not found" for
    // the probe branch specifically, not a read error for the whole remote).
    await writeFile(join(bareRemote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    await chmod(join(bareRemote, "hooks", "pre-receive"), 0o755);

    const fakeGh = new FakeGh(bareRemote, repository, project.defaultBranch);
    const linear = buildLinearFixture(teamId, linearProjectId);
    const journalDirectory = await temporaryRoot("agent-team-o009e-journal-");
    const journal = new FileRegistrationProbeJournalStore(journalDirectory);
    const allowedWorktreeRoot = await temporaryRoot("agent-team-o009e-worktrees-");
    const agentTeamHome = await temporaryRoot("agent-team-o009e-home-");
    const githubSecret = Buffer.from("o009e-github-secret-0123456789");
    const linearSecret = Buffer.from("o009e-linear-secret-0123456789");
    const runtime = await realLoopbackRuntime(agentTeamHome, githubSecret, linearSecret);

    // Counts createWorktree calls (proof of genuine re-probing on the second run) exactly like
    // the F-1 test above.
    const createWorktreeCalls: unknown[] = [];
    const linearCreateCalls: unknown[] = [];
    const realGitAdapter = new RegistrationProbeGitAdapter();
    const countedGit: RegistrationProbePorts["git"] = Object.freeze({
      createWorktree: (
        command_: Parameters<RegistrationProbePorts["git"]["createWorktree"]>[0],
        options: Parameters<RegistrationProbePorts["git"]["createWorktree"]>[1],
      ) => {
        createWorktreeCalls.push(command_);
        return realGitAdapter.createWorktree(command_, options);
      },
      stagePaths: realGitAdapter.stagePaths.bind(realGitAdapter),
      commit: realGitAdapter.commit.bind(realGitAdapter),
      inspectWorkingTree: realGitAdapter.inspectWorkingTree.bind(realGitAdapter),
      push: realGitAdapter.push.bind(realGitAdapter),
      removeWorktree: realGitAdapter.removeWorktree.bind(realGitAdapter),
      inspectRepository: realGitAdapter.inspectRepository.bind(realGitAdapter),
      inspectRemoteBranch: realGitAdapter.inspectRemoteBranch.bind(realGitAdapter),
    });
    const countedLinear = Object.freeze({
      readCapability: linear.adapter.readCapability.bind(linear.adapter),
      findByMarker: linear.adapter.findByMarker.bind(linear.adapter),
      read: linear.adapter.read.bind(linear.adapter),
      cancel: linear.adapter.cancel.bind(linear.adapter),
      create: (
        command_: Parameters<typeof linear.adapter.create>[0],
        options: Parameters<typeof linear.adapter.create>[1],
      ) => {
        linearCreateCalls.push(command_);
        return linear.adapter.create(command_, options);
      },
    });

    const ports: RegistrationProbePorts = {
      activation: {
        readActivation: (id) =>
          Promise.resolve(
            ok(id === activationMarker.setupSessionId ? activationMarker : undefined),
          ),
      },
      mergedConfig: { read: () => Promise.resolve(ok(mergedConfigReceipt)) },
      linear: countedLinear,
      githubCapability: new RegistrationProbeGitHubCapabilityAdapter(fakeGh),
      sourceControl: new GitHubAdapter(fakeGh),
      git: countedGit,
      files: new RegistrationProbeFileAdapter(),
      webhook: new RegistrationProbeWebhookAdapter({
        transport: new NodeWebhookRuntimeTransport(),
        inbox: runtime.inbox,
        clock: createFixedClock(new Date().toISOString() as never),
        createDeliveryId: () => `o009e-delivery-${randomUUID()}`,
      }),
      providerEvents: new RegistrationProbeProviderEventAdapter(runtime.inbox),
      branchCleanup: new RegistrationProbeBranchCleanupAdapter(fakeGh),
      journal,
    };

    // --- Run 1: branch_push fails for real (nonexistent remote) -- Linear already succeeded,
    // but draftPullRequest/remoteBranch/localWorktree evidence is never captured for this run. ---
    const firstResolved = await resolveRegistrationProbeRunId(journal, project.id);
    if (!firstResolved.ok) throw new Error(firstResolved.error.code);
    expect(firstResolved.value.resumed).toBe(false);
    const firstRunId = firstResolved.value.runId;
    const firstCommand: RegistrationProbeStartCommand = Object.freeze({
      project,
      setupSessionId: activationMarker.setupSessionId,
      registrationRevision: 1,
      runId: firstRunId,
      worktreePath: join(allowedWorktreeRoot, firstRunId),
      gitRemote: "origin",
      linearWorkflowStateId: linear.backlogStateId,
      authority: authorityFor({
        projectId: project.id,
        setupSessionId: activationMarker.setupSessionId,
        registrationRevision: 1,
      }),
      webhookBaseUrls: Object.freeze({ github: runtime.baseUrl, linear: runtime.baseUrl }),
      webhookSecrets: Object.freeze({ github: githubSecret, linear: linearSecret }),
    });
    const coordinator1 = createRegistrationProbeCoordinator({ ports, allowedWorktreeRoot });
    const firstOutcome = await coordinator1.start(firstCommand);

    // This is the exact real-incident shape: linearIssue confirmed, everything downstream of the
    // failed push confirmed *absent* (never "pending"/"failed" forever) -- reaching genuine
    // terminal "failed", not stuck at "cleanup_required".
    expect(firstOutcome.state).toBe("failed");
    if (firstOutcome.state === "failed") {
      expect(firstOutcome.stage).toBe("branch_push");
      expect(firstOutcome.run.cleanup).toMatchObject({
        linearIssue: { state: "confirmed", reason: "confirmed_cancelled" },
        draftPullRequest: { state: "confirmed", reason: "confirmed_absent" },
        remoteBranch: { state: "confirmed", reason: "confirmed_absent" },
        // The worktree genuinely exists on disk (createWorktree succeeded before the real push
        // failed) -- proving this run's absence-checks correctly distinguish "never created"
        // (draftPullRequest/remoteBranch) from "exists, must be actually removed" (localWorktree).
        localWorktree: { state: "confirmed", reason: "confirmed_removed" },
      });
    }
    expect(createWorktreeCalls).toHaveLength(1);
    expect(linearCreateCalls).toHaveLength(1);
    expect(fakeGh.prs).toHaveLength(0);

    // --- The now-terminal run must never be resumed again: the next probe for this project
    // gets a genuinely fresh runId. ---
    const secondResolved = await resolveRegistrationProbeRunId(journal, project.id);
    if (!secondResolved.ok) throw new Error(secondResolved.error.code);
    expect(secondResolved.value.resumed).toBe(false);
    expect(secondResolved.value.runId).not.toBe(firstRunId);
    const secondRunId = secondResolved.value.runId;

    // The remote now accepts pushes again -- this run's own doomed push rejection was a one-time
    // injected condition, not a permanent property of the remote.
    await rm(join(bareRemote, "hooks", "pre-receive"), { force: true });

    // --- Run 2 (fresh runId, real remote this time): proves it is a genuine new probe, not a
    // replay -- every fake/real port is actually invoked again from zero. ---
    let providerEventsSent = false;
    const coordinator2 = createRegistrationProbeCoordinator({
      ports,
      allowedWorktreeRoot,
      providerEventPoll: {
        maxAttempts: 2,
        intervalMs: 0,
        wait: async () => {
          if (providerEventsSent) return;
          providerEventsSent = true;
          const linearIssue = linear.issues.at(-1);
          const pr = fakeGh.prs.at(-1);
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
    const secondCommand: RegistrationProbeStartCommand = Object.freeze({
      ...firstCommand,
      runId: secondRunId,
      worktreePath: join(allowedWorktreeRoot, secondRunId),
      gitRemote: "origin",
    });
    const secondOutcome = await coordinator2.start(secondCommand);

    // A second, genuinely fresh attempt against a *working* remote reaches all the way to
    // "verified" -- proving the first run's terminal "failed" state was not itself some kind of
    // poisoning of this project's ability to ever probe again, and that every port genuinely
    // re-ran from zero rather than replaying anything.
    if (secondOutcome.state !== "verified") {
      throw new Error(
        `expected second run verified, got ${JSON.stringify(secondOutcome, null, 2)}`,
      );
    }
    expect(secondOutcome.run.runId).toBe(secondRunId);
    expect(createWorktreeCalls).toHaveLength(2);
    expect(linearCreateCalls).toHaveLength(2);
    expect(fakeGh.prs).toHaveLength(1);
  }, 30_000);
});
