/**
 * O009b integration test for `agent-team registration setup refresh` (E004 dry-run defect fix).
 *
 * Reproduces the exact stuck-in-`ci_waiting` scenario a real user hit: `setup start` creates a
 * real draft PR (as in registration-cli-setup.test.ts), and once CI/review evidence is green,
 * `controller.refresh()` -- now finally reachable from the CLI -- must read that evidence back,
 * publish both audit receipts (Linear comment + PR comment), and advance the session all the way
 * to `awaiting_user_approval`. A second scenario proves a *not yet green* CI leaves the session
 * exactly at `ci_waiting`, never advancing on a false signal.
 *
 * Zero-live-mutation harness, same technique as the other registration-cli integration tests:
 * - GitHub is faked at the `GhTransport` method boundary (PR create/read, check-runs, commit
 *   status, and -- new for this test -- issue comments, since `refresh()`'s audit-publish step
 *   posts a PR comment via the O009 GitHubPullRequestAuditCommentWriter).
 * - Linear is faked at the `fetch` boundary under the real LinearGraphqlTransport/LinearReadModel/
 *   LinearMutationClient classes (same technique as the O006 integration test's own fixture),
 *   extended to track real per-issue comments (O006's own fixture always answered
 *   AgentTeamReadIssueComments with an empty list, since it never needed comment dedup -- this
 *   test does, since LinearIssueAuditCommentWriter delegates to the real dedup-checking
 *   LinearMutationClient.appendComment).
 * - Git itself is REAL (temp bare remote + checkout).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { GhTransport } from "../../src/adapters/github/index.js";
import {
  linearAgentRoleNames,
  linearAgentStatusNames,
  linearBlockingReasonNames,
  linearReviewRequirementNames,
  linearWorkStatusNames,
} from "../../src/adapters/linear/model.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { freshAuthorityDigest } from "../../src/cli/registration/authority.js";
import { createRegistrationSetupHandlers } from "../../src/cli/registration/setup-handlers.js";
import { buildRegistrationSetupComposition } from "../../src/cli/registration/setup-composition.js";
import { FileRegistrationSetupFinalApprovalAuthority } from "../../src/adapters/registration/index.js";
import {
  registrationSetupFinalApprovalPhrase,
  type RegistrationSetupApprovalBinding,
} from "../../src/application/registration/index.js";
import type { Sha256Digest } from "../../src/domain/review/index.js";
import type { Project } from "../../src/domain/project/index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

async function realGitRepository() {
  const root = await temporaryRoot("agent-team-o009b-git-");
  const bareRemote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  await execFileAsync("git", ["init", "--bare", "-q", "-b", "main", bareRemote]);
  await execFileAsync("git", ["clone", "-q", bareRemote, checkout]);
  await execFileAsync("git", ["-C", checkout, "config", "user.email", "setup@example.test"]);
  await execFileAsync("git", ["-C", checkout, "config", "user.name", "Setup"]);
  await writeFile(join(checkout, "README.md"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", checkout, "add", "README.md"]);
  await execFileAsync("git", ["-C", checkout, "commit", "-q", "-m", "seed"]);
  await execFileAsync("git", ["-C", checkout, "push", "-q", "origin", "HEAD:refs/heads/main"]);
  return { checkout, bareRemote };
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

interface FakePullRequest {
  id: string;
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  autoMergeEnabled: boolean;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  mergeCommitSha?: string;
}

interface FakeComment {
  id: string;
  url: string;
  body: string;
  createdAt: string;
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

/** Extended from registration-cli-setup.test.ts's own FakeGh: adds check-runs, commit status,
 * and issue-comment endpoints (needed by refresh()'s gate-evidence read and audit-publish step). */
class FakeGh implements Pick<
  GhTransport,
  "inspectAuthentication" | "inspectRepositoryCapabilities" | "requestJson" | "requestVoid"
> {
  ciConclusion: "success" | "failure" | null = "success";
  reviewState: "success" | "failure" | null = "success";
  statusesBySha = new Map<
    string,
    { context: string; state: string; description: string | null; targetUrl: string | null }[]
  >();
  commentsByNumber = new Map<number, FakeComment[]>();
  readonly prs: FakePullRequest[] = [];
  #nextPrNumber = 100;
  #nextCommentId = 1;
  /**
   * O009d: real GitHub rejects `enablePullRequestAutoMerge` with "Pull request is in clean
   * status" (UNPROCESSABLE) once a PR is already fully mergeable -- which the O005 setup flow's
   * own gate (CI + review both green) guarantees is *always* true by the time this call happens.
   * Set true to reproduce that structural failure and drive the direct-merge fallback.
   */
  simulateCleanStatusOnAutoMerge = false;

  constructor(
    readonly bareRemote: string,
    readonly defaultBranch: string,
    /** Only required by the O009d direct-merge fallback test: lets the fixture perform a *real*
     * git squash merge (via this same clone) so `mergedConfig.read`'s subsequent GitHub Contents
     * API reads can be served from genuine post-merge repository state, not invented data. */
    readonly checkout?: string,
  ) {}

  inspectAuthentication() {
    return Promise.resolve(
      ok({ active: true as const, host: "github.com", accountFingerprint: "fp" }),
    );
  }

  inspectRepositoryCapabilities() {
    return Promise.resolve(err(domainError("unavailable")));
  }

  requestVoid() {
    return Promise.resolve(err(domainError("unavailable")));
  }

  #snapshot(pr: FakePullRequest, headSha: string) {
    return {
      id: pr.id,
      number: pr.number,
      url: `https://github.test/owner/sandbox/pull/${String(pr.number)}`,
      state: pr.state,
      draft: pr.draft,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha,
      mergeability: "mergeable" as const,
      mergeStateStatus: "clean" as const,
      baseSha: "2".repeat(40),
      autoMergeEnabled: pr.autoMergeEnabled,
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
        // O009c fix landed: `.id` is now a genuine opaque node-id-shaped string, exactly like
        // real GitHub returns via `changeRequestProjection`'s `id:.node_id` (e.g.
        // "PR_kwDOTvUUF877drQL") and every other FakeGh fixture in this repo already used. Before
        // O009c, this had to be a decimal-look-alike (`String(number)`) as a workaround: `setup.ts`
        // stored `session.changeRequest = draft.value` (the *whole* ChangeRequestSnapshot, `.id` =
        // opaque node_id) and then reused `session.changeRequest.id` as `changeRequestId` for
        // every later ChangeRequestRef call (refresh's own `getChangeRequest`,
        // appendChangeRequestComment, `gateEvidence.read`, `squashMerge.enable`, `mergedConfig
        // .read`...) -- but `GitHubAdapter`'s own `changeRequestNumber()` requires that value to be
        // a plain decimal PR number, which an opaque node_id never is. O009c fixed every one of
        // those construction/comparison sites in setup.ts and setup-durable.ts to use
        // `String(session.changeRequest.number)` instead (matching how O006's `proactive-probe.ts`
        // already avoided this exact trap). Reverting `.id` here to its pre-fix numeric-lookalike
        // form reproduces the original E004 dry-run failure (`stage=change_request,
        // external_failure`) -- see the red-proof capture in this task's report.
        id: `PR_kwDOTest${String(number).padStart(8, "0")}`,
        number,
        state: "open",
        draft: fields["draft"] === "true",
        autoMergeEnabled: false,
        baseBranch: fields["base"] ?? this.defaultBranch,
        headBranch: fields["head"] ?? "",
        title: fields["title"] ?? "",
        body: fields["body"] ?? "",
      };
      this.prs.push(pr);
      const sha = (await realRefSha(this.bareRemote, pr.headBranch)) ?? "0".repeat(40);
      value = this.#snapshot(pr, sha);
    } else if (
      /\/pulls\/[1-9][0-9]*$/u.test(endpoint) &&
      method === "GET" &&
      jq.includes("mergeCommitSha")
    ) {
      // Same REST endpoint as the branch below, but `mergedConfig.read`'s own jq projection asks
      // for a different (also-real, GitHub-defined) shape of the same underlying PR resource.
      const number = Number(endpoint.split("/").pop());
      const pr = this.prs.find((candidate) => candidate.number === number);
      if (pr === undefined) return err(domainError("not_found"));
      const sha = (await realRefSha(this.bareRemote, pr.headBranch)) ?? "0".repeat(40);
      value = {
        id: pr.id,
        repository: "owner/sandbox",
        number: pr.number,
        state: pr.state,
        merged: pr.state === "merged",
        baseBranch: pr.baseBranch,
        headSha: sha,
        mergeCommitSha: pr.mergeCommitSha ?? null,
      };
    } else if (/\/pulls\/[1-9][0-9]*$/u.test(endpoint) && method === "GET") {
      const number = Number(endpoint.split("/").pop());
      const pr = this.prs.find((candidate) => candidate.number === number);
      if (pr === undefined) return err(domainError("not_found"));
      const sha = (await realRefSha(this.bareRemote, pr.headBranch)) ?? "0".repeat(40);
      value = this.#snapshot(pr, sha);
    } else if (/\/pulls\/[1-9][0-9]*\/merge$/u.test(endpoint) && method === "PUT") {
      // O009d: the direct-merge fallback's own REST endpoint. Performs a *real* git squash merge
      // through this fixture's own checkout (same technique as every other endpoint here that
      // derives values from real git state instead of inventing them) so that a subsequent
      // `mergedConfig.read` -- which the O005 flow calls immediately after a successful merge --
      // can be served from genuine post-merge repository content.
      const number = Number(/\/pulls\/([1-9][0-9]*)\/merge$/u.exec(endpoint)?.[1]);
      const pr = this.prs.find((candidate) => candidate.number === number);
      if (pr === undefined || this.checkout === undefined) return err(domainError("not_found"));
      if (pr.state !== "open" || fields["merge_method"] !== "squash") {
        return err(domainError("conflict"));
      }
      const headSha = await realRefSha(this.bareRemote, pr.headBranch);
      if (headSha === undefined || fields["sha"] !== headSha) {
        return err(domainError("conflict"));
      }
      await execFileAsync("git", ["-C", this.checkout, "fetch", "-q", "origin"]);
      await execFileAsync("git", [
        "-C",
        this.checkout,
        "checkout",
        "-q",
        "-B",
        "main",
        "origin/main",
      ]);
      await execFileAsync("git", [
        "-C",
        this.checkout,
        "merge",
        "-q",
        "--squash",
        `origin/${pr.headBranch}`,
      ]);
      await execFileAsync("git", [
        "-C",
        this.checkout,
        "commit",
        "-q",
        "-m",
        `Squash merge PR #${String(pr.number)}`,
      ]);
      await execFileAsync("git", [
        "-C",
        this.checkout,
        "push",
        "-q",
        "origin",
        "HEAD:refs/heads/main",
      ]);
      const mergeCommitSha = await realRefSha(this.bareRemote, "main");
      if (mergeCommitSha === undefined) return err(domainError("external_failure"));
      pr.state = "merged";
      pr.mergeCommitSha = mergeCommitSha;
      value = { merged: true };
    } else if (endpoint.includes("/commits/") && endpoint.endsWith(`/${this.defaultBranch}`)) {
      const sha = await realRefSha(this.bareRemote, this.defaultBranch);
      if (sha === undefined) return err(domainError("not_found"));
      value = { sha };
    } else if (endpoint.includes("/compare/")) {
      const [baseSha, headSha] = (endpoint.split("/compare/")[1] ?? "").split("...");
      // This fixture only ever needs to prove the "identical" ancestry case (the squash merge
      // commit this fixture just created *is* the new default-branch tip) -- see
      // `exactCompareAncestry` in merged-config.ts.
      value = {
        status: baseSha === headSha ? ("identical" as const) : ("ahead" as const),
        aheadBy: 0,
        behindBy: 0,
        totalCommits: 0,
        baseCommitSha: baseSha,
        mergeBaseSha: baseSha,
        commits: [],
      };
    } else if (endpoint.includes("/contents/") && method === "GET") {
      if (this.checkout === undefined) return err(domainError("not_found"));
      const path = decodeURIComponent(endpoint.split("/contents/")[1] ?? "");
      const ref = fields["ref"];
      if (ref === undefined) return err(domainError("external_failure"));
      const [{ stdout: content }, { stdout: gitSha }] = await Promise.all([
        execFileAsync("git", ["-C", this.checkout, "show", `${ref}:${path}`]),
        execFileAsync("git", ["-C", this.checkout, "rev-parse", `${ref}:${path}`]),
      ]);
      const encoded = Buffer.from(content, "utf8").toString("base64");
      value = {
        type: "file",
        path,
        sha: gitSha.trim(),
        size: Buffer.byteLength(content, "utf8"),
        encoding: "base64",
        content: encoded,
        target: null,
        submoduleGitUrl: null,
      };
    } else if (/^repos\/[^/]+\/[^/]+$/u.test(endpoint) && method === "GET") {
      value = { repository: "owner/sandbox", defaultBranch: this.defaultBranch };
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
          ? [
              {
                name: "CI",
                status:
                  this.ciConclusion === null ? ("in_progress" as const) : ("completed" as const),
                conclusion: this.ciConclusion,
                url: null,
              },
            ]
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
      // The review status this fixture reports is driven by `this.reviewState`, not just
      // whatever was POSTed, so tests can simulate a review gate that never went green.
      const posted = this.statusesBySha.get(sha) ?? [];
      const reviewContext = posted.find((entry) => entry.context === "agent-team/review");
      const statuses =
        this.reviewState === null || reviewContext === undefined
          ? []
          : [{ ...reviewContext, state: this.reviewState }];
      value = { sha, statuses };
    } else if (endpoint.includes("/git/ref/heads/")) {
      const branch = decodeURIComponent(endpoint.split("/git/ref/heads/")[1] ?? "");
      const sha = await realRefSha(this.bareRemote, branch);
      if (sha === undefined) return err(domainError("not_found"));
      value = { object: { sha } };
    } else if (
      endpoint === "graphql" &&
      fields["query"]?.includes("markPullRequestReadyForReview")
    ) {
      const pr = this.prs.find((candidate) => candidate.id === fields["pullRequestId"]);
      if (pr === undefined) return err(domainError("not_found"));
      pr.draft = false;
      value = {
        data: { markPullRequestReadyForReview: { pullRequest: { id: pr.id, isDraft: false } } },
      };
    } else if (endpoint === "graphql" && fields["query"]?.includes("enablePullRequestAutoMerge")) {
      if (this.simulateCleanStatusOnAutoMerge) {
        // O009d's exact real-GitHub repro: "Pull request is in clean status" (UNPROCESSABLE).
        // GhTransport masks HTTP-error detail into a generic domain error code either way, so a
        // plain external_failure here is the faithful fixture-level equivalent.
        return err(domainError("external_failure"));
      }
      // F-2 regression guard: this is required so `setup approve`'s full merge pipeline (squash
      // merge enablement, driven by the *now-aligned* controller/coordinator approval bindings)
      // can run end to end against this fixture. Deliberately does NOT simulate an actual GitHub
      // merge commit landing (state stays "open") -- enabling auto-merge is enough to reach a
      // legitimate `merge_pending` outcome, which is as far as this regression guard needs to go;
      // simulating a real squash-merge commit is a separate, unrelated concern already covered by
      // O005's own directly-faked-port tests.
      const pr = this.prs.find((candidate) => candidate.id === fields["pullRequestId"]);
      if (pr === undefined) return err(domainError("not_found"));
      pr.autoMergeEnabled = true;
      value = {
        data: { enablePullRequestAutoMerge: { pullRequest: { id: pr.id } } },
      };
    } else if (/\/issues\/[1-9][0-9]*\/comments(?:\?.*)?$/u.test(endpoint) && method === "GET") {
      const number = Number(/\/issues\/([1-9][0-9]*)\/comments(?:\?.*)?$/u.exec(endpoint)?.[1]);
      const markerMatch = /contains\((".*?")\)/u.exec(jq);
      const marker = markerMatch !== null ? (JSON.parse(markerMatch[1] ?? '""') as string) : "";
      const comments = this.commentsByNumber.get(number) ?? [];
      const matches = comments.filter((comment) => comment.body.includes(marker));
      value = { count: matches.length, matches };
    } else if (
      endpoint.includes("/issues/") &&
      endpoint.endsWith("/comments") &&
      method === "POST"
    ) {
      const number = Number(/\/issues\/([1-9][0-9]*)\/comments$/u.exec(endpoint)?.[1]);
      const id = `comment-${String(this.#nextCommentId)}`;
      this.#nextCommentId += 1;
      const comment: FakeComment = {
        id,
        url: `https://github.test/owner/sandbox/pull/${String(number)}#${id}`,
        body: fields["body"] ?? "",
        createdAt: new Date().toISOString(),
      };
      const list = this.commentsByNumber.get(number) ?? [];
      list.push(comment);
      this.commentsByNumber.set(number, list);
      value = {
        id: comment.id,
        url: comment.url,
        createdAt: comment.createdAt,
        body: comment.body,
      };
    } else {
      value = {};
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? ok(parsed.data) : err(domainError("external_failure"));
  }
}

/* -------------------------------------------------------------------------------------------- *
 * Linear fixture, extended from the O006 integration test's own buildLinearFixture: this test
 * needs a *pre-existing* audit issue (the draft's linearAuditIssueId, never created through this
 * fixture) and genuine per-issue comment tracking (O006's own fixture always answered
 * AgentTeamReadIssueComments with an empty list, since it never needed comment dedup).
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
  comments: { id: string; body: string; createdAt: string }[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * `LinearIssueAuditCommentWriter.appendComment` delegates to `LinearReadModel.readContext`, which
 * needs a *complete* catalog (buildLinearReadCatalog in model.ts requires one state per
 * `linearWorkStatusNames` entry and all four label groups populated) -- an empty or partial
 * label/state set fails closed with zero calls ever reaching the mutation. This mirrors the
 * O006 integration test's own `buildLinearFixture` catalog construction exactly, extended with a
 * pre-existing audit issue (never created through this fixture, matching how a real Setup draft
 * always names an *existing* Linear issue) and genuine per-issue comment tracking (O006's own
 * fixture always answered AgentTeamReadIssueComments with an empty list, since it never needed
 * comment dedup).
 */
function buildLinearAuditFixture(teamId: string, projectId: string, auditIssueId: string) {
  const states = Object.entries(linearWorkStatusNames).map(([status, name], index) => ({
    id: `state-${status}-${String(index)}`,
    name,
    type: status,
  }));
  const backlogStateId =
    states.find((state) => state.name === linearWorkStatusNames.backlog)?.id ?? states[0]?.id ?? "";

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

  const issues: FakeLinearIssue[] = [
    {
      id: auditIssueId,
      identifier: "AUDIT-1",
      title: "Setup audit",
      description: "",
      priority: 0,
      updatedAt: new Date().toISOString(),
      teamId,
      projectId,
      stateId: backlogStateId,
      labelIds: [],
      comments: [],
    },
  ];
  let commentSequence = 0;

  async function fakeFetch(
    _url: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> {
    await Promise.resolve();
    const parsedBody = JSON.parse(init.body as string) as {
      readonly operationName: string;
      readonly variables: Readonly<Record<string, unknown>>;
    };
    const { operationName, variables } = parsedBody;
    const emptyPage = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
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
      case "AgentTeamReadIssueLabels":
        return jsonResponse({ data: { issue: { labels: emptyPage } } });
      case "AgentTeamReadIssueRelations":
        return jsonResponse({ data: { issue: { relations: emptyPage } } });
      case "AgentTeamReadIssueInverseRelations":
        return jsonResponse({ data: { issue: { inverseRelations: emptyPage } } });
      case "AgentTeamReadIssueComments": {
        const issue = issues.find((candidate) => candidate.id === variables["issueId"]);
        return jsonResponse({
          data: {
            issue:
              issue === undefined
                ? null
                : {
                    comments: {
                      nodes: issue.comments,
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
          },
        });
      }
      case "AgentTeamCreateComment": {
        // The real mutation nests `issueId` inside `input`, not as a top-level variable -- see
        // LinearMutationClient's own call: `variables: { input: { issueId, body, ... } }`.
        const input = variables["input"] as Readonly<Record<string, unknown>>;
        const issue = issues.find((candidate) => candidate.id === input["issueId"]);
        if (issue === undefined) {
          return jsonResponse({ data: { commentCreate: { success: false, comment: null } } });
        }
        commentSequence += 1;
        const comment = {
          id: `comment-${String(commentSequence)}`,
          body: String(input["body"]),
          createdAt: new Date().toISOString(),
        };
        issue.comments.push(comment);
        return jsonResponse({
          data: {
            commentCreate: {
              success: true,
              comment: { id: comment.id, body: comment.body, createdAt: comment.createdAt },
            },
          },
        });
      }
      default:
        throw new Error(`fixture does not model operation ${operationName}`);
    }
  }

  return { fetch: fakeFetch, backlogStateId, issues };
}

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";

async function writeDraft(agentTeamHome: string, checkout: string): Promise<void> {
  const directory = join(agentTeamHome, "config", "registration");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${projectId}.draft.json`),
    JSON.stringify({
      schemaVersion: 1,
      project: {
        schemaVersion: 1,
        id: projectId,
        displayName: "Sandbox",
        localRepositoryPath: checkout,
        defaultBranch: "main",
        workManagement: {
          provider: "linear",
          containerId: "team-1",
          projectId: "linear-project-1",
        },
        sourceControl: { provider: "github", repository: "owner/sandbox" },
      },
      config: {
        schemaVersion: 1,
        projectId,
        defaultBranch: "main",
        platforms: {
          workManagement: {
            provider: "linear",
            containerId: "team-1",
            projectId: "linear-project-1",
          },
          sourceControl: { provider: "github", repository: "owner/sandbox" },
        },
        projectRules: ["Run quality checks."],
        roleInstructions: { implementer: ["Stay in scope."] },
        commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
      },
      linearAuditIssueId: "LINEAR-AUDIT-1",
    }),
    "utf8",
  );
}

async function* stream(chunk: string): AsyncIterable<string> {
  await Promise.resolve();
  yield chunk;
}

describe("O009b registration setup CLI: refresh is the only exit from ci_waiting", () => {
  it("advances ci_waiting all the way to awaiting_user_approval once CI and review are genuinely green", async () => {
    const { checkout, bareRemote } = await realGitRepository();
    const agentTeamHome = await temporaryRoot("agent-team-o009b-home-green-");
    await writeDraft(agentTeamHome, checkout);
    const github = new FakeGh(bareRemote, "main");
    const linear = buildLinearAuditFixture("team-1", "linear-project-1", "LINEAR-AUDIT-1");
    const environment = { LINEAR_API_KEY: "unused" };

    const handlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      stdin: stream("CREATE SETUP DRAFT PR\n"),
      buildComposition: (options) =>
        buildRegistrationSetupComposition({
          ...options,
          githubTransport: github,
          linearFetch: linear.fetch,
        }),
    });

    const startResult = await handlers.setupStart({ projectId });
    expect(startResult.state).toBe("success");
    expect((JSON.parse(startResult.message ?? "") as { readonly state: string }).state).toBe(
      "ci_waiting",
    );

    // Post the exact commit status the real gate-evidence read requires, exactly as the real
    // sandbox's own CI/review workflow would (agent-team/review context), so this genuinely
    // exercises the fixture's read path rather than asserting on an internal flag.
    const headSha = await realRefSha(bareRemote, "agent-team/setup");
    if (headSha === undefined) throw new Error("expected a pushed setup branch head");
    github.statusesBySha.set(headSha, [
      {
        context: "agent-team/review",
        state: "success",
        description: null,
        targetUrl: "https://review.test/1",
      },
    ]);
    github.ciConclusion = "success";
    github.reviewState = "success";

    const refreshHandlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      buildComposition: (options) =>
        buildRegistrationSetupComposition({
          ...options,
          githubTransport: github,
          linearFetch: linear.fetch,
        }),
    });
    const refreshResult = await refreshHandlers.setupRefresh({ projectId });

    expect(refreshResult.state).toBe("success");
    const refreshPayload = JSON.parse(refreshResult.message ?? "") as { readonly state: string };
    expect(refreshPayload.state).toBe("awaiting_user_approval");
    expect(linear.issues[0]?.comments).toHaveLength(1);
    expect(github.commentsByNumber.get(github.prs[0]?.number ?? -1)).toHaveLength(1);
  }, 30_000);

  it("leaves the session exactly at ci_waiting -- never advancing -- when CI has not gone green yet", async () => {
    const { checkout, bareRemote } = await realGitRepository();
    const agentTeamHome = await temporaryRoot("agent-team-o009b-home-pending-");
    await writeDraft(agentTeamHome, checkout);
    const github = new FakeGh(bareRemote, "main");
    github.ciConclusion = null; // CI still running: no check-run named "CI" observed yet
    const linear = buildLinearAuditFixture("team-1", "linear-project-1", "LINEAR-AUDIT-1");
    const environment = { LINEAR_API_KEY: "unused" };

    const handlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      stdin: stream("CREATE SETUP DRAFT PR\n"),
      buildComposition: (options) =>
        buildRegistrationSetupComposition({
          ...options,
          githubTransport: github,
          linearFetch: linear.fetch,
        }),
    });
    await handlers.setupStart({ projectId });

    const refreshHandlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      buildComposition: (options) =>
        buildRegistrationSetupComposition({
          ...options,
          githubTransport: github,
          linearFetch: linear.fetch,
        }),
    });
    const refreshResult = await refreshHandlers.setupRefresh({ projectId });

    // The engine's raw refresh() outcome reports "not_ready"/"ci_pending" at the top level for
    // this case (CI not yet completed) -- the *session*'s own phase is what must stay exactly
    // "ci_waiting", never falsely advancing.
    expect(refreshResult.state).toBe("success");
    const refreshPayload = JSON.parse(refreshResult.message ?? "") as {
      readonly state: string;
      readonly reason?: string;
      readonly session: { readonly phase: string };
    };
    expect(refreshPayload.state).toBe("not_ready");
    expect(refreshPayload.reason).toBe("pending");
    expect(refreshPayload.session.phase).toBe("ci_waiting");
    expect(linear.issues[0]?.comments).toHaveLength(0);
    expect(github.commentsByNumber.size).toBe(0);
  }, 30_000);
});

/**
 * O009c regression guard.
 *
 * Root cause: `setup.ts` built every `ChangeRequestRef`/comparison from
 * `session.changeRequest.id` -- the opaque GitHub GraphQL node id (e.g. `PR_kwDOTvUUF877drQL`)
 * -- instead of `session.changeRequest.number` (the plain decimal PR number that
 * `GitHubAdapter.changeRequestNumber()` actually requires). Every FakeGh fixture in this repo
 * already returns a genuinely opaque `.id` for real PRs *except* this file's, which (before this
 * fix) had to fake a decimal-looking id as a documented workaround just to get the O009b CLI
 * wiring scenario past this defect. That workaround is now removed (see the `FakeGh`'s PR-create
 * branch above): `.id` is a realistic opaque node-id-shaped string again, exactly matching what a
 * real E004 sandbox registration sees, and every scenario below must still pass.
 */
describe("O009c regression guard: opaque ChangeRequestSnapshot.id is never mistaken for the decimal PR number", () => {
  it("approve's precondition read (controller.read()) succeeds once refresh has advanced to awaiting_user_approval, with a real GitHub node-id-format PR id", async () => {
    const { checkout, bareRemote } = await realGitRepository();
    const agentTeamHome = await temporaryRoot("agent-team-o009c-home-approve-read-");
    await writeDraft(agentTeamHome, checkout);
    const github = new FakeGh(bareRemote, "main");
    const linear = buildLinearAuditFixture("team-1", "linear-project-1", "LINEAR-AUDIT-1");
    const environment = { LINEAR_API_KEY: "unused" };
    const buildComposition = (options: Parameters<typeof buildRegistrationSetupComposition>[0]) =>
      buildRegistrationSetupComposition({
        ...options,
        githubTransport: github,
        linearFetch: linear.fetch,
      });

    const handlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      stdin: stream("CREATE SETUP DRAFT PR\n"),
      buildComposition,
    });
    await handlers.setupStart({ projectId });

    // Sanity check: this is a genuinely opaque node id, not a decimal-string lookalike -- if a
    // future fixture change silently reintroduced the old workaround, this assertion (not just
    // the ones further down) would be the one to catch it.
    expect(github.prs[0]?.id).toMatch(/^PR_kwDOTest\d{8}$/u);
    expect(Number.isNaN(Number(github.prs[0]?.id))).toBe(true);

    const headSha = await realRefSha(bareRemote, "agent-team/setup");
    if (headSha === undefined) throw new Error("expected a pushed setup branch head");
    github.statusesBySha.set(headSha, [
      {
        context: "agent-team/review",
        state: "success",
        description: null,
        targetUrl: "https://review.test/1",
      },
    ]);
    github.ciConclusion = "success";
    github.reviewState = "success";

    const refreshHandlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      buildComposition,
    });
    const refreshResult = await refreshHandlers.setupRefresh({ projectId });
    expect(refreshResult.state).toBe("success");
    expect((JSON.parse(refreshResult.message ?? "") as { readonly state: string }).state).toBe(
      "awaiting_user_approval",
    );

    // This is the "approve 前置讀取" (approve's precondition read) itself: `setupApprove`'s first
    // substantive step, before it ever issues an approval intent, is exactly this `controller
    // .read()` call. Before O009c, this would already fail here (`gateEvidenceMatches`/durable
    // schema `receiptBound` comparing the just-written receipts' decimal-number-formatted
    // `changeRequestId` against the still-opaque `session.changeRequest.id`) -- never even
    // reaching the merge step.
    const built = await buildComposition({
      agentTeamHome,
      projectId,
      ensureWorktreeDirectories: true,
      environment,
    });
    if (built.state !== "ready") throw new Error(`composition_not_ready:${built.state}`);
    const read = await built.composition.controller.read({
      authorityDigest: freshAuthorityDigest(),
    });
    expect(read.state).toBe("awaiting_user_approval");
    expect(read.session).toBeDefined();
    expect(read.session?.phase).toBe("awaiting_user_approval");
  }, 30_000);

  it("forward-compatibility: a ci_waiting session file exactly as a pre-O009c run would have written it loads under the fixed code, and refresh() still advances and saves cleanly", async () => {
    // This reproduces the real, currently-live E004 session sitting in
    // ~/.agent-team/state/registration-setup/ at the time this fix was written: created by
    // `setup start` (unaffected by O009c -- session creation for ci_waiting has always stored the
    // raw ChangeRequestSnapshot untouched) and stuck at ci_waiting with no gate/audit/merged-config
    // receipts yet (those only get written by the refresh/approve steps this fix touches). O009c
    // must not require re-running `setup start` for such a session.
    const { checkout, bareRemote } = await realGitRepository();
    const agentTeamHome = await temporaryRoot("agent-team-o009c-home-forward-compat-");
    await writeDraft(agentTeamHome, checkout);
    const github = new FakeGh(bareRemote, "main");
    const linear = buildLinearAuditFixture("team-1", "linear-project-1", "LINEAR-AUDIT-1");
    const environment = { LINEAR_API_KEY: "unused" };
    const buildComposition = (options: Parameters<typeof buildRegistrationSetupComposition>[0]) =>
      buildRegistrationSetupComposition({
        ...options,
        githubTransport: github,
        linearFetch: linear.fetch,
      });

    const handlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      stdin: stream("CREATE SETUP DRAFT PR\n"),
      buildComposition,
    });
    const startResult = await handlers.setupStart({ projectId });
    expect(startResult.state).toBe("success");

    // Read the *actual* on-disk session.json this "pre-fix" run produced, and confirm it is
    // exactly the old shape: opaque changeRequest.id, and none of the receipts O009c's fix
    // touches exist yet -- i.e. there is nothing here for a schema migration to even act on.
    const registrationSetupRoot = join(agentTeamHome, "state", "registration-setup");
    const sessionDirectories = (await readdir(registrationSetupRoot)).filter((name) =>
      name.startsWith("setup-"),
    );
    expect(sessionDirectories).toHaveLength(1);
    const sessionPath = join(registrationSetupRoot, sessionDirectories[0] ?? "", "session.json");
    const preFixSession = JSON.parse(await readFile(sessionPath, "utf8")) as {
      readonly phase: string;
      readonly changeRequest: { readonly id: string; readonly number: number };
      readonly gateEvidenceReceipt?: unknown;
      readonly audit?: unknown;
      readonly mergedConfigReceipt?: unknown;
    };
    expect(preFixSession.phase).toBe("ci_waiting");
    expect(preFixSession.changeRequest.id).toMatch(/^PR_kwDOTest\d{8}$/u);
    expect(Number.isNaN(Number(preFixSession.changeRequest.id))).toBe(true);
    expect(preFixSession.gateEvidenceReceipt).toBeUndefined();
    expect(preFixSession.audit).toBeUndefined();
    expect(preFixSession.mergedConfigReceipt).toBeUndefined();

    const headSha = await realRefSha(bareRemote, "agent-team/setup");
    if (headSha === undefined) throw new Error("expected a pushed setup branch head");
    github.statusesBySha.set(headSha, [
      {
        context: "agent-team/review",
        state: "success",
        description: null,
        targetUrl: "https://review.test/1",
      },
    ]);
    github.ciConclusion = "success";
    github.reviewState = "success";

    // Load this exact pre-existing file with a *fresh* composition (fixed code, same as
    // production would when the user's real stuck session gets refreshed) and advance it. No
    // `setup start` re-run, no session file rewritten by hand -- just the fixed code loading what
    // the (also unchanged, for this phase) old code had already written to disk.
    const refreshHandlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      buildComposition,
    });
    const refreshResult = await refreshHandlers.setupRefresh({ projectId });
    expect(refreshResult.state).toBe("success");
    const refreshPayload = JSON.parse(refreshResult.message ?? "") as { readonly state: string };
    expect(refreshPayload.state).toBe("awaiting_user_approval");

    // And the save that refresh() performs mid-flight must have landed on disk with the *fixed*
    // (decimal-number) format, proving the migration is clean end-to-end, not just in memory.
    const postFixSession = JSON.parse(await readFile(sessionPath, "utf8")) as {
      readonly phase: string;
      readonly gateEvidenceReceipt?: { readonly changeRequestId: string };
    };
    expect(postFixSession.phase).toBe("awaiting_user_approval");
    expect(postFixSession.gateEvidenceReceipt?.changeRequestId).toBe(
      String(preFixSession.changeRequest.number),
    );
  }, 30_000);
});

/**
 * F-2 regression guard (2026-08-06 fresh-context acceptance review of O009c's first commit).
 *
 * `RegistrationSetupApprovalBinding` has *two* independent production construction sites:
 * `setup-controller.ts`'s module-local `approvalBinding()` (issue side --
 * `issueLocalUiApprovalIntent` calls it to build the binding it hands to
 * `finalApproval.issue(...)`, which the durable ledger persists verbatim as `grant.binding`) and
 * `setup.ts`'s own `approvalBinding()` (consume side -- `#authorizeMergeExclusive` calls it to
 * build `expectedBinding` for `finalApproval.verifyAndConsume(...)`, which the ledger compares
 * field-by-field against `grant.binding` via `sameValue`). O009c's first commit fixed only the
 * `setup.ts` copy; `setup-controller.ts`'s copy still built `changeRequestId` from the opaque
 * `session.changeRequest.id`. Because both copies had *always* used the same (buggy) opaque id
 * before this fix, no existing test could ever have caught two independent construction sites
 * silently diverging -- least of all `registration-setup-local.test.ts`'s own `binding()` helper,
 * which feeds the *same* object to both `authority.issue(...)` and `authority.verifyAndConsume(
 * ...)` and is therefore structurally incapable of detecting drift between two different
 * *production* construction sites. This describe block is deliberately built to close exactly
 * that blind spot: the positive test drives the real `RegistrationSetupController` (issue side)
 * and the real `RegistrationSetupCoordinator` (consume side, reached transitively through
 * `approveAndMergeLocalUi`) against the same real, file-backed ledger, with a genuinely opaque
 * node-id-format fixture PR id throughout -- so any future re-introduction of this exact
 * two-construction-sites drift would fail here even if every other test stays green.
 */
describe("F-2 regression guard: approval binding issue-side (controller) and consume-side (coordinator) construction sites must agree", () => {
  it("full `setup approve` succeeds end to end -- controller issues, coordinator consumes, real ledger accepts -- with a real GitHub node-id-format PR id", async () => {
    const { checkout, bareRemote } = await realGitRepository();
    const agentTeamHome = await temporaryRoot("agent-team-f2-home-approve-");
    await writeDraft(agentTeamHome, checkout);
    const github = new FakeGh(bareRemote, "main");
    const linear = buildLinearAuditFixture("team-1", "linear-project-1", "LINEAR-AUDIT-1");
    const environment = { LINEAR_API_KEY: "unused" };
    const buildComposition = (options: Parameters<typeof buildRegistrationSetupComposition>[0]) =>
      buildRegistrationSetupComposition({
        ...options,
        githubTransport: github,
        linearFetch: linear.fetch,
      });

    const handlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      stdin: stream("CREATE SETUP DRAFT PR\n"),
      buildComposition,
    });
    await handlers.setupStart({ projectId });

    const headSha = await realRefSha(bareRemote, "agent-team/setup");
    if (headSha === undefined) throw new Error("expected a pushed setup branch head");
    github.statusesBySha.set(headSha, [
      {
        context: "agent-team/review",
        state: "success",
        description: null,
        targetUrl: "https://review.test/1",
      },
    ]);
    github.ciConclusion = "success";
    github.reviewState = "success";

    const refreshHandlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      buildComposition,
    });
    const refreshResult = await refreshHandlers.setupRefresh({ projectId });
    expect(refreshResult.state).toBe("success");
    expect((JSON.parse(refreshResult.message ?? "") as { readonly state: string }).state).toBe(
      "awaiting_user_approval",
    );

    const approveHandlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      stdin: stream(`${registrationSetupFinalApprovalPhrase}\n`),
      buildComposition,
    });
    const approveResult = await approveHandlers.setupApprove({ projectId });

    expect(approveResult.state).toBe("success");
    const approvePayload = JSON.parse(approveResult.message ?? "") as {
      readonly state: string;
      readonly reason?: string;
      readonly session?: { readonly phase: string };
    };
    // The F-2 defect's exact symptom: `state:"blocked", reason:"user_approval_invalid"` because
    // the ledger's `sameValue(grant.binding, expectedBinding)` rejected the two mismatched
    // `changeRequestId` formats. Pinning the *absence* of this specific outcome, not just "some
    // success", is the point of this assertion.
    expect(approvePayload).not.toMatchObject({ state: "blocked", reason: "user_approval_invalid" });
    // The full pipeline's legitimate stopping point for this fixture: ledger issue-and-consume
    // succeeded (session advanced past `awaiting_user_approval` into the merge state machine),
    // merge intent + squash-merge-enable both went through, and the coordinator is now waiting on
    // GitHub to actually land the squash merge commit -- simulating that commit landing is a
    // separate, unrelated concern already covered by O005's own directly-faked-port tests.
    expect(approvePayload.state).toBe("merge_pending");
    expect(approvePayload.session?.phase).toBe("merge_pending");

    const registrationSetupRoot = join(agentTeamHome, "state", "registration-setup");
    const sessionDirectories = (await readdir(registrationSetupRoot)).filter((name) =>
      name.startsWith("setup-"),
    );
    expect(sessionDirectories).toHaveLength(1);
    const sessionPath = join(registrationSetupRoot, sessionDirectories[0] ?? "", "session.json");
    const persisted = JSON.parse(await readFile(sessionPath, "utf8")) as {
      readonly phase: string;
      readonly approvalReferenceDigest?: string;
      readonly approvalConsumeOperationDigest?: string;
      readonly mergeIntent?: { readonly changeRequestId: string };
    };
    expect(persisted.phase).toBe("merge_pending");
    // Both populated only on a genuinely successful ledger consume -- proof this ran through
    // `#authorizeMergeExclusive`'s `verified_and_consumed` branch, not merely returned early.
    expect(persisted.approvalReferenceDigest).toBeDefined();
    expect(persisted.approvalConsumeOperationDigest).toBeDefined();
    expect(persisted.mergeIntent?.changeRequestId).toBe(String(github.prs[0]?.number));
  }, 30_000);

  it("negative control: the real durable ledger rejects consumption when the issue-side and consume-side bindings differ only in changeRequestId format", async () => {
    const stateRoot = await temporaryRoot("agent-team-f2-ledger-negative-");
    const authority = new FileRegistrationSetupFinalApprovalAuthority(stateRoot);
    const localUiAuthority = Object.freeze({
      issuer: "local_ui" as const,
      authorityDigest: freshAuthorityDigest(),
    });

    function binding(changeRequestId: string): RegistrationSetupApprovalBinding {
      return {
        schemaVersion: 1,
        setupSessionId: "setup-f2-negative-control",
        setupSessionRevision: 2,
        projectId: projectId as Project["id"],
        previewDigest: freshAuthorityDigest() as Sha256Digest,
        changeRequestId,
        headSha: "e".repeat(40),
        requirementsDigest: freshAuthorityDigest() as Sha256Digest,
        diffDigest: freshAuthorityDigest() as Sha256Digest,
        linearAuditIssueId: "LINEAR-AUDIT-1",
        gateEvidenceDigest: freshAuthorityDigest() as Sha256Digest,
      };
    }
    // Same shape as the *real* pre-F-2 defect: issue side (mirroring setup-controller.ts's
    // then-unfixed `approvalBinding()`) uses the opaque node id; consume side (mirroring the
    // already-fixed setup.ts `approvalBinding()`) uses the decimal number. Every other field is
    // identical.
    const issueSideBinding = binding("PR_kwDOTest00000042");
    const consumeSideBinding = binding("42");

    const issued = await authority.issue(issueSideBinding, localUiAuthority, {
      idempotencyKey: "f2-negative-control:issue",
    });
    if (!issued.ok || issued.value.state !== "issued") {
      throw new Error(`expected issue to succeed, got ${JSON.stringify(issued)}`);
    }

    const consumed = await authority.verifyAndConsume(
      {
        approvalId: issued.value.grant.approvalId,
        userConfirmed: true,
        expectedSetupRevision: consumeSideBinding.setupSessionRevision,
      },
      consumeSideBinding,
      localUiAuthority,
      { idempotencyKey: "f2-negative-control:consume" },
    );
    expect(consumed).toMatchObject({ ok: true, value: { state: "rejected" } });

    // Control: the *identical* binding on both sides (this is what F-2's fix restores) verifies
    // and consumes cleanly -- proving the rejection above is specifically about the format
    // mismatch, not some other malformed field in this hand-built fixture. A fresh authority
    // digest is required here: re-issuing the exact same binding under the *same* authority the
    // first `issue()` call above already used would collide with that grant's own
    // still-unexpired duplicate-binding guard (a different, unrelated ledger invariant), not
    // exercise the format-mismatch path this control is meant to isolate.
    const controlAuthority = Object.freeze({
      issuer: "local_ui" as const,
      authorityDigest: freshAuthorityDigest(),
    });
    const issuedControl = await authority.issue(issueSideBinding, controlAuthority, {
      idempotencyKey: "f2-negative-control:issue-matched",
    });
    if (!issuedControl.ok || issuedControl.value.state !== "issued") {
      throw new Error(`expected control issue to succeed, got ${JSON.stringify(issuedControl)}`);
    }
    const consumedControl = await authority.verifyAndConsume(
      {
        approvalId: issuedControl.value.grant.approvalId,
        userConfirmed: true,
        expectedSetupRevision: issueSideBinding.setupSessionRevision,
      },
      issueSideBinding,
      controlAuthority,
      { idempotencyKey: "f2-negative-control:consume-matched" },
    );
    expect(consumedControl).toMatchObject({ ok: true, value: { state: "verified_and_consumed" } });
  });
});

/**
 * O009d regression guard.
 *
 * Root cause: on real GitHub, `GitHubAdapter.enableAutoMerge` (GraphQL
 * `enablePullRequestAutoMerge`) fails with "Pull request is in clean status" (UNPROCESSABLE) once
 * a PR is already fully mergeable -- and the O005 setup flow only ever calls this after CI and
 * review are both green, so the PR is *always* already clean by the time `setup approve` reaches
 * the merge step. `setup approve` therefore failed at `stage=merge` on every real registration,
 * even with the repository's own `allow_auto_merge` setting enabled (confirmed by direct repro).
 * The fix (`createGitHubSquashMergePort`'s fallback in setup-composition.ts, and
 * `GitHubAdapter.squashMergeChangeRequest`, the new REST `PUT .../merge` method) is unit/contract
 * tested in isolation elsewhere; this test proves the fallback also works wired into the real
 * CLI end to end -- the exact path the user's own stuck-at-`merge_pending` session needs.
 */
describe("O009d regression guard: direct-merge fallback lets setup approve finish on a real-GitHub-shaped PR that is already clean", () => {
  it("full `setup approve` reaches `activated` when enableAutoMerge structurally fails (real GitHub 'clean status') by falling back to a direct squash merge", async () => {
    const { checkout, bareRemote } = await realGitRepository();
    const agentTeamHome = await temporaryRoot("agent-team-o009d-home-direct-merge-");
    await writeDraft(agentTeamHome, checkout);
    const github = new FakeGh(bareRemote, "main", checkout);
    github.simulateCleanStatusOnAutoMerge = true;
    const linear = buildLinearAuditFixture("team-1", "linear-project-1", "LINEAR-AUDIT-1");
    const environment = { LINEAR_API_KEY: "unused" };
    const buildComposition = (options: Parameters<typeof buildRegistrationSetupComposition>[0]) =>
      buildRegistrationSetupComposition({
        ...options,
        githubTransport: github,
        linearFetch: linear.fetch,
      });

    const handlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      stdin: stream("CREATE SETUP DRAFT PR\n"),
      buildComposition,
    });
    await handlers.setupStart({ projectId });

    const headSha = await realRefSha(bareRemote, "agent-team/setup");
    if (headSha === undefined) throw new Error("expected a pushed setup branch head");
    github.statusesBySha.set(headSha, [
      {
        context: "agent-team/review",
        state: "success",
        description: null,
        targetUrl: "https://review.test/1",
      },
    ]);
    github.ciConclusion = "success";
    github.reviewState = "success";

    const refreshHandlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      buildComposition,
    });
    const refreshResult = await refreshHandlers.setupRefresh({ projectId });
    expect(refreshResult.state).toBe("success");
    expect((JSON.parse(refreshResult.message ?? "") as { readonly state: string }).state).toBe(
      "awaiting_user_approval",
    );

    const approveHandlers = createRegistrationSetupHandlers({
      agentTeamHome,
      environment,
      stdin: stream(`${registrationSetupFinalApprovalPhrase}\n`),
      buildComposition,
    });
    const approveResult = await approveHandlers.setupApprove({ projectId });

    expect(approveResult.state).toBe("success");
    const approvePayload = JSON.parse(approveResult.message ?? "") as {
      readonly state: string;
      readonly reason?: string;
      readonly stage?: string;
    };
    // The O009d defect's exact symptom before this fix: a `failed`/`portFailure` outcome at
    // `stage: "merge"`, because `enableAutoMerge` failed and there was no fallback.
    expect(approvePayload.state).not.toBe("failed");
    expect(approvePayload.state).toBe("activated");

    expect(github.prs[0]?.state).toBe("merged");
    expect(github.prs[0]?.autoMergeEnabled).toBe(false); // fallback never touched auto-merge at all

    const registrationSetupRoot = join(agentTeamHome, "state", "registration-setup");
    const sessionDirectories = (await readdir(registrationSetupRoot)).filter((name) =>
      name.startsWith("setup-"),
    );
    expect(sessionDirectories).toHaveLength(1);
    const sessionPath = join(registrationSetupRoot, sessionDirectories[0] ?? "", "activation.json");
    const persisted = JSON.parse(await readFile(sessionPath, "utf8")) as {
      readonly session: {
        readonly phase: string;
        readonly mergeReceipt?: { readonly state: string };
      };
    };
    expect(persisted.session.phase).toBe("activated");
    expect(persisted.session.mergeReceipt?.state).toBe("merged");
  }, 30_000);
});
