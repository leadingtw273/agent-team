import { createHash, createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { z } from "zod";

import type { Clock, DomainError, Result } from "../../domain/foundation/index.js";
import { domainError, err, ok } from "../../domain/foundation/index.js";
import type { InboxRecord } from "../../infrastructure/events/index.js";

const maximumResponseBytes = 64 * 1024;
const defaultTimeoutMs = 5_000;
const defaultMaximumLatencyMs = 2_000;
const deliveryPattern = /^(?:\S|\S[\s\S]*\S)$/u;
const responseSchema = z.looseObject({
  accepted: z.literal(true),
  statusCode: z.literal(200),
  provider: z.enum(["github", "linear"]),
  deliveryId: z.string(),
  eventType: z.string(),
  inboxSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type WebhookRuntimeProvider = "github" | "linear";

export interface WebhookRuntimeRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
}

export interface WebhookRuntimeResponse {
  readonly statusCode: number;
  readonly body: Uint8Array;
  readonly elapsedMs: number;
}

export interface WebhookRuntimeTransport {
  post(request: WebhookRuntimeRequest): Promise<Result<WebhookRuntimeResponse, DomainError>>;
}

export interface WebhookRuntimeProbeInbox {
  read(
    provider: WebhookRuntimeProvider,
    deliveryId: string,
  ): Promise<Result<InboxRecord, DomainError>>;
}

export interface WebhookRuntimeProbeRequest {
  readonly baseUrl: string;
  readonly provider: WebhookRuntimeProvider;
  readonly secret: Uint8Array;
  readonly timeoutMs?: number;
  readonly maximumLatencyMs?: number;
}

export type WebhookRuntimeProbeFailureReason =
  | "invalid_request"
  | "transport_failed"
  | "response_too_slow"
  | "runtime_rejected"
  | "response_mismatch"
  | "inbox_missing"
  | "inbox_mismatch";

export type WebhookRuntimeProbeOutcome =
  | Readonly<{
      state: "verified";
      provider: WebhookRuntimeProvider;
      endpoint: string;
      deliveryId: string;
      latencyMs: number;
      inboxSha256: string;
    }>
  | Readonly<{
      state: "failed";
      reason: WebhookRuntimeProbeFailureReason;
      statusCode?: number;
      latencyMs?: number;
      error?: DomainError;
    }>;

function allowedBaseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

export class NodeWebhookRuntimeTransport implements WebhookRuntimeTransport {
  constructor(readMonotonicMs: () => number = () => performance.now()) {
    this.readMonotonicMs = readMonotonicMs;
  }

  readonly readMonotonicMs: () => number;

  async post(request: WebhookRuntimeRequest): Promise<Result<WebhookRuntimeResponse, DomainError>> {
    return new Promise((resolve) => {
      const url = new URL(request.url);
      const performRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
      const startedAt = this.readMonotonicMs();
      let settled = false;
      const deadline: { timer?: NodeJS.Timeout } = {};
      const settle = (result: Result<WebhookRuntimeResponse, DomainError>): void => {
        if (settled) return;
        settled = true;
        if (deadline.timer !== undefined) clearTimeout(deadline.timer);
        resolve(result);
      };
      const clientRequest = performRequest(
        url,
        {
          method: "POST",
          headers: {
            ...request.headers,
            "content-length": request.body.byteLength.toString(),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > maximumResponseBytes) {
              response.destroy();
              settle(err(domainError("external_failure")));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.on("end", () => {
            settle(
              ok(
                Object.freeze({
                  statusCode: response.statusCode ?? 0,
                  body: Uint8Array.from(Buffer.concat(chunks)),
                  elapsedMs: Math.max(0, this.readMonotonicMs() - startedAt),
                }),
              ),
            );
          });
          response.on("error", () => {
            settle(err(domainError("unavailable")));
          });
        },
      );
      deadline.timer = setTimeout(() => {
        clientRequest.destroy();
        settle(err(domainError("timeout")));
      }, request.timeoutMs);
      deadline.timer.unref();
      clientRequest.on("error", () => {
        settle(err(domainError("unavailable")));
      });
      clientRequest.end(Buffer.from(request.body));
    });
  }
}

function probePayload(provider: WebhookRuntimeProvider, deliveryId: string, timestampMs: number) {
  return provider === "github"
    ? { agentTeamProbe: true, repository: { id: deliveryId } }
    : {
        action: "update",
        type: "AgentTeamProbe",
        webhookTimestamp: timestampMs,
        data: { id: deliveryId },
      };
}

function probeHeaders(
  provider: WebhookRuntimeProvider,
  deliveryId: string,
  secret: Uint8Array,
  body: Uint8Array,
): Readonly<Record<string, string>> {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return provider === "github"
    ? Object.freeze({
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${digest}`,
        "x-github-delivery": deliveryId,
        "x-github-event": "agent_team_probe",
      })
    : Object.freeze({
        "content-type": "application/json",
        "linear-signature": digest,
        "linear-delivery": deliveryId,
        "linear-event": "agent_team_probe",
      });
}

function failed(
  reason: WebhookRuntimeProbeFailureReason,
  details: Omit<Extract<WebhookRuntimeProbeOutcome, { state: "failed" }>, "state" | "reason"> = {},
): WebhookRuntimeProbeOutcome {
  return Object.freeze({ state: "failed", reason, ...details });
}

export class WebhookRuntimeProbeClient {
  constructor(
    readonly transport: WebhookRuntimeTransport,
    readonly inbox: WebhookRuntimeProbeInbox,
    readonly clock: Clock,
    readonly createDeliveryId: () => string,
  ) {}

  async run(request: WebhookRuntimeProbeRequest): Promise<WebhookRuntimeProbeOutcome> {
    const baseUrl = allowedBaseUrl(request.baseUrl);
    const deliveryId = this.createDeliveryId();
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    const maximumLatencyMs = request.maximumLatencyMs ?? defaultMaximumLatencyMs;
    if (
      baseUrl === undefined ||
      request.secret.byteLength === 0 ||
      request.secret.byteLength > 65_536 ||
      deliveryId.length === 0 ||
      deliveryId.length > 512 ||
      !deliveryPattern.test(deliveryId) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30_000 ||
      !Number.isSafeInteger(maximumLatencyMs) ||
      maximumLatencyMs <= 0 ||
      maximumLatencyMs > timeoutMs
    ) {
      return failed("invalid_request");
    }
    const endpoint = new URL(`/webhooks/${request.provider}`, baseUrl).toString();
    const timestampMs = Date.parse(this.clock.now());
    const rawBody = Buffer.from(
      JSON.stringify(probePayload(request.provider, deliveryId, timestampMs)),
      "utf8",
    );
    const response = await this.transport.post({
      url: endpoint,
      headers: probeHeaders(request.provider, deliveryId, request.secret, rawBody),
      body: rawBody,
      timeoutMs,
    });
    if (!response.ok) return failed("transport_failed", { error: response.error });
    if (!Number.isFinite(response.value.elapsedMs) || response.value.elapsedMs < 0) {
      return failed("response_mismatch");
    }
    if (response.value.elapsedMs > maximumLatencyMs) {
      return failed("response_too_slow", { latencyMs: response.value.elapsedMs });
    }
    if (response.value.statusCode !== 200) {
      return failed("runtime_rejected", {
        statusCode: response.value.statusCode,
        latencyMs: response.value.elapsedMs,
      });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.value.body));
    } catch {
      return failed("response_mismatch", { latencyMs: response.value.elapsedMs });
    }
    const parsedResponse = responseSchema.safeParse(decoded);
    const expectedSha256 = createHash("sha256").update(rawBody).digest("hex");
    if (
      !parsedResponse.success ||
      parsedResponse.data.provider !== request.provider ||
      parsedResponse.data.deliveryId !== deliveryId ||
      parsedResponse.data.eventType !== "agent_team_probe" ||
      parsedResponse.data.inboxSha256 !== expectedSha256
    ) {
      return failed("response_mismatch", { latencyMs: response.value.elapsedMs });
    }
    const readBack = await this.inbox.read(request.provider, deliveryId);
    if (!readBack.ok) return failed("inbox_missing", { error: readBack.error });
    if (
      readBack.value.schemaVersion !== 2 ||
      readBack.value.eventType !== "agent_team_probe" ||
      readBack.value.streamKey !== deliveryId ||
      readBack.value.sha256 !== expectedSha256 ||
      !Buffer.from(readBack.value.bodyBase64, "base64").equals(rawBody)
    ) {
      return failed("inbox_mismatch");
    }
    return Object.freeze({
      state: "verified",
      provider: request.provider,
      endpoint,
      deliveryId,
      latencyMs: response.value.elapsedMs,
      inboxSha256: expectedSha256,
    });
  }
}
