import { z } from "zod";

import type { EventEnvelopeV1 } from "../../domain/events/index.js";
import {
  domainError,
  err,
  instantFromDate,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { sha256Digest } from "../../domain/review/index.js";
import type { WebhookReconcileProvider } from "./webhook-model.js";

const maximumProviderEventIdLength = 480;
const resourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/u;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const shaPattern = /^[0-9a-f]{40}$/iu;
const providerEventIdPattern =
  /^provider-revision:v1:(github|linear):(pull_request|issue):([A-Za-z0-9_-]{2,340}):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):([0-9a-f]{64})$/u;

export type ProviderRevisionResourceType = "pull_request" | "issue";

export interface ProviderRevisionIdentity {
  readonly providerEventId: string;
  readonly provider: WebhookReconcileProvider;
  readonly resourceType: ProviderRevisionResourceType;
  readonly resourceId: string;
  readonly updatedAt: Instant;
  readonly contentDigest: string;
}

export interface GitHubPullRequestRevision {
  readonly providerEventId: string;
  readonly repository: string;
  readonly nodeId: string;
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly closedAt?: Instant;
  readonly mergedAt?: Instant;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface LinearIssueRevision {
  readonly providerEventId: string;
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number;
  readonly updatedAt: Instant;
  readonly teamId: string;
  readonly projectId: string;
  readonly stateId: string;
}

const githubPullRequestRevisionInputSchema = z
  .object({
    repository: z.string().min(3).max(140).regex(repositoryPattern),
    nodeId: z.string().min(1).max(255).regex(resourceIdPattern),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(["open", "closed", "merged"]),
    draft: z.boolean(),
    createdAt: z.string().min(1).max(128),
    updatedAt: z.string().min(1).max(128),
    closedAt: z.string().min(1).max(128).nullable(),
    mergedAt: z.string().min(1).max(128).nullable(),
    baseSha: z.string().regex(shaPattern),
    headSha: z.string().regex(shaPattern),
  })
  .strict();

const linearIssueRevisionInputSchema = z
  .object({
    id: z.string().trim().min(1).max(255).regex(resourceIdPattern),
    identifier: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(255),
    description: z.string().max(100_000).nullable(),
    priority: z.number().int(),
    updatedAt: z.string().trim().min(1).max(128),
    teamId: z.string().trim().min(1).max(255),
    projectId: z.string().trim().min(1).max(255),
    stateId: z.string().trim().min(1).max(255),
  })
  .strict();

function failure<Value>(): Result<Value, DomainError> {
  return err(domainError("invariant_violation"));
}

function canonicalInstant(value: string): Result<Instant, DomainError> {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return failure();
  const canonical = instantFromDate(date);
  return canonical.ok ? canonical : failure();
}

function validResourcePair(
  provider: WebhookReconcileProvider,
  resourceType: ProviderRevisionResourceType,
): boolean {
  return (
    (provider === "github" && resourceType === "pull_request") ||
    (provider === "linear" && resourceType === "issue")
  );
}

export function createProviderRevisionIdentity(input: {
  readonly provider: WebhookReconcileProvider;
  readonly resourceType: ProviderRevisionResourceType;
  readonly resourceId: string;
  readonly updatedAt: Instant;
  readonly authoritativeContent: unknown;
}): Result<ProviderRevisionIdentity, DomainError> {
  if (
    !validResourcePair(input.provider, input.resourceType) ||
    !resourceIdPattern.test(input.resourceId) ||
    !parseInstant(input.updatedAt).ok
  ) {
    return failure();
  }
  const digest = sha256Digest(input.authoritativeContent);
  if (!digest.ok) return digest;
  const encodedResourceId = Buffer.from(input.resourceId, "utf8").toString("base64url");
  const providerEventId = `provider-revision:v1:${input.provider}:${input.resourceType}:${encodedResourceId}:${input.updatedAt}:${digest.value}`;
  if (providerEventId.length > maximumProviderEventIdLength) return failure();
  return ok(
    Object.freeze({
      providerEventId,
      provider: input.provider,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      updatedAt: input.updatedAt,
      contentDigest: digest.value,
    }),
  );
}

export function parseProviderRevisionIdentity(
  value: unknown,
): ProviderRevisionIdentity | undefined {
  if (typeof value !== "string" || value.length > maximumProviderEventIdLength) return undefined;
  const match = providerEventIdPattern.exec(value);
  if (match === null) return undefined;
  const provider = match[1] as WebhookReconcileProvider;
  const resourceType = match[2] as ProviderRevisionResourceType;
  const encodedResourceId = match[3];
  const updatedAt = match[4];
  const contentDigest = match[5];
  if (
    encodedResourceId === undefined ||
    updatedAt === undefined ||
    contentDigest === undefined ||
    !validResourcePair(provider, resourceType)
  ) {
    return undefined;
  }
  const resourceId = Buffer.from(encodedResourceId, "base64url").toString("utf8");
  if (
    !resourceIdPattern.test(resourceId) ||
    Buffer.from(resourceId, "utf8").toString("base64url") !== encodedResourceId ||
    !parseInstant(updatedAt).ok
  ) {
    return undefined;
  }
  return Object.freeze({
    providerEventId: value,
    provider,
    resourceType,
    resourceId,
    updatedAt: updatedAt as Instant,
    contentDigest,
  });
}

export function semanticProviderRevisionKey(event: EventEnvelopeV1): string | undefined {
  if (
    event.source.kind !== "external" ||
    typeof event.payload !== "object" ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return undefined;
  }
  const parsed = parseProviderRevisionIdentity(
    (event.payload as Readonly<Record<string, unknown>>)["providerEventId"],
  );
  return parsed?.provider === event.source.provider &&
    event.eventType === `${parsed.provider}.${parsed.resourceType}`
    ? JSON.stringify([parsed.provider, parsed.providerEventId])
    : undefined;
}

export function normalizeGitHubPullRequestRevision(
  input: unknown,
): Result<GitHubPullRequestRevision, DomainError> {
  const parsed = githubPullRequestRevisionInputSchema.safeParse(input);
  if (!parsed.success) return failure();
  const createdAt = canonicalInstant(parsed.data.createdAt);
  const updatedAt = canonicalInstant(parsed.data.updatedAt);
  const closedAt =
    parsed.data.closedAt === null ? ok(undefined) : canonicalInstant(parsed.data.closedAt);
  const mergedAt =
    parsed.data.mergedAt === null ? ok(undefined) : canonicalInstant(parsed.data.mergedAt);
  if (!createdAt.ok || !updatedAt.ok || !closedAt.ok || !mergedAt.ok) return failure();
  if (
    createdAt.value > updatedAt.value ||
    (parsed.data.state === "merged" && mergedAt.value === undefined)
  ) {
    return failure();
  }
  const content = Object.freeze({
    repository: parsed.data.repository.toLowerCase(),
    nodeId: parsed.data.nodeId,
    number: parsed.data.number,
    state: parsed.data.state,
    draft: parsed.data.draft,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    ...(closedAt.value === undefined ? {} : { closedAt: closedAt.value }),
    ...(mergedAt.value === undefined ? {} : { mergedAt: mergedAt.value }),
    baseSha: parsed.data.baseSha.toLowerCase(),
    headSha: parsed.data.headSha.toLowerCase(),
  });
  const identity = createProviderRevisionIdentity({
    provider: "github",
    resourceType: "pull_request",
    resourceId: content.nodeId,
    updatedAt: content.updatedAt,
    authoritativeContent: content,
  });
  return identity.ok
    ? ok(Object.freeze({ providerEventId: identity.value.providerEventId, ...content }))
    : identity;
}

export function normalizeLinearIssueRevision(
  input: unknown,
): Result<LinearIssueRevision, DomainError> {
  const parsed = linearIssueRevisionInputSchema.safeParse(input);
  if (!parsed.success) return failure();
  const updatedAt = canonicalInstant(parsed.data.updatedAt);
  if (!updatedAt.ok) return updatedAt;
  const content = Object.freeze({
    id: parsed.data.id,
    identifier: parsed.data.identifier,
    title: parsed.data.title,
    description: parsed.data.description,
    priority: parsed.data.priority,
    updatedAt: updatedAt.value,
    teamId: parsed.data.teamId,
    projectId: parsed.data.projectId,
    stateId: parsed.data.stateId,
  });
  const identity = createProviderRevisionIdentity({
    provider: "linear",
    resourceType: "issue",
    resourceId: content.id,
    updatedAt: content.updatedAt,
    authoritativeContent: content,
  });
  return identity.ok
    ? ok(Object.freeze({ providerEventId: identity.value.providerEventId, ...content }))
    : identity;
}
