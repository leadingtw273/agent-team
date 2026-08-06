import { createHash } from "node:crypto";

import type {
  ReadOptions,
  RegistrationProbeProviderEventCriteria,
  RegistrationProbeProviderEventPort,
} from "../../application/ports/index.js";
import type { RegistrationProbeProviderEventEvidence } from "../../application/registration/proactive-probe-model.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { DurableInbox, InboxRecordV2 } from "../../infrastructure/events/index.js";

function nestedValue(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

function decodeJsonObject(rawBody: Buffer): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(rawBody.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Matches a genuine `pull_request` delivery: the caller's `remoteObjectId` is the Draft PR
 * *number* (never the opaque GitHub database ID also present in the payload), and, when supplied,
 * `headSha` must equal `pull_request.head.sha` exactly.
 */
function githubMatch(
  payload: Readonly<Record<string, unknown>>,
  criteria: RegistrationProbeProviderEventCriteria,
): boolean {
  const pullRequest = nestedValue(payload, "pull_request");
  const number = nestedValue(pullRequest, "number");
  if (typeof number !== "number" || !Number.isSafeInteger(number)) return false;
  if (String(number) !== criteria.remoteObjectId) return false;
  if (criteria.headSha === undefined) return true;
  const head = nestedValue(pullRequest, "head");
  const sha = nestedValue(head, "sha");
  return typeof sha === "string" && sha.toLowerCase() === criteria.headSha.toLowerCase();
}

/** Matches a genuine Linear `Issue` delivery by its `data.id` (the Linear issue UUID). */
function linearMatch(
  payload: Readonly<Record<string, unknown>>,
  criteria: RegistrationProbeProviderEventCriteria,
): boolean {
  const data = nestedValue(payload, "data");
  const id = nestedValue(data, "id");
  return typeof id === "string" && id === criteria.remoteObjectId;
}

/**
 * Reads only durable Inbox records that a real Webhook Runtime delivery stored -- never a
 * synthetic W004 probe delivery (those always carry `eventType: "agent_team_probe"`, which this
 * adapter explicitly excludes) and never a polling read-back standing in for a genuine push.
 */
export class RegistrationProbeProviderEventAdapter implements RegistrationProbeProviderEventPort {
  readonly #inbox: Pick<DurableInbox, "list">;

  constructor(inbox: Pick<DurableInbox, "list">) {
    this.#inbox = inbox;
  }

  async findProviderEvent(
    criteria: RegistrationProbeProviderEventCriteria,
    options: ReadOptions = {},
  ): Promise<Result<RegistrationProbeProviderEventEvidence | undefined, DomainError>> {
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    const records = await this.#inbox.list();
    if (!records.ok) return records;

    for (const record of records.value) {
      if (record.provider !== criteria.provider) continue;
      if (record.eventType === "agent_team_probe") continue;
      const rawBody = Buffer.from(record.bodyBase64, "base64");
      const payload = decodeJsonObject(rawBody);
      if (payload === undefined) continue;
      const matched =
        criteria.provider === "github"
          ? githubMatch(payload, criteria)
          : linearMatch(payload, criteria);
      if (!matched) continue;
      const evidence = this.#evidenceFrom(record, rawBody);
      if (evidence !== undefined) return ok(evidence);
    }
    return ok(undefined);
  }

  #evidenceFrom(
    record: InboxRecordV2,
    rawBody: Buffer,
  ): RegistrationProbeProviderEventEvidence | undefined {
    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
    if (payloadSha256 !== record.sha256) return undefined;
    const payload = decodeJsonObject(rawBody);
    if (payload === undefined) return undefined;
    const provider = record.provider;
    const rawRemoteObjectId =
      provider === "github"
        ? nestedValue(nestedValue(payload, "pull_request"), "number")
        : nestedValue(nestedValue(payload, "data"), "id");
    const remoteObjectId =
      typeof rawRemoteObjectId === "number"
        ? String(rawRemoteObjectId)
        : typeof rawRemoteObjectId === "string"
          ? rawRemoteObjectId
          : "";
    if (remoteObjectId.length === 0) return undefined;
    const headShaValue =
      provider === "github"
        ? nestedValue(nestedValue(nestedValue(payload, "pull_request"), "head"), "sha")
        : undefined;
    const headSha = typeof headShaValue === "string" ? headShaValue.toLowerCase() : undefined;
    return Object.freeze({
      provider,
      deliveryId: record.deliveryId,
      eventType: record.eventType,
      remoteObjectId,
      ...(headSha === undefined ? {} : { headSha }),
      payloadSha256,
      streamKey: record.streamKey,
    });
  }
}
