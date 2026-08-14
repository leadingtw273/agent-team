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

  it("tolerates additive fields while retaining the required window contract", async () => {
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
    ).resolves.toMatchObject({
      provider: "codex",
      state: "partial",
      buckets: { weekly: { remainingPercent: 93 } },
    });
  });

  it("reads the official multi-bucket view without relying on a hard-coded limit id", async () => {
    const value = epoch({
      rateLimits: {
        rateLimitsByLimitId: {
          arbitrary_week_bucket: {
            limitId: "server-owned-week-id",
            primary: {
              usedPercent: 15,
              windowDurationMins: 10_080,
              resetsAt: nowSeconds + 86_400,
            },
          },
          arbitrary_short_bucket: {
            limitId: "server-owned-short-id",
            secondary: {
              usedPercent: 20,
              windowDurationMins: 300,
              resetsAt: nowSeconds + 1_800,
            },
          },
        },
      },
    });
    await expect(
      createCodexQuotaCollector({ epoch: source(value), clock: createFixedClock(now) }).collect({
        expectedCliVersion: "0.147.0",
      }),
    ).resolves.toMatchObject({
      state: "partial",
      buckets: { weekly: { remainingPercent: 85 }, fiveHour: { remainingPercent: 80 } },
    });
  });

  it("uses the official single view when multi-bucket data also contains an independent model meter", async () => {
    const base = epoch();
    const single = (base.rateLimits as { rateLimits: Record<string, unknown> }).rateLimits;
    const value = epoch({
      rateLimits: {
        rateLimits: single,
        rateLimitsByLimitId: {
          opaque_model_meter: {
            limitId: "server-owned-model-id",
            limitName: "A separately metered model",
            primary: {
              usedPercent: 0,
              windowDurationMins: 10_080,
              resetsAt: nowSeconds + 86_400,
            },
          },
          ordinary_mirror: single,
        },
      },
    });
    await expect(
      createCodexQuotaCollector({ epoch: source(value), clock: createFixedClock(now) }).collect({
        expectedCliVersion: "0.147.0",
      }),
    ).resolves.toMatchObject({
      state: "partial",
      reason: "five_hour_unavailable",
      buckets: { weekly: { remainingPercent: 93 } },
    });
  });

  it("fails closed when two buckets claim conflicting values for the same window", async () => {
    const value = epoch({
      rateLimits: {
        rateLimitsByLimitId: {
          first: {
            primary: {
              usedPercent: 15,
              windowDurationMins: 10_080,
              resetsAt: nowSeconds + 86_400,
            },
          },
          second: {
            primary: {
              usedPercent: 16,
              windowDurationMins: 10_080,
              resetsAt: nowSeconds + 86_400,
            },
          },
        },
      },
    });
    await expect(
      createCodexQuotaCollector({ epoch: source(value), clock: createFixedClock(now) }).collect({
        expectedCliVersion: "0.147.0",
      }),
    ).resolves.toMatchObject({ state: "unknown", reason: "app_server_unavailable" });
  });
});
