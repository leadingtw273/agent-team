import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  ChangeRequestCommentCommand,
  ChangeRequestCommentReceipt,
  ChangeRequestRef,
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
  CommitStatusesSnapshot,
  CommitStatusCommand,
  CreateDraftChangeRequestCommand,
  SourceControlPort,
  SourceControlRepositoryRef,
} from "../../application/ports/source-control.js";
import type {
  CiFailureLogExcerpt,
  CiFailureLogOutcome,
} from "../../application/pipelines/ci-recovery-model.js";
import type { MutationOptions, ReadOptions } from "../../application/ports/common.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { defaultCiFailureLogExcerptMaxBytes, extractFailureKeyLines } from "./ci-log-excerpt.js";
import { GhTransport } from "./transport.js";

export type GitHubMergeMutationKind = "enable_auto_merge" | "direct_squash";
export type GitHubMergeMutationOutcome =
  | "confirmed_enabled"
  | "request_accepted_readback_unknown"
  | "merged_directly"
  | "rejected"
  | "outcome_unknown";

/** Called synchronously at the real transport mutation boundary, never for adapter no-ops. */
export interface GitHubMergeMutationObserver {
  attempted(kind: GitHubMergeMutationKind, idempotencyKey: string): void;
  settled(
    kind: GitHubMergeMutationKind,
    idempotencyKey: string,
    outcome: GitHubMergeMutationOutcome,
  ): void;
}

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const shaPattern = /^[0-9a-f]{40}$/iu;
const contextPattern = /^[\x20-\x7e]{1,100}$/u;

const projectedChangeRequestSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    url: z.url(),
    state: z.enum(["open", "closed", "merged"]),
    draft: z.boolean(),
    baseBranch: z.string().min(1),
    headBranch: z.string().min(1),
    headSha: z.string().regex(shaPattern),
    mergeability: z.enum(["mergeable", "conflicting", "unknown"]),
    // C015x decision 2: GitHub's own `mergeable_state` -- see `ChangeRequestSnapshot.mergeStateStatus`'s
    // own header (application/ports/source-control.ts) for why this is required here (the real
    // adapter always populates it) despite being optional on that port-level type.
    //
    // C015y decision B: this is the *only* validation of `.mergeable_state` -- `changeRequestProjection`
    // below passes it through verbatim (no jq-side `if/elif ... else "unknown"` mapping anymore).
    // Three cases, all handled correctly by this schema alone:
    // - GitHub explicitly returns the literal string `"unknown"` -- a legitimate transient (GitHub
    //   is still computing mergeability) -- passes this enum, stays `"unknown"`.
    // - The field is missing, `null`, or GitHub renames/typos it -- jq's `.mergeable_state` on a
    //   missing/null field yields JSON `null`, which this enum rejects -- the whole response fails
    //   schema validation -> `external_failure`. This is deliberately *not* silently downgraded to
    //   `"unknown"` (the pre-C015y jq expression's own broad `else "unknown"` fallback did exactly
    //   that, and could never be caught by any test: see this file's own header on why no test ever
    //   executed the real jq string before this ticket).
    // - GitHub adds a genuinely new `mergeable_state` value this enum does not yet list -- also
    //   rejected by this same schema, fail-closed rather than silently treated as `"unknown"` --
    //   the enum must be explicitly extended once that value's real semantics are known.
    mergeStateStatus: z.enum([
      "clean",
      "behind",
      "blocked",
      "dirty",
      "draft",
      "unstable",
      "unknown",
    ]),
    // GitHub's own `.base.sha` -- the base commit SHA frozen at PR-readback time, *not* the base
    // branch's live tip (see `ChangeRequestSnapshot.baseSha`'s own header, source-control.ts, for
    // why the prior comment here calling it "current base-branch tip" was wrong -- C015z decision Q3).
    baseSha: z.string().regex(shaPattern),
    autoMergeEnabled: z.boolean(),
    updatedAt: z.string(),
  })
  .strict();
const repositoryMetadataSchema = z.object({ defaultBranch: z.string().min(1) }).strict();
/**
 * C015z decision (Q1): the list endpoint (`GET /repos/{owner}/{repo}/pulls`) returns GitHub's
 * `pull-request-simple` shape, which -- unlike the single-PR/create/patch endpoints' full
 * `pull-request` shape `projectedChangeRequestSchema` above validates -- has **no**
 * `mergeable`/`mergeable_state` field at all. Before this ticket, `draftCandidateProjection`
 * embedded the exact same `changeRequestProjection` string the detail endpoints use, and
 * `draftCandidateSchema` required `snapshot: projectedChangeRequestSchema` on every candidate --
 * `mergeStateStatus` being schema-`required` (C015y decision B) turned every list-endpoint call
 * into a guaranteed `external_failure`, breaking `createDraftChangeRequest`'s idempotent-reuse
 * path (an existing open draft PR for this exact base/head) the instant it was reached in
 * production. See `tests/contract/github-adapter-draft-candidate-projection.test.ts` for the real-jq
 * proof against GitHub's actual `pull-request-simple` shape.
 *
 * This schema is therefore deliberately narrow: only the four fields `createDraftChangeRequest`'s
 * own idempotency check needs (`number`, to re-fetch the full detail snapshot; `title`/`body`/
 * `draft`, to verify the candidate is genuinely the same logical PR this call intended to create).
 * It has **no** `mergeStateStatus` field -- not optional, structurally absent -- so any code that
 * tried to read BEHIND-ness off a raw list candidate fails to typecheck, it does not merely fail at
 * runtime. Once a candidate matches, `createDraftChangeRequest` always re-fetches the full,
 * required-`mergeStateStatus` snapshot via `getChangeRequest` (the single-PR detail endpoint)
 * before ever returning -- a list-shaped object is never smuggled out of this adapter disguised as
 * a `ChangeRequestSnapshot`.
 */
const draftCandidateSchema = z
  .array(
    z
      .object({
        number: z.number().int().positive(),
        title: z.string(),
        body: z.string(),
        draft: z.boolean(),
      })
      .strict(),
  )
  .max(2);
const projectedChecksPageSchema = z
  .object({
    totalCount: z.number().int().nonnegative(),
    checks: z.array(
      z
        .object({
          name: z.string().min(1),
          status: z.enum(["queued", "in_progress", "completed"]),
          conclusion: z.enum(["success", "failure", "cancelled", "skipped"]).nullable(),
          url: z.url().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const statusMutationSchema = z
  .object({ context: z.string(), state: z.enum(["pending", "success", "failure", "error"]) })
  .strict();
const projectedStatusesSchema = z
  .object({
    sha: z.string().regex(shaPattern),
    statuses: z.array(
      z
        .object({
          context: z.string(),
          state: z.enum(["pending", "success", "failure", "error"]),
          description: z.string().nullable(),
          targetUrl: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const projectedCommentSchema = z
  .object({ id: z.string().min(1), url: z.url(), createdAt: z.string(), body: z.string() })
  .strict();
const projectedCommentsPageSchema = z
  .object({ count: z.number().int().nonnegative(), matches: z.array(projectedCommentSchema) })
  .strict();
const autoMergeMutationSchema = z
  .object({
    data: z
      .object({
        enablePullRequestAutoMerge: z
          .object({ pullRequest: z.object({ id: z.string().min(1) }).strict() })
          .strict(),
      })
      .strict(),
  })
  .strict();
const readyForReviewMutationSchema = z
  .object({
    data: z
      .object({
        markPullRequestReadyForReview: z
          .object({
            pullRequest: z.object({ id: z.string().min(1), isDraft: z.literal(false) }).strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const squashMergeResultSchema = z.object({ merged: z.boolean() }).strict();

// C015y decision B: `mergeStateStatus` used to be its own `if/elif ... else "unknown"` chain here
// -- a *broad fallback* that silently mapped every unrecognized/missing `.mergeable_state` value
// to the same `"unknown"` this schema also treats as a legitimate transient, making a schema/field
// typo structurally indistinguishable from GitHub's own "still computing" signal. Passing
// `.mergeable_state` straight through and letting `projectedChangeRequestSchema`'s existing
// `z.enum([...])` be the *only* validation means a missing/null/typo'd field now fails schema
// validation (`external_failure`) instead of silently degrading -- see that schema field's own
// comment for the full three-way breakdown. `mergeability` (the boolean-derived 3-state field)
// keeps its own `if/elif/else` mapping unchanged -- that `else "unknown"` is a genuine, correct
// 2-valued-boolean-to-3-state map (GitHub's `.mergeable` is `true`/`false`/`null`), not a
// many-values-collapsed-into-one-catch-all like the one this ticket removes.
const changeRequestProjection =
  '{id:.node_id,number,url:.html_url,state:(if .merged_at != null then "merged" else .state end),draft,baseBranch:.base.ref,headBranch:.head.ref,headSha:.head.sha,mergeability:(if .mergeable == true then "mergeable" elif .mergeable == false then "conflicting" else "unknown" end),mergeStateStatus:.mergeable_state,baseSha:.base.sha,autoMergeEnabled:(.auto_merge != null),updatedAt:.updated_at}';
const repositoryMetadataProjection = "{defaultBranch:.default_branch}";
const checkProjection =
  '{name,status:(if .status == "completed" then "completed" elif .status == "in_progress" then "in_progress" else "queued" end),conclusion:(if .conclusion == null then null elif (.conclusion == "success" or .conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "skipped") then .conclusion else "failure" end),url:.html_url}';
const checksProjection = `{totalCount:.total_count,checks:[.check_runs[] | ${checkProjection}]}`;
/**
 * C017: a separate, narrower projection from `checkProjection` above -- adds `id`, which
 * `CommitCheck` (the shared, provider-agnostic port type `checksProjection` feeds) deliberately
 * does not carry. Empirically confirmed against this repository's own real CI (2026-08-08): for a
 * GitHub-Actions-created check run, `.id` on `GET .../check-runs` *is* the same numeric id
 * `GET /repos/{owner}/{repo}/actions/jobs/{id}/logs` expects -- both `check_run.id` and the
 * `/job/{id}` segment of that same check run's own `details_url`/`html_url` matched on a live
 * run. Kept entirely private to `getFailedCheckLogExcerpts`; never exposed on `CommitCheck`.
 */
const checkRunIdProjection = `{name,status:(if .status == "completed" then "completed" elif .status == "in_progress" then "in_progress" else "queued" end),conclusion:(if .conclusion == null then null elif (.conclusion == "success" or .conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "skipped") then .conclusion else "failure" end),id}`;
const checkRunIdPageProjection = `{totalCount:.total_count,checks:[.check_runs[] | ${checkRunIdProjection}]}`;
const projectedCheckRunIdPageSchema = z
  .object({
    totalCount: z.number().int().nonnegative(),
    checks: z.array(
      z
        .object({
          name: z.string().min(1),
          status: z.enum(["queued", "in_progress", "completed"]),
          conclusion: z.enum(["success", "failure", "cancelled", "skipped"]).nullable(),
          id: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();
/** C017: bounds how many failing check runs a single `getFailedCheckLogExcerpts` call will ever
 * fetch a log for -- a job-log request is comparatively expensive (can be megabytes), and the
 * combined excerpt budget (`defaultCiFailureLogExcerptMaxBytes` in ci-log-excerpt.ts) is spent
 * across whichever checks are inspected first regardless, so inspecting more than a handful buys
 * nothing once the budget is already exhausted by the first one or two. */
const maxFailingChecksInspected = 3;
const statusesProjection =
  "{sha,statuses:[.statuses[] | {context,state,description,targetUrl:.target_url}]}";
const commentProjection = "{id:(.id|tostring),url:.html_url,createdAt:.created_at,body}";
const enableAutoMergeMutation =
  "mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!,$mergeMethod:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid,mergeMethod:$mergeMethod}){pullRequest{id}}}";
const markReadyForReviewMutation =
  "mutation($pullRequestId:ID!){markPullRequestReadyForReview(input:{pullRequestId:$pullRequestId}){pullRequest{id,isDraft}}}";

/** C015x decision 1 step ①: adapter-only (never added to the shared `SourceControlPort`) --
 * precedent for a narrow, provider-specific capability beyond the shared port is
 * `squashMergeChangeRequest` below. Consumed only by
 * `resolveAuthoritativeBaseRevision` (src/cli/dispatch/authoritative-base.ts). */
export interface RepositoryMetadata {
  readonly defaultBranch: string;
}

export interface GhJsonTransport {
  requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
    options?: ReadOptions,
  ): Promise<Result<Output, DomainError>>;
}

/**
 * C017: kept as its own interface, deliberately never folded into `GhJsonTransport` -- every
 * pre-existing test double across this codebase that constructs a `GitHubAdapter` already
 * implements only `GhJsonTransport`, and none of them need to change for this ticket. See
 * `GitHubAdapter`'s constructor: the real `GhTransport` satisfies both, but a transport lacking
 * `requestText` is a legitimate, fully-typed input -- `getFailedCheckLogExcerpts` degrades to
 * `available: false` rather than requiring every caller to grow a fake method it will never use.
 */
export interface GhTextTransport {
  requestText(
    arguments_: readonly string[],
    options?: ReadOptions,
  ): Promise<Result<string, DomainError>>;
}

function failure<Value>(
  code: DomainError["code"] = "external_failure",
): Result<Value, DomainError> {
  return err(domainError(code));
}

function mutationAllowed(options: MutationOptions): boolean {
  return options.idempotencyKey.trim().length > 0;
}

function validRepository(reference: SourceControlRepositoryRef): boolean {
  const parts = reference.project.sourceControl.repository.split("/");
  return (
    reference.project.sourceControl.provider === "github" &&
    repositoryPattern.test(reference.project.sourceControl.repository) &&
    parts.every((part) => part !== "." && part !== "..")
  );
}

function validBranch(branch: string): boolean {
  return (
    branchPattern.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith(".") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock")
  );
}

function repositoryPath(reference: SourceControlRepositoryRef): string {
  return reference.project.sourceControl.repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function changeRequestNumber(reference: ChangeRequestRef): number | undefined {
  if (!/^[1-9][0-9]{0,9}$/u.test(reference.changeRequestId)) return undefined;
  const number = Number(reference.changeRequestId);
  return Number.isSafeInteger(number) ? number : undefined;
}

function providerInstant(value: string): Result<Instant, DomainError> {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return failure();
  const parsed = parseInstant(date.toISOString());
  return parsed.ok ? ok(parsed.value) : failure();
}

function snapshotFromProjection(
  value: z.infer<typeof projectedChangeRequestSchema>,
): Result<ChangeRequestSnapshot, DomainError> {
  const updatedAt = providerInstant(value.updatedAt);
  if (!updatedAt.ok) return failure();
  return ok({ ...value, updatedAt: updatedAt.value });
}

function commentFromProjection(
  value: z.infer<typeof projectedCommentSchema>,
): Result<ChangeRequestCommentReceipt, DomainError> {
  const createdAt = providerInstant(value.createdAt);
  return createdAt.ok
    ? ok({ id: value.id, url: value.url, createdAt: createdAt.value })
    : failure();
}

function rawField(name: string, value: string): readonly string[] {
  return ["-f", `${name}=${value}`];
}

function typedField(name: string, value: string): readonly string[] {
  return ["-F", `${name}=${value}`];
}

/** C015z decision (Q1): projects only `{number,title,body,draft}` -- the list (`pull-request-simple`)
 * shape has no `mergeable`/`mergeable_state` field to project in the first place. Never embeds
 * `changeRequestProjection` (that string is bound to the full `pull-request` shape the detail/
 * create/patch endpoints return -- see `draftCandidateSchema`'s own header on why sharing one
 * projection string across two differently-shaped endpoints was the root cause here). */
function draftCandidateProjection(baseBranch: string, headBranch: string): string {
  return `[.[] | select(.base.ref == ${JSON.stringify(baseBranch)} and .head.ref == ${JSON.stringify(headBranch)}) | {number,title,body:(.body // ""),draft}][:2]`;
}

function commentsProjection(marker: string): string {
  return `{count:length,matches:[.[] | select(.body | contains(${JSON.stringify(marker)})) | ${commentProjection}]}`;
}

export class GitHubAdapter implements SourceControlPort {
  constructor(readonly transport: GhJsonTransport & Partial<GhTextTransport> = new GhTransport()) {}

  async getChangeRequest(
    reference: ChangeRequestRef,
    options: ReadOptions = {},
  ): Promise<Result<ChangeRequestSnapshot, DomainError>> {
    const number = changeRequestNumber(reference);
    if (!validRepository(reference) || number === undefined) return failure();
    const result = await this.transport.requestJson(
      [
        "api",
        `repos/${repositoryPath(reference)}/pulls/${String(number)}`,
        "--jq",
        changeRequestProjection,
      ],
      projectedChangeRequestSchema,
      options,
    );
    return result.ok ? snapshotFromProjection(result.value) : result;
  }

  async createDraftChangeRequest(
    command: CreateDraftChangeRequestCommand,
    options: MutationOptions,
  ): Promise<Result<ChangeRequestSnapshot, DomainError>> {
    if (
      !validRepository(command) ||
      !mutationAllowed(options) ||
      !validBranch(command.baseBranch) ||
      !validBranch(command.headBranch) ||
      command.baseBranch === command.headBranch ||
      command.title.trim().length === 0 ||
      command.title.length > 256 ||
      command.body.length > 65_536
    ) {
      return failure();
    }
    const repository = repositoryPath(command);
    const existing = await this.transport.requestJson(
      [
        "api",
        `repos/${repository}/pulls`,
        "--method",
        "GET",
        ...rawField("state", "open"),
        ...rawField("base", command.baseBranch),
        ...rawField(
          "head",
          `${command.project.sourceControl.repository.split("/")[0] ?? ""}:${command.headBranch}`,
        ),
        "--jq",
        draftCandidateProjection(command.baseBranch, command.headBranch),
      ],
      draftCandidateSchema,
      options,
    );
    if (!existing.ok) return existing;
    if (existing.value.length > 0) {
      const candidate = existing.value[0];
      if (
        existing.value.length !== 1 ||
        candidate?.title !== command.title ||
        candidate.body !== command.body ||
        !candidate.draft
      ) {
        return failure("conflict");
      }
      // C015z decision (Q1): `candidate` is the narrow list-shaped projection (no
      // `mergeStateStatus`) -- it is never returned as-is. Re-fetch the full detail snapshot by PR
      // number before ever handing a `ChangeRequestSnapshot` back to the caller.
      return this.getChangeRequest(
        { project: command.project, changeRequestId: String(candidate.number) },
        options,
      );
    }
    const created = await this.transport.requestJson(
      [
        "api",
        `repos/${repository}/pulls`,
        "--method",
        "POST",
        ...rawField("title", command.title),
        ...rawField("body", command.body),
        ...rawField("base", command.baseBranch),
        ...rawField("head", command.headBranch),
        ...typedField("draft", "true"),
        "--jq",
        changeRequestProjection,
      ],
      projectedChangeRequestSchema,
      options,
    );
    if (!created.ok) return created;
    const snapshot = snapshotFromProjection(created.value);
    if (!snapshot.ok) return snapshot;
    if (
      !snapshot.value.draft ||
      snapshot.value.baseBranch !== command.baseBranch ||
      snapshot.value.headBranch !== command.headBranch
    ) {
      return failure();
    }
    return this.getChangeRequest(
      { project: command.project, changeRequestId: String(snapshot.value.number) },
      options,
    );
  }

  async getCommitChecks(
    repository: SourceControlRepositoryRef,
    headSha: string,
    options: ReadOptions = {},
  ): Promise<Result<CommitChecksSnapshot, DomainError>> {
    if (!validRepository(repository) || !shaPattern.test(headSha)) return failure();
    const projectedChecks: z.infer<typeof projectedChecksPageSchema>["checks"] = [];
    let totalCount: number | undefined;
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.transport.requestJson(
        [
          "api",
          `repos/${repositoryPath(repository)}/commits/${headSha}/check-runs?per_page=100&page=${String(page)}`,
          "-H",
          "Accept: application/vnd.github+json",
          "--jq",
          checksProjection,
        ],
        projectedChecksPageSchema,
        options,
      );
      if (!result.ok) return result;
      if (totalCount !== undefined && totalCount !== result.value.totalCount) return failure();
      totalCount = result.value.totalCount;
      projectedChecks.push(...result.value.checks);
      if (projectedChecks.length >= totalCount) break;
      if (page === 100 || result.value.checks.length === 0) return failure();
    }
    if (totalCount === undefined || projectedChecks.length !== totalCount) return failure();
    const checks = projectedChecks.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      ...(check.url === null ? {} : { url: check.url }),
    }));
    const aggregate = checks.some(
      (check) =>
        check.status === "completed" &&
        check.conclusion !== "success" &&
        check.conclusion !== "skipped",
    )
      ? "failure"
      : checks.length > 0 && checks.every((check) => check.status === "completed")
        ? "success"
        : "pending";
    return ok({ headSha: headSha.toLowerCase(), aggregate, checks });
  }

  /**
   * C017: adapter-only capability (never added to `SourceControlPort` -- see this method's own
   * type header, ci-recovery-model.ts) that closes the "recovery flies blind" gap: fetches a
   * bounded, heuristically-extracted excerpt of each failing check run's GitHub Actions job log,
   * for `CiRecoveryPipeline.run()` to attach as external data right before starting a repair
   * attempt. Every failure mode here -- a transport with no `requestText`, no failing check at
   * all, or the log endpoint itself erroring -- is a *read* result, never a hard `err`; only a
   * structurally invalid `repository`/`headSha` input fails closed, matching every other method
   * on this adapter.
   */
  async getFailedCheckLogExcerpts(
    repository: SourceControlRepositoryRef,
    headSha: string,
    options: ReadOptions = {},
  ): Promise<Result<CiFailureLogOutcome, DomainError>> {
    if (!validRepository(repository) || !shaPattern.test(headSha)) return failure();
    // Bound explicitly: `this.transport.requestText` is a class method, not an arrow-function
    // property -- calling it detached from `this.transport` (e.g. `const f = obj.method; f()`)
    // would lose its receiver and break on the real `GhTransport`, whose implementation reads its
    // own private fields.
    const requestText = this.transport.requestText?.bind(this.transport);
    if (requestText === undefined) {
      return ok({ available: false, reason: "log_transport_unavailable" });
    }

    const runs: z.infer<typeof projectedCheckRunIdPageSchema>["checks"] = [];
    let totalCount: number | undefined;
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.transport.requestJson(
        [
          "api",
          `repos/${repositoryPath(repository)}/commits/${headSha}/check-runs?per_page=100&page=${String(page)}`,
          "-H",
          "Accept: application/vnd.github+json",
          "--jq",
          checkRunIdPageProjection,
        ],
        projectedCheckRunIdPageSchema,
        options,
      );
      if (!result.ok) return ok({ available: false, reason: "check_runs_unavailable" });
      if (totalCount !== undefined && totalCount !== result.value.totalCount) {
        return ok({ available: false, reason: "check_runs_unavailable" });
      }
      totalCount = result.value.totalCount;
      runs.push(...result.value.checks);
      if (runs.length >= totalCount) break;
      if (page === 100 || result.value.checks.length === 0) {
        return ok({ available: false, reason: "check_runs_unavailable" });
      }
    }
    if (totalCount === undefined || runs.length !== totalCount) {
      return ok({ available: false, reason: "check_runs_unavailable" });
    }

    const failing = runs.filter(
      (run) =>
        run.status === "completed" && run.conclusion !== "success" && run.conclusion !== "skipped",
    );
    if (failing.length === 0) return ok({ available: false, reason: "no_failing_checks" });

    const excerpts: CiFailureLogExcerpt[] = [];
    let remainingBudget = defaultCiFailureLogExcerptMaxBytes;
    for (const run of failing.slice(0, maxFailingChecksInspected)) {
      if (remainingBudget <= 0) break;
      const logText = await requestText(
        ["api", `repos/${repositoryPath(repository)}/actions/jobs/${String(run.id)}/logs`],
        options,
      );
      if (!logText.ok) continue;
      const excerpt = extractFailureKeyLines(logText.value, remainingBudget);
      if (excerpt.text.trim().length === 0) continue;
      excerpts.push({
        checkName: run.name,
        text: excerpt.text,
        truncated: excerpt.truncated,
        sourceBytes: Buffer.byteLength(logText.value, "utf8"),
      });
      remainingBudget -= Buffer.byteLength(excerpt.text, "utf8");
    }
    if (excerpts.length === 0) return ok({ available: false, reason: "log_fetch_failed" });
    return ok({ available: true, excerpts });
  }

  async setCommitStatus(
    command: CommitStatusCommand,
    options: MutationOptions,
  ): Promise<Result<void, DomainError>> {
    if (
      !validRepository(command) ||
      !mutationAllowed(options) ||
      !shaPattern.test(command.headSha) ||
      !contextPattern.test(command.context) ||
      command.description.length === 0 ||
      command.description.length > 140 ||
      (command.targetUrl !== undefined && !z.url().safeParse(command.targetUrl).success)
    ) {
      return failure();
    }
    const result = await this.transport.requestJson(
      [
        "api",
        `repos/${repositoryPath(command)}/statuses/${command.headSha}`,
        "--method",
        "POST",
        ...rawField("state", command.state),
        ...rawField("context", command.context),
        ...rawField("description", command.description),
        ...(command.targetUrl === undefined ? [] : rawField("target_url", command.targetUrl)),
        "--jq",
        "{context,state}",
      ],
      statusMutationSchema,
      options,
    );
    if (!result.ok) return result;
    if (result.value.context !== command.context || result.value.state !== command.state) {
      return failure();
    }
    const readBack = await this.getCommitStatuses(command, command.headSha, options);
    if (!readBack.ok) return readBack;
    const status = readBack.value.statuses.find(
      (candidate) => candidate.context === command.context,
    );
    return readBack.value.headSha.toLowerCase() === command.headSha.toLowerCase() &&
      status?.state === command.state &&
      status.description === command.description &&
      status.targetUrl === command.targetUrl
      ? ok(undefined)
      : failure();
  }

  async getCommitStatuses(
    repository: SourceControlRepositoryRef,
    headSha: string,
    options: ReadOptions = {},
  ): Promise<Result<CommitStatusesSnapshot, DomainError>> {
    if (!validRepository(repository) || !shaPattern.test(headSha)) return failure();
    const readBack = await this.transport.requestJson(
      [
        "api",
        `repos/${repositoryPath(repository)}/commits/${headSha}/status`,
        "--jq",
        statusesProjection,
      ],
      projectedStatusesSchema,
      options,
    );
    if (!readBack.ok) return readBack;
    if (readBack.value.sha.toLowerCase() !== headSha.toLowerCase()) return failure("conflict");
    return ok({
      headSha: readBack.value.sha.toLowerCase(),
      statuses: Object.freeze(
        readBack.value.statuses.map((status) =>
          Object.freeze({
            context: status.context,
            state: status.state,
            ...(status.description === null ? {} : { description: status.description }),
            ...(status.targetUrl === null ? {} : { targetUrl: status.targetUrl }),
          }),
        ),
      ),
    });
  }

  async appendChangeRequestComment(
    command: ChangeRequestCommentCommand,
    options: MutationOptions,
  ): Promise<Result<ChangeRequestCommentReceipt, DomainError>> {
    const number = changeRequestNumber(command.changeRequest);
    if (
      !validRepository(command.changeRequest) ||
      number === undefined ||
      !mutationAllowed(options) ||
      !shaPattern.test(command.expectedHeadSha) ||
      command.body.trim().length === 0 ||
      command.body.length > 65_536
    ) {
      return failure();
    }
    const current = await this.getChangeRequest(command.changeRequest, options);
    if (!current.ok) return current;
    if (current.value.headSha.toLowerCase() !== command.expectedHeadSha.toLowerCase()) {
      return failure("conflict");
    }
    const marker = `<!-- agent-team:${command.kind}:${createHash("sha256").update(options.idempotencyKey, "utf8").digest("hex")} -->`;
    const storedBody = `${command.body}\n\n${marker}`;
    const repository = repositoryPath(command.changeRequest);
    const findExisting = async (): Promise<
      Result<z.infer<typeof projectedCommentSchema>[], DomainError>
    > => {
      const matches: z.infer<typeof projectedCommentSchema>[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const result = await this.transport.requestJson(
          [
            "api",
            `repos/${repository}/issues/${String(number)}/comments?per_page=100&page=${String(page)}`,
            "--jq",
            commentsProjection(marker),
          ],
          projectedCommentsPageSchema,
          options,
        );
        if (!result.ok) return result;
        matches.push(...result.value.matches);
        if (result.value.count < 100) return ok(matches);
      }
      return failure();
    };
    const existing = await findExisting();
    if (!existing.ok) return existing;
    if (existing.value.length > 0) {
      if (existing.value.length !== 1 || existing.value[0]?.body !== storedBody) {
        return failure("conflict");
      }
      return commentFromProjection(existing.value[0]);
    }
    const created = await this.transport.requestJson(
      [
        "api",
        `repos/${repository}/issues/${String(number)}/comments`,
        "--method",
        "POST",
        ...rawField("body", storedBody),
        "--jq",
        commentProjection,
      ],
      projectedCommentSchema,
      options,
    );
    if (!created.ok) return created;
    const readBack = await findExisting();
    if (!readBack.ok) return readBack;
    if (readBack.value.length !== 1 || readBack.value[0]?.body !== storedBody) return failure();
    const finalHead = await this.getChangeRequest(command.changeRequest, options);
    if (!finalHead.ok) return finalHead;
    if (finalHead.value.headSha.toLowerCase() !== command.expectedHeadSha.toLowerCase()) {
      return failure("conflict");
    }
    return commentFromProjection(readBack.value[0]);
  }

  async markChangeRequestReady(
    reference: ChangeRequestRef,
    expectedHeadSha: string,
    options: MutationOptions,
  ): Promise<Result<ChangeRequestSnapshot, DomainError>> {
    if (
      !validRepository(reference) ||
      !mutationAllowed(options) ||
      !shaPattern.test(expectedHeadSha)
    ) {
      return failure();
    }
    const current = await this.getChangeRequest(reference, options);
    if (!current.ok) return current;
    if (current.value.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
      return failure("conflict");
    }
    if (current.value.state !== "open") return failure("conflict");
    if (!current.value.draft) return current;

    const result = await this.transport.requestJson(
      [
        "api",
        "graphql",
        ...rawField("query", markReadyForReviewMutation),
        ...rawField("pullRequestId", current.value.id),
      ],
      readyForReviewMutationSchema,
      options,
    );
    if (!result.ok) return result;
    if (result.value.data.markPullRequestReadyForReview.pullRequest.id !== current.value.id) {
      return failure();
    }
    const readBack = await this.getChangeRequest(reference, options);
    if (!readBack.ok) return readBack;
    if (readBack.value.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
      return failure("conflict");
    }
    return readBack.value.state === "open" && !readBack.value.draft
      ? readBack
      : failure("external_failure");
  }

  async enableAutoMerge(
    reference: ChangeRequestRef,
    expectedHeadSha: string,
    options: MutationOptions,
    observer?: GitHubMergeMutationObserver,
  ): Promise<Result<ChangeRequestSnapshot, DomainError>> {
    if (
      !validRepository(reference) ||
      !mutationAllowed(options) ||
      !shaPattern.test(expectedHeadSha)
    ) {
      return failure();
    }
    const current = await this.getChangeRequest(reference, options);
    if (!current.ok) return current;
    if (current.value.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
      return failure("conflict");
    }
    if (
      current.value.state !== "open" ||
      current.value.draft ||
      current.value.mergeability !== "mergeable"
    ) {
      return failure("conflict");
    }
    if (current.value.autoMergeEnabled) return current;
    observer?.attempted("enable_auto_merge", options.idempotencyKey);
    const result = await this.transport.requestJson(
      [
        "api",
        "graphql",
        ...rawField("query", enableAutoMergeMutation),
        ...rawField("pullRequestId", current.value.id),
        ...rawField("expectedHeadOid", expectedHeadSha),
        ...rawField("mergeMethod", "SQUASH"),
      ],
      autoMergeMutationSchema,
      options,
    );
    if (!result.ok) {
      observer?.settled("enable_auto_merge", options.idempotencyKey, "outcome_unknown");
      return result;
    }
    if (result.value.data.enablePullRequestAutoMerge.pullRequest.id !== current.value.id) {
      observer?.settled("enable_auto_merge", options.idempotencyKey, "outcome_unknown");
      return failure();
    }
    observer?.settled(
      "enable_auto_merge",
      options.idempotencyKey,
      "request_accepted_readback_unknown",
    );
    const readBack = await this.getChangeRequest(reference, options);
    const confirmed =
      readBack.ok &&
      readBack.value.headSha.toLowerCase() === expectedHeadSha.toLowerCase() &&
      readBack.value.autoMergeEnabled;
    if (confirmed) {
      observer?.settled("enable_auto_merge", options.idempotencyKey, "confirmed_enabled");
      return readBack;
    }
    return failure(readBack.ok ? "external_failure" : readBack.error.code);
  }

  /**
   * O009d: `enableAutoMerge` structurally fails on GitHub for a PR that is already fully
   * mergeable ("Pull request is in clean status", UNPROCESSABLE) -- auto-merge exists precisely
   * to *wait* for checks that haven't finished yet, and the O005 setup flow only ever reaches
   * this call once CI and review are already green. Callers (setup-composition.ts's
   * `squashMerge.enable` fallback) must attempt this directly when `enableAutoMerge` fails.
   * `sha` is passed on the REST merge call so GitHub itself performs an atomic head-sha
   * comparison (belt-and-suspenders alongside this method's own pre-check below): a head that
   * moved between the read and the write is rejected server-side, not silently merged.
   */
  async squashMergeChangeRequest(
    reference: ChangeRequestRef,
    expectedHeadSha: string,
    options: MutationOptions,
    observer?: GitHubMergeMutationObserver,
  ): Promise<Result<ChangeRequestSnapshot, DomainError>> {
    const number = changeRequestNumber(reference);
    if (
      !validRepository(reference) ||
      number === undefined ||
      !mutationAllowed(options) ||
      !shaPattern.test(expectedHeadSha)
    ) {
      return failure();
    }
    const current = await this.getChangeRequest(reference, options);
    if (!current.ok) return current;
    if (current.value.state === "merged") return current;
    if (current.value.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
      return failure("conflict");
    }
    if (current.value.state !== "open") return failure("conflict");
    observer?.attempted("direct_squash", options.idempotencyKey);
    const merged = await this.transport.requestJson(
      [
        "api",
        `repos/${repositoryPath(reference)}/pulls/${String(number)}/merge`,
        "--method",
        "PUT",
        ...rawField("merge_method", "squash"),
        ...rawField("sha", expectedHeadSha),
        "--jq",
        "{merged}",
      ],
      squashMergeResultSchema,
      options,
    );
    if (!merged.ok) {
      observer?.settled("direct_squash", options.idempotencyKey, "outcome_unknown");
      return merged;
    }
    if (!merged.value.merged) {
      observer?.settled("direct_squash", options.idempotencyKey, "rejected");
      return failure();
    }
    observer?.settled("direct_squash", options.idempotencyKey, "merged_directly");
    const readBack = await this.getChangeRequest(reference, options);
    return readBack.ok &&
      readBack.value.headSha.toLowerCase() === expectedHeadSha.toLowerCase() &&
      readBack.value.state === "merged"
      ? readBack
      : failure(readBack.ok ? "external_failure" : readBack.error.code);
  }

  async closeChangeRequest(
    reference: ChangeRequestRef,
    options: MutationOptions,
  ): Promise<Result<ChangeRequestSnapshot, DomainError>> {
    const number = changeRequestNumber(reference);
    if (!validRepository(reference) || number === undefined || !mutationAllowed(options)) {
      return failure();
    }
    const current = await this.getChangeRequest(reference, options);
    if (!current.ok) return current;
    if (current.value.state === "merged") return failure("conflict");
    if (current.value.state === "closed") return current;
    const closed = await this.transport.requestJson(
      [
        "api",
        `repos/${repositoryPath(reference)}/pulls/${String(number)}`,
        "--method",
        "PATCH",
        ...rawField("state", "closed"),
        "--jq",
        changeRequestProjection,
      ],
      projectedChangeRequestSchema,
      options,
    );
    if (!closed.ok) return closed;
    const readBack = await this.getChangeRequest(reference, options);
    return readBack.ok && readBack.value.state === "closed" ? readBack : failure();
  }

  /**
   * C015x decision 1 step ①: reads GitHub's own live `default_branch` for this repository -- the
   * *caller* (`resolveAuthoritativeBaseRevision`) is responsible for comparing this against
   * whatever the project's own local config claims (`Project.defaultBranch`) and failing closed on
   * a mismatch; this method only ever reports GitHub's own truth, never validates it against
   * anything else. A read, not a mutation -- unlike every other adapter-only/port method on this
   * class, it takes `ReadOptions`, not `MutationOptions`.
   */
  async getRepositoryMetadata(
    reference: SourceControlRepositoryRef,
    options: ReadOptions = {},
  ): Promise<Result<RepositoryMetadata, DomainError>> {
    if (!validRepository(reference)) return failure();
    return this.transport.requestJson(
      ["api", `repos/${repositoryPath(reference)}`, "--jq", repositoryMetadataProjection],
      repositoryMetadataSchema,
      options,
    );
  }
}
