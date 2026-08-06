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
import { GhTransport } from "./transport.js";

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
    autoMergeEnabled: z.boolean(),
    updatedAt: z.string(),
  })
  .strict();
const draftCandidateSchema = z
  .array(
    z
      .object({
        title: z.string(),
        body: z.string(),
        snapshot: projectedChangeRequestSchema,
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

const changeRequestProjection =
  '{id:.node_id,number,url:.html_url,state:(if .merged_at != null then "merged" else .state end),draft,baseBranch:.base.ref,headBranch:.head.ref,headSha:.head.sha,mergeability:(if .mergeable == true then "mergeable" elif .mergeable == false then "conflicting" else "unknown" end),autoMergeEnabled:(.auto_merge != null),updatedAt:.updated_at}';
const checkProjection =
  '{name,status:(if .status == "completed" then "completed" elif .status == "in_progress" then "in_progress" else "queued" end),conclusion:(if .conclusion == null then null elif (.conclusion == "success" or .conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "skipped") then .conclusion else "failure" end),url:.html_url}';
const checksProjection = `{totalCount:.total_count,checks:[.check_runs[] | ${checkProjection}]}`;
const statusesProjection =
  "{sha,statuses:[.statuses[] | {context,state,description,targetUrl:.target_url}]}";
const commentProjection = "{id:(.id|tostring),url:.html_url,createdAt:.created_at,body}";
const enableAutoMergeMutation =
  "mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!,$mergeMethod:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid,mergeMethod:$mergeMethod}){pullRequest{id}}}";
const markReadyForReviewMutation =
  "mutation($pullRequestId:ID!){markPullRequestReadyForReview(input:{pullRequestId:$pullRequestId}){pullRequest{id,isDraft}}}";

export interface GhJsonTransport {
  requestJson<Output>(
    arguments_: readonly string[],
    schema: z.ZodType<Output>,
    options?: ReadOptions,
  ): Promise<Result<Output, DomainError>>;
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

function draftCandidateProjection(baseBranch: string, headBranch: string): string {
  return `[.[] | select(.base.ref == ${JSON.stringify(baseBranch)} and .head.ref == ${JSON.stringify(headBranch)}) | {title,body:(.body // ""),snapshot:${changeRequestProjection}}][:2]`;
}

function commentsProjection(marker: string): string {
  return `{count:length,matches:[.[] | select(.body | contains(${JSON.stringify(marker)})) | ${commentProjection}]}`;
}

export class GitHubAdapter implements SourceControlPort {
  constructor(readonly transport: GhJsonTransport = new GhTransport()) {}

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
        !candidate.snapshot.draft
      ) {
        return failure("conflict");
      }
      return snapshotFromProjection(candidate.snapshot);
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
    if (!result.ok) return result;
    if (result.value.data.enablePullRequestAutoMerge.pullRequest.id !== current.value.id) {
      return failure();
    }
    const readBack = await this.getChangeRequest(reference, options);
    return readBack.ok &&
      readBack.value.headSha.toLowerCase() === expectedHeadSha.toLowerCase() &&
      readBack.value.autoMergeEnabled
      ? readBack
      : failure(readBack.ok ? "external_failure" : readBack.error.code);
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
    if (!merged.ok) return merged;
    if (!merged.value.merged) return failure();
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
}
