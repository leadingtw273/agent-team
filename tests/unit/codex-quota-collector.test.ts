import { describe, expect, it } from "vitest";

import {
  createCodexQuotaCollector,
  type CodexAppServerEpoch,
  type CodexAppServerEpochPort,
} from "../../src/adapters/providers/codex/index.js";
import { createFixedClock, parseInstant } from "../../src/domain/foundation/index.js";

const parsedNow = parseInstant("2026-08-13T06:13:30.000Z");
if (!parsedNow.ok) throw new Error(parsedNow.error.code);
const now = parsedNow.value;
const nowSeconds = Math.floor(Date.parse(now) / 1_000);

function epoch(overrides: Partial<CodexAppServerEpoch> = {}): CodexAppServerEpoch {
  const account = {
    account: { type: "chatgpt", email: "private@example.invalid", planType: "pro" },
  };
  return {
    cliVersion: "codex-cli 0.147.0\n",
    accountBefore: account,
    accountAfter: account,
    rateLimits: {
      rateLimits: {
        limitId: "codex",
        planType: "pro",
        primary: {
          usedPercent: 7,
          windowDurationMins: 10_080,
          resetsAt: nowSeconds + 86_400,
        },
        secondary: null,
      },
    },
    ...overrides,
  };
}

function source(value: CodexAppServerEpoch | undefined): CodexAppServerEpochPort {
  return { read: () => Promise.resolve(value) };
}

describe("Codex App Server quota collector", () => {
  it("reports the official live weekly-only shape as partial, never full", async () => {
    const collector = createCodexQuotaCollector({
      epoch: source(epoch()),
      clock: createFixedClock(now),
    });
    const result = await collector.collect({ expectedCliVersion: "0.147.0" });

    expect(result).toMatchObject({
      provider: "codex",
      state: "partial",
      reason: "five_hour_unavailable",
      cliVersion: "0.147.0",
      buckets: { weekly: { remainingPercent: 93 } },
    });
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
  });

  it("remains partial even if a future App Server response includes five-hour", async () => {
    const value = epoch();
    const limits = (value.rateLimits as { rateLimits: Record<string, unknown> }).rateLimits;
    limits["secondary"] = {
      usedPercent: 10,
      windowDurationMins: 300,
      resetsAt: nowSeconds + 1_800,
    };
    const result = await createCodexQuotaCollector({
      epoch: source(value),
      clock: createFixedClock(now),
    }).collect({ expectedCliVersion: "0.147.0" });
    expect(result).toMatchObject({
      state: "partial",
      reason: "admission_not_enabled",
      buckets: { weekly: { remainingPercent: 93 }, fiveHour: { remainingPercent: 90 } },
    });
  });

  it("fails closed on an account switch, version drift, and unavailable server", async () => {
    const switched = epoch({
      accountAfter: {
        account: { type: "chatgpt", email: "other@example.invalid", planType: "pro" },
      },
    });
    await expect(
      createCodexQuotaCollector({ epoch: source(switched), clock: createFixedClock(now) }).collect({
        expectedCliVersion: "0.147.0",
      }),
    ).resolves.toMatchObject({ state: "unknown", reason: "runtime_context_changed" });
    await expect(
      createCodexQuotaCollector({ epoch: source(epoch()), clock: createFixedClock(now) }).collect({
        expectedCliVersion: "0.148.0",
      }),
    ).resolves.toMatchObject({ state: "unknown", reason: "version_unavailable" });
    await expect(
      createCodexQuotaCollector({ epoch: source(undefined), clock: createFixedClock(now) }).collect(
        {
          expectedCliVersion: "0.147.0",
        },
      ),
    ).resolves.toMatchObject({ state: "unknown", reason: "app_server_unavailable" });
  });

  it("rejects rate-limit window schema drift", async () => {
    const value = epoch();
    const limits = (value.rateLimits as { rateLimits: Record<string, unknown> }).rateLimits;
    limits["primary"] = {
      ...(limits["primary"] as Record<string, unknown>),
      unexpected: "schema-drift",
    };
    await expect(
      createCodexQuotaCollector({ epoch: source(value), clock: createFixedClock(now) }).collect({
        expectedCliVersion: "0.147.0",
      }),
    ).resolves.toEqual({ provider: "codex", state: "unknown", reason: "app_server_unavailable" });
  });
});
