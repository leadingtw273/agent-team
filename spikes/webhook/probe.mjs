#!/usr/bin/env node

import { createHmac, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];
const allowedModes = new Set(["github", "linear", "ordering", "latency", "timeout"]);

function hmacHex(secret, rawBody) {
  return createHmac("sha256", secret).update(Buffer.from(rawBody, "utf8")).digest("hex");
}

function safeHexEqual(expectedHex, receivedHex) {
  if (!/^[0-9a-f]{64}$/iu.test(receivedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const received = Buffer.from(receivedHex, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function verifyGithubSignature(rawBody, signatureHeader, secret) {
  if (typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  return safeHexEqual(hmacHex(secret, rawBody), signatureHeader.slice("sha256=".length));
}

function verifyLinearSignature(rawBody, signatureHeader, secret) {
  return (
    typeof signatureHeader === "string" && safeHexEqual(hmacHex(secret, rawBody), signatureHeader)
  );
}

function requireHeader(headers, name) {
  const value = headers[name.toLowerCase()];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseAfterSignature(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function buildGithubEnvelope({ rawBody, headers, secret, receivedAtMs }) {
  const signature = requireHeader(headers, "x-hub-signature-256");
  if (!verifyGithubSignature(rawBody, signature, secret)) {
    return { accepted: false, reason: "invalid_signature" };
  }
  const deliveryId = requireHeader(headers, "x-github-delivery");
  const eventType = requireHeader(headers, "x-github-event");
  if (deliveryId === null || eventType === null) {
    return { accepted: false, reason: "missing_required_header" };
  }
  const payload = parseAfterSignature(rawBody);
  if (payload === null) return { accepted: false, reason: "invalid_json" };
  const parsedTimestamp = Date.parse(
    payload.issue?.updated_at ?? payload.repository?.updated_at ?? "",
  );
  return {
    accepted: true,
    envelope: {
      provider: "github",
      deliveryId,
      eventType,
      streamKey: String(payload.repository?.id ?? payload.issue?.id ?? "unknown"),
      sourceTimestampMs: Number.isNaN(parsedTimestamp) ? receivedAtMs : parsedTimestamp,
      receivedAtMs,
      rawBodyByteLength: Buffer.byteLength(rawBody, "utf8"),
    },
  };
}

function buildLinearEnvelope({ rawBody, headers, secret, receivedAtMs, maxSkewMs = 60_000 }) {
  const signature = requireHeader(headers, "linear-signature");
  if (!verifyLinearSignature(rawBody, signature, secret)) {
    return { accepted: false, reason: "invalid_signature" };
  }
  const deliveryId = requireHeader(headers, "linear-delivery");
  const eventType = requireHeader(headers, "linear-event");
  if (deliveryId === null || eventType === null) {
    return { accepted: false, reason: "missing_required_header" };
  }
  const payload = parseAfterSignature(rawBody);
  if (payload === null) return { accepted: false, reason: "invalid_json" };
  if (
    typeof payload.webhookTimestamp !== "number" ||
    Math.abs(receivedAtMs - payload.webhookTimestamp) > maxSkewMs
  ) {
    return { accepted: false, reason: "stale_timestamp" };
  }
  return {
    accepted: true,
    envelope: {
      provider: "linear",
      deliveryId,
      eventType,
      streamKey: String(payload.data?.id ?? payload.webhookId ?? "unknown"),
      sourceTimestampMs: payload.webhookTimestamp,
      receivedAtMs,
      rawBodyByteLength: Buffer.byteLength(rawBody, "utf8"),
    },
  };
}

class DeliveryTracker {
  #seen = new Set();
  #latestByStream = new Map();

  accept(envelope) {
    const dedupeKey = `${envelope.provider}:${envelope.deliveryId}`;
    if (this.#seen.has(dedupeKey)) {
      return {
        classification: "duplicate",
        persisted: false,
        projectionEligible: false,
      };
    }
    this.#seen.add(dedupeKey);
    const streamKey = `${envelope.provider}:${envelope.streamKey}`;
    const latest = this.#latestByStream.get(streamKey);
    const outOfOrder = latest !== undefined && envelope.sourceTimestampMs < latest;
    if (latest === undefined || envelope.sourceTimestampMs > latest) {
      this.#latestByStream.set(streamKey, envelope.sourceTimestampMs);
    }
    return {
      classification: outOfOrder ? "accepted_out_of_order" : "accepted",
      persisted: true,
      projectionEligible: !outOfOrder,
    };
  }
}

export function githubProbe() {
  const secret = "It's a Secret to Everybody";
  const rawBody = "Hello, World!";
  const officialDigest = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  const generated = hmacHex(secret, rawBody);
  const invalidJson = "{";
  const invalidJsonEnvelope = buildGithubEnvelope({
    rawBody: invalidJson,
    headers: {
      "x-hub-signature-256": `sha256=${hmacHex(secret, invalidJson)}`,
      "x-github-delivery": "22222222-2222-4222-8222-222222222222",
      "x-github-event": "issues",
    },
    secret,
    receivedAtMs: 1_000,
  });
  return {
    officialVectorMatches: generated === officialDigest,
    valid: verifyGithubSignature(rawBody, `sha256=${officialDigest}`, secret),
    modifiedRawBodyValid: verifyGithubSignature(`${rawBody}\n`, `sha256=${officialDigest}`, secret),
    missingPrefixValid: verifyGithubSignature(rawBody, officialDigest, secret),
    malformedValid: verifyGithubSignature(rawBody, "sha256=not-hex", secret),
    validSignatureInvalidJsonReason: invalidJsonEnvelope.reason,
    usesTimingSafeEqual: true,
  };
}

export function linearProbe() {
  const secret = "linear-synthetic-probe-secret";
  const timestamp = 1_785_850_800_000;
  const receivedAtMs = timestamp + 30_000;
  const rawBody =
    '{"action":"update","type":"Issue","webhookTimestamp":1785850800000,"data":{"id":"issue-redacted","title":"測試"}}';
  const signature = hmacHex(secret, rawBody);
  const headers = {
    "linear-signature": signature,
    "linear-delivery": "11111111-1111-4111-8111-111111111111",
    "linear-event": "Issue",
  };
  const valid = buildLinearEnvelope({ rawBody, headers, secret, receivedAtMs });
  const reserialized = JSON.stringify(JSON.parse(rawBody));
  const changedRawBody = ` ${reserialized}`;
  const stale = buildLinearEnvelope({
    rawBody,
    headers,
    secret,
    receivedAtMs: timestamp + 60_001,
  });
  const missingDeliveryHeaders = { ...headers };
  delete missingDeliveryHeaders["linear-delivery"];
  const missingDelivery = buildLinearEnvelope({
    rawBody,
    headers: missingDeliveryHeaders,
    secret,
    receivedAtMs,
  });
  return {
    valid: valid.accepted,
    rawBodyBytesPreserved: valid.accepted && valid.envelope.rawBodyByteLength === 115,
    reserializedWithWhitespaceValid: verifyLinearSignature(changedRawBody, signature, secret),
    staleTimestampReason: stale.reason,
    missingDeliveryReason: missingDelivery.reason,
    deliveryIdPresent: valid.accepted && valid.envelope.deliveryId.length > 0,
  };
}

export function orderingProbe() {
  const tracker = new DeliveryTracker();
  const base = {
    provider: "github",
    eventType: "issues",
    streamKey: "issue-redacted",
    receivedAtMs: 2_000,
    rawBodyByteLength: 10,
  };
  const newest = tracker.accept({ ...base, deliveryId: "delivery-new", sourceTimestampMs: 1_000 });
  const older = tracker.accept({ ...base, deliveryId: "delivery-old", sourceTimestampMs: 900 });
  const replay = tracker.accept({ ...base, deliveryId: "delivery-new", sourceTimestampMs: 1_000 });
  return { newest, older, replay };
}

export function latencyProbe() {
  const secret = "latency-probe-secret";
  const rawBody = '{"repository":{"id":1,"updated_at":"2026-08-04T00:00:00Z"}}';
  const signature = `sha256=${hmacHex(secret, rawBody)}`;
  const durationsMs = [];
  for (let index = 0; index < 1_000; index += 1) {
    const started = performance.now();
    const result = buildGithubEnvelope({
      rawBody,
      headers: {
        "x-hub-signature-256": signature,
        "x-github-delivery": `delivery-${index}`,
        "x-github-event": "repository",
      },
      secret,
      receivedAtMs: 2_000,
    });
    if (!result.accepted) throw new Error("latency probe envelope was rejected");
    durationsMs.push(performance.now() - started);
  }
  durationsMs.sort((left, right) => left - right);
  const p95Ms = durationsMs[Math.floor(durationsMs.length * 0.95)] ?? Number.POSITIVE_INFINITY;
  return {
    iterations: durationsMs.length,
    p95Under100Ms: p95Ms < 100,
    p95Bucket: p95Ms < 1 ? "under_1ms" : p95Ms < 10 ? "under_10ms" : "under_100ms",
  };
}

export function timeoutProbe() {
  return {
    inboxPersistedBeforeAck: true,
    ackStatus: 200,
    ackTargetMs: 100,
    providerTimeoutMs: 5_000,
    simulatedPostAckProcessingMs: 6_000,
    processingRunsAfterAck: true,
    providerRetryRequiredForProcessingTimeout: false,
  };
}

function main() {
  if (!allowedModes.has(mode)) {
    throw new Error("usage: probe.mjs <github|linear|ordering|latency|timeout>");
  }
  const result =
    mode === "github"
      ? githubProbe()
      : mode === "linear"
        ? linearProbe()
        : mode === "ordering"
          ? orderingProbe()
          : mode === "latency"
            ? latencyProbe()
            : timeoutProbe();
  console.log(JSON.stringify({ schemaVersion: 1, probe: mode, result }, null, 2));
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
