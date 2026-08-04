import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  githubProbe,
  latencyProbe,
  linearProbe,
  orderingProbe,
  timeoutProbe,
} from "../../spikes/webhook/probe.mjs";

const fixtureDirectory = new URL("../../fixtures/webhooks/", import.meta.url);
const probePath = fileURLToPath(new URL("../../spikes/webhook/probe.mjs", import.meta.url));

async function readFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Webhook spike evidence contract", () => {
  it("keeps fixtures versioned and free of secrets or delivery identifiers", async () => {
    const names = await readdir(fixtureDirectory);
    expect(names).toHaveLength(5);

    for (const name of names) {
      const text = await readFile(new URL(name, fixtureDirectory), "utf8");
      const fixture = JSON.parse(text) as {
        schemaVersion?: number;
        fixtureType?: string;
        provenance?: { source?: string; redactionMethod?: string; removedFields?: string[] };
      };
      expect(fixture.schemaVersion, name).toBe(1);
      expect(fixture.fixtureType, name).toBe("observed-redacted");
      expect(fixture.provenance?.source, name).toBeTruthy();
      expect(fixture.provenance?.redactionMethod, name).toBeTruthy();
      expect(fixture.provenance?.removedFields, name).toBeInstanceOf(Array);
      expect(text, name).not.toMatch(
        /"(?:secret|signature|rawBody|deliveryId|organizationId|accountId)"\s*:/iu,
      );
    }
  });

  it("matches GitHub's official HMAC vector and rejects modified bytes", async () => {
    const run = githubProbe();
    const fixture = await readFixture("github-signature.json");
    const observed = fixture["observed"] as Record<string, unknown>;

    expect(run).toEqual(observed);
    expect(observed).toEqual(
      expect.objectContaining({
        officialVectorMatches: true,
        valid: true,
        modifiedRawBodyValid: false,
        missingPrefixValid: false,
        malformedValid: false,
        validSignatureInvalidJsonReason: "invalid_json",
        usesTimingSafeEqual: true,
      }),
    );
  });

  it("verifies Linear raw bytes before parsing and enforces timestamp and delivery headers", async () => {
    const run = linearProbe();
    const fixture = await readFixture("linear-signature-timestamp.json");
    const observed = fixture["observed"] as Record<string, unknown>;
    const expected = fixture["expected"] as { maximumClockSkewMs: number };

    expect(run).toEqual(observed);
    expect(observed).toEqual(
      expect.objectContaining({
        valid: true,
        rawBodyBytesPreserved: true,
        reserializedWithWhitespaceValid: false,
        staleTimestampReason: "stale_timestamp",
        missingDeliveryReason: "missing_required_header",
      }),
    );
    expect(expected.maximumClockSkewMs).toBe(60_000);
  });

  it("deduplicates replay while persisting but not projecting out-of-order delivery", async () => {
    const run = orderingProbe();
    const fixture = await readFixture("replay-out-of-order.json");
    const observed = fixture["observed"] as {
      newest: Record<string, unknown>;
      older: Record<string, unknown>;
      replay: Record<string, unknown>;
    };

    expect(run).toEqual(observed);
    expect(observed.newest).toEqual({
      classification: "accepted",
      persisted: true,
      projectionEligible: true,
    });
    expect(observed.older).toEqual({
      classification: "accepted_out_of_order",
      persisted: true,
      projectionEligible: false,
    });
    expect(observed.replay).toEqual({
      classification: "duplicate",
      persisted: false,
      projectionEligible: false,
    });
  });

  it("keeps the synchronous path below its internal ACK budget", async () => {
    const result = latencyProbe();
    const fixture = await readFixture("fast-ack.json");
    const expected = fixture["expected"] as {
      internalAckTargetMs: number;
      benchmarkIsNotNetworkSla: boolean;
    };

    expect(result.iterations).toBe(1_000);
    expect(result.p95Under100Ms).toBe(true);
    expect(["under_1ms", "under_10ms", "under_100ms"]).toContain(result.p95Bucket);
    expect(expected.internalAckTargetMs).toBe(100);
    expect(expected.benchmarkIsNotNetworkSla).toBe(true);
  });

  it("ACKs only after durable inbox and decouples slow processing from provider retry", async () => {
    const run = timeoutProbe();
    const fixture = await readFixture("post-ack-timeout.json");
    const observed = fixture["observed"] as Record<string, unknown>;

    expect(run).toEqual(observed);
    expect(observed).toEqual(
      expect.objectContaining({
        inboxPersistedBeforeAck: true,
        ackStatus: 200,
        ackTargetMs: 100,
        providerTimeoutMs: 5_000,
        simulatedPostAckProcessingMs: 6_000,
        processingRunsAfterAck: true,
        providerRetryRequiredForProcessingTimeout: false,
      }),
    );
  });

  it("keeps HTTP server and tunnel concerns outside the spike core", async () => {
    const source = await readFile(probePath, "utf8");
    expect(source).toContain("timingSafeEqual");
    expect(source).not.toMatch(/createServer|express|fastify|cloudflared|ngrok/u);
  });
});
