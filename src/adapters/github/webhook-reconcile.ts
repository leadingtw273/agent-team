import { z } from "zod";

import type { ReadOptions } from "../../application/ports/common.js";
import type {
  WebhookReadBackChange,
  WebhookReadBackPort,
  WebhookReadBackRequest,
} from "../../application/reconcile/webhook-model.js";
import {
  normalizeGitHubPullRequestRevision,
  type GitHubPullRequestRevision,
} from "../../application/reconcile/provider-revision.js";
import {
  domainError,
  err,
  instantFromDate,
  ok,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { projectSchema } from "../../domain/project/index.js";
import type { GhJsonTransport } from "./adapter.js";
import { GhTransport } from "./transport.js";

const defaultPerPage = 100;
const defaultMaxPages = 100;
const maximumPerPage = 100;
const maximumMaxPages = 1_000;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const shaPattern = /^[0-9a-f]{40}$/iu;
const providerTimestampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u;

const projectedPullRequestSchema = z
  .object({
    nodeId: z.string().min(1).max(255).regex(/^\S+$/u),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(["open", "closed", "merged"]),
    draft: z.boolean(),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
    closedAt: z.string().min(1).max(64).nullable(),
    mergedAt: z.string().min(1).max(64).nullable(),
    baseSha: z.string().regex(shaPattern),
    headSha: z.string().regex(shaPattern),
  })
  .strict();

const pullRequestPageProjection =
  '[.[] | {nodeId:.node_id,number,state:(if .merged_at != null then "merged" else .state end),draft,createdAt:.created_at,updatedAt:.updated_at,closedAt:.closed_at,mergedAt:.merged_at,baseSha:.base.sha,headSha:.head.sha}]';

export interface GitHubWebhookReadBackAdapterOptions {
  /** GitHub REST permits at most 100 results per page. */
  readonly perPage?: number;
  /** A hard cap avoids returning a partial window when a repository is unexpectedly large. */
  readonly maxPages?: number;
}

function failure<Value>(
  code: DomainError["code"] = "external_failure",
): Result<Value, DomainError> {
  return err(domainError(code));
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : fallback;
}

function validRepository(repository: string): boolean {
  const parts = repository.split("/");
  return (
    repositoryPattern.test(repository) &&
    parts.length === 2 &&
    parts.every((part) => part !== "." && part !== "..")
  );
}

function repositoryPath(repository: string): string {
  return repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function providerInstant(value: string): Result<Instant, DomainError> {
  const match = providerTimestampPattern.exec(value);
  const base = match?.[1];
  if (match === null || base === undefined) return failure();
  const fraction = match[2] === undefined ? "000" : match[2].padEnd(3, "0");
  const normalized = `${base}.${fraction}Z`;
  const parsed = instantFromDate(new Date(normalized));
  return parsed.ok && parsed.value === normalized ? ok(parsed.value) : failure();
}

function revisionFromProjection(
  repository: string,
  value: z.infer<typeof projectedPullRequestSchema>,
): Result<GitHubPullRequestRevision, DomainError> {
  return normalizeGitHubPullRequestRevision({ repository, ...value });
}

function changeFromRevision(
  repository: string,
  revision: GitHubPullRequestRevision,
): WebhookReadBackChange {
  const pullRequest = Object.freeze({
    nodeId: revision.nodeId,
    number: revision.number,
    state: revision.state,
    draft: revision.draft,
    createdAt: revision.createdAt,
    updatedAt: revision.updatedAt,
    ...(revision.closedAt === undefined ? {} : { closedAt: revision.closedAt }),
    ...(revision.mergedAt === undefined ? {} : { mergedAt: revision.mergedAt }),
    baseSha: revision.baseSha,
    headSha: revision.headSha,
  });
  return Object.freeze({
    providerEventId: revision.providerEventId,
    eventType: "pull_request",
    occurredAt: revision.updatedAt,
    streamKey: `github:repository:${repository}:pull_request:${String(revision.number)}`,
    payload: Object.freeze({
      providerEventId: revision.providerEventId,
      authoritative: true,
      providerEventType: "pull_request",
      snapshot: Object.freeze({ provider: "github", repository, pullRequest }),
    }),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareChanges(left: WebhookReadBackChange, right: WebhookReadBackChange): number {
  return (
    compareText(left.occurredAt, right.occurredAt) ||
    compareText(left.providerEventId, right.providerEventId)
  );
}

function sameChange(left: WebhookReadBackChange, right: WebhookReadBackChange): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isAborted(options: ReadOptions): boolean {
  return options.signal?.aborted === true;
}

export class GitHubWebhookReadBackAdapter implements WebhookReadBackPort {
  readonly #perPage: number;
  readonly #maxPages: number;

  constructor(
    readonly transport: GhJsonTransport = new GhTransport(),
    options: GitHubWebhookReadBackAdapterOptions = {},
  ) {
    this.#perPage = boundedPositiveInteger(options.perPage, defaultPerPage, maximumPerPage);
    this.#maxPages = boundedPositiveInteger(options.maxPages, defaultMaxPages, maximumMaxPages);
  }

  async readChanges(
    request: WebhookReadBackRequest,
    options: ReadOptions = {},
  ): Promise<Result<readonly WebhookReadBackChange[], DomainError>> {
    const project = projectSchema.safeParse(request.project);
    if (
      request.provider !== "github" ||
      !project.success ||
      project.data.sourceControl.provider !== "github"
    ) {
      return failure("invariant_violation");
    }
    if (isAborted(options)) return failure("interrupted");
    const fromInclusive = providerInstant(request.fromInclusive);
    const throughInclusive = providerInstant(request.throughInclusive);
    const repository = project.data.sourceControl.repository;
    if (
      !fromInclusive.ok ||
      !throughInclusive.ok ||
      fromInclusive.value > throughInclusive.value ||
      !validRepository(repository)
    ) {
      return failure("invariant_violation");
    }

    const pageSchema = z.array(projectedPullRequestSchema).max(this.#perPage);
    const changesByProviderEventId = new Map<string, WebhookReadBackChange>();
    const revisionsByNodeId = new Map<string, string>();
    let previousUpdatedAt: Instant | undefined;
    const path = repositoryPath(repository);

    for (let page = 1; page <= this.#maxPages; page += 1) {
      if (isAborted(options)) return failure("interrupted");
      const result = await this.transport.requestJson(
        [
          "api",
          `repos/${path}/pulls?state=all&sort=updated&direction=desc&per_page=${String(this.#perPage)}&page=${String(page)}`,
          "--method",
          "GET",
          "--jq",
          pullRequestPageProjection,
        ],
        pageSchema,
        options,
      );
      if (!result.ok) return result;
      const parsedPage = pageSchema.safeParse(result.value);
      if (!parsedPage.success) return failure();

      let oldestUpdatedAt: Instant | undefined;
      for (const value of parsedPage.data) {
        const revision = revisionFromProjection(repository, value);
        if (!revision.ok) return revision;
        if (previousUpdatedAt !== undefined && revision.value.updatedAt > previousUpdatedAt) {
          return failure();
        }
        previousUpdatedAt = revision.value.updatedAt;
        oldestUpdatedAt = revision.value.updatedAt;
        if (
          revision.value.updatedAt < fromInclusive.value ||
          revision.value.updatedAt > throughInclusive.value
        ) {
          continue;
        }
        const change = changeFromRevision(repository, revision.value);
        const previousRevision = revisionsByNodeId.get(revision.value.nodeId);
        if (previousRevision !== undefined && previousRevision !== change.providerEventId) {
          return failure();
        }
        revisionsByNodeId.set(revision.value.nodeId, change.providerEventId);
        const previousChange = changesByProviderEventId.get(change.providerEventId);
        if (previousChange !== undefined && !sameChange(previousChange, change)) return failure();
        changesByProviderEventId.set(change.providerEventId, change);
      }

      if (isAborted(options)) return failure("interrupted");
      const safelyPastWindow =
        oldestUpdatedAt !== undefined && oldestUpdatedAt < fromInclusive.value;
      if (parsedPage.data.length < this.#perPage || safelyPastWindow) {
        return ok(Object.freeze([...changesByProviderEventId.values()].sort(compareChanges)));
      }
    }

    return failure();
  }
}
