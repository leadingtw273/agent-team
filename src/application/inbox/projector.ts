import { createHash } from "node:crypto";

import { z } from "zod";

import { eventEnvelopeV1Schema } from "../../domain/events/index.js";
import {
  canonicalInstantPattern,
  domainError,
  err,
  instantFromDate,
  generateDeterministicIdentifier,
  ok,
  parseInstant,
  type Instant,
} from "../../domain/foundation/index.js";
import type { InboxDelivery, InboxProjectionResult } from "./model.js";
import {
  normalizeGitHubPullRequestRevision,
  normalizeLinearIssueRevision,
} from "../reconcile/provider-revision.js";

const eventTypePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const boundedIdentifierPattern = /^(?:\S|\S[\s\S]*\S)$/u;
const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;
const inboxDeliverySchema = z
  .object({
    schemaVersion: z.literal(2),
    provider: z.enum(["github", "linear"]),
    deliveryId: z.string().min(1).max(512).regex(boundedIdentifierPattern),
    eventType: z.string().regex(eventTypePattern),
    streamKey: z.string().min(1).max(512).regex(boundedIdentifierPattern),
    sourceTimestampMs: z.number().int(),
    receivedAt: instantSchema,
    mediaType: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bodyBase64: z.string().max(32 * 1024 * 1024),
  })
  .strict() as unknown as z.ZodType<InboxDelivery>;

function decodeBody(delivery: InboxDelivery): Readonly<Record<string, unknown>> | undefined {
  const body = Buffer.from(delivery.bodyBase64, "base64");
  if (
    body.toString("base64") !== delivery.bodyBase64 ||
    createHash("sha256").update(body).digest("hex") !== delivery.sha256
  ) {
    return undefined;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed = JSON.parse(decoded) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function githubProviderEventId(body: Readonly<Record<string, unknown>>): string | undefined {
  const pullRequest = record(body["pull_request"]);
  const repository = record(body["repository"]);
  const base = record(pullRequest?.["base"]);
  const head = record(pullRequest?.["head"]);
  if (pullRequest === undefined || repository === undefined) return undefined;
  const mergedAt = pullRequest["merged_at"];
  const state =
    mergedAt !== null || pullRequest["merged"] === true ? "merged" : pullRequest["state"];
  const normalized = normalizeGitHubPullRequestRevision({
    repository: repository["full_name"],
    nodeId: pullRequest["node_id"],
    number: pullRequest["number"],
    state,
    draft: pullRequest["draft"],
    createdAt: pullRequest["created_at"],
    updatedAt: pullRequest["updated_at"],
    closedAt: pullRequest["closed_at"],
    mergedAt,
    baseSha: base?.["sha"],
    headSha: head?.["sha"],
  });
  return normalized.ok ? normalized.value.providerEventId : undefined;
}

function linearProviderEventId(body: Readonly<Record<string, unknown>>): string | undefined {
  if (body["type"] !== "Issue") return undefined;
  const data = record(body["data"]);
  if (data === undefined) return undefined;
  const normalized = normalizeLinearIssueRevision({
    id: data["id"],
    identifier: data["identifier"],
    title: data["title"],
    description: data["description"],
    priority: data["priority"],
    updatedAt: data["updatedAt"],
    teamId: data["teamId"],
    projectId: data["projectId"],
    stateId: data["stateId"],
  });
  return normalized.ok ? normalized.value.providerEventId : undefined;
}

function providerEventId(
  delivery: InboxDelivery,
  body: Readonly<Record<string, unknown>>,
): string | undefined {
  if (delivery.provider === "github") {
    return delivery.eventType === "pull_request" ? githubProviderEventId(body) : undefined;
  }
  return delivery.eventType === "Issue" ? linearProviderEventId(body) : undefined;
}

export function projectInboxDelivery(input: unknown): InboxProjectionResult {
  const parsed = inboxDeliverySchema.safeParse(input);
  if (!parsed.success) return err(domainError("invariant_violation"));
  const delivery = parsed.data;
  const body = decodeBody(delivery);
  if (body === undefined) return err(domainError("invariant_violation"));
  const eventId = generateDeterministicIdentifier(
    "event",
    JSON.stringify([delivery.provider, delivery.deliveryId]),
  );
  const occurredAt = instantFromDate(new Date(delivery.sourceTimestampMs));
  if (!eventId.ok || !occurredAt.ok) return err(domainError("invariant_violation"));
  const revisionIdentity = providerEventId(delivery, body);

  const event = eventEnvelopeV1Schema.safeParse({
    schemaVersion: 1,
    eventId: eventId.value,
    eventType: `${delivery.provider}.${delivery.eventType.toLowerCase()}`,
    occurredAt: occurredAt.value,
    recordedAt: delivery.receivedAt,
    source: {
      kind: "external",
      provider: delivery.provider,
      deliveryId: delivery.deliveryId,
    },
    subject: { kind: "webhook", id: delivery.streamKey },
    correlationId: delivery.streamKey,
    payload: {
      providerEventType: delivery.eventType,
      ...(revisionIdentity === undefined ? {} : { providerEventId: revisionIdentity }),
      body,
    },
  });
  return event.success ? ok(event.data) : err(domainError("invariant_violation"));
}
