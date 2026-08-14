import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type {
  PlatformIdentity,
  QuotaPort,
  QuotaSnapshot,
  UsageQuotaSample,
} from "../../src/application/ports/index.js";
import {
  evaluateQuotaForNewJob,
  evaluateRunningQuota,
  geminiAvailabilitySample,
  invalidateQuotaSnapshot,
  parseClaudeRateLimitEvents,
  parseCodexRateLimits,
  resolveQuotaForNewJob,
  type QuotaParserContext,
  type QuotaPolicy,
} from "../../src/application/quota/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type Instant,
} from "../../src/domain/foundation/index.js";

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function context(provider: string): QuotaParserContext {
  return {
    provider,
    accountFingerprint: `${provider}-account-v1`,
    cliVersion: provider === "codex" ? "0.146.0" : provider === "claude" ? "2.1.221" : "0.52.0",
    source: "provider-structured-event",
    observedAt: instant("2026-08-04T12:00:00.000Z"),
  };
}

const policy: QuotaPolicy = {
  weeklyUsageLimitPercent: 80,
  terminalRemainingPercent: 3,
  maxSampleAgeMs: 15 * 60 * 1_000,
  expectedCliVersions: { codex: "0.146.0", claude: "2.1.221", gemini: "0.52.0" },
};

function usage(
  provider: string,
  bucket: "weekly" | "five_hour",
  remainingPercent: number,
  observedAt = "2026-08-04T12:00:00.000Z",
): UsageQuotaSample {
  return {
    ...context(provider),
    observedAt: instant(observedAt),
    kind: "usage",
    bucket,
    state: "confirmed",
    remainingPercent,
    resetsAt: instant("2026-08-11T12:00:00.000Z"),
  };
}

function usageSnapshot(
  provider = "codex",
  weeklyRemaining = 50,
  fiveHourRemaining = 50,
): QuotaSnapshot {
  return {
    provider,
    accountFingerprint: `${provider}-account-v1`,
    samples: [
      usage(provider, "weekly", weeklyRemaining),
      usage(provider, "five_hour", fiveHourRemaining),
    ],
  };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(`../../fixtures/providers/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

describe("provider quota parsers", () => {
  it("parses Codex weekly data but preserves a missing five-hour bucket as unknown", async () => {
    const input = await fixture("codex/account-rate-limits.json");
    const observed = input["observed"] as {
      rateLimits: {
        current: unknown;
        buckets: { limitId: string }[];
      };
    };
    const byId = Object.fromEntries(
      observed.rateLimits.buckets.map((bucket) => [bucket.limitId, bucket]),
    );
    const samples = parseCodexRateLimits(
      { rateLimits: observed.rateLimits.current, rateLimitsByLimitId: byId },
      context("codex"),
      "codex",
    );

    expect(samples).toEqual([
      expect.objectContaining({ bucket: "weekly", state: "confirmed", remainingPercent: 89 }),
      expect.objectContaining({ bucket: "five_hour", state: "unknown" }),
    ]);
  });

  it("parses both Codex windows and fails closed on schema drift", () => {
    const samples = parseCodexRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_786_414_133 },
          secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_786_000_000 },
        },
      },
      context("codex"),
    );
    expect(samples.map((sample) => [sample.bucket, sample.state])).toEqual([
      ["weekly", "confirmed"],
      ["five_hour", "confirmed"],
    ]);
    expect(
      parseCodexRateLimits({ rateLimits: { primary: { usedPercent: "25" } } }, context("codex")),
    ).toEqual([
      expect.objectContaining({ bucket: "weekly", state: "unknown" }),
      expect.objectContaining({ bucket: "five_hour", state: "unknown" }),
    ]);
  });

  it("parses Claude weekly events without inventing an absent five-hour signal", async () => {
    const input = await fixture("claude/exec-success.json");
    const observed = input["observed"] as {
      rateLimitEvents: {
        status: string;
        rateLimitType: string;
        utilization: number;
        resetsAt: number;
      }[];
    };
    const events = observed.rateLimitEvents.map((rateLimitInfo) => ({
      type: "rate_limit_event",
      rateLimitInfo,
    }));
    const samples = parseClaudeRateLimitEvents(events, context("claude"));
    expect(samples).toEqual([
      expect.objectContaining({ bucket: "weekly", state: "confirmed", remainingPercent: 7 }),
      expect.objectContaining({ bucket: "five_hour", state: "unknown" }),
    ]);
  });

  it("maps a rejected Claude bucket to an exhausted confirmed signal", () => {
    expect(
      parseClaudeRateLimitEvents(
        [
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              rate_limit_type: "five_hour",
              utilization: 0.75,
              resets_at: 1_786_000_000,
            },
          },
        ],
        context("claude"),
      ),
    ).toEqual([
      expect.objectContaining({ bucket: "weekly", state: "unknown" }),
      expect.objectContaining({ bucket: "five_hour", state: "confirmed", remainingPercent: 0 }),
    ]);
  });

  it("represents Gemini only as confirmed availability", () => {
    expect(geminiAvailabilitySample(true, context("gemini"))).toMatchObject({
      kind: "availability",
      state: "confirmed",
      available: true,
    });
  });
});

describe("quota routing policy", () => {
  const now = instant("2026-08-04T12:05:00.000Z");
  const codexIdentity: PlatformIdentity = {
    provider: "codex",
    accountFingerprint: "codex-account-v1",
  };

  it("allows fresh confirmed quota and blocks configured weekly or provider five-hour walls", () => {
    expect(evaluateQuotaForNewJob(usageSnapshot(), codexIdentity, now, policy)).toEqual({
      state: "ready",
      reason: "weekly_quota_confirmed",
    });
    expect(
      evaluateQuotaForNewJob(
        { ...usageSnapshot(), samples: [usage("codex", "weekly", 50)] },
        codexIdentity,
        now,
        policy,
      ),
    ).toEqual({ state: "ready", reason: "weekly_quota_confirmed" });
    expect(
      evaluateQuotaForNewJob(usageSnapshot("codex", 20, 50), codexIdentity, now, policy),
    ).toEqual({
      state: "quota_blocked",
      reason: "weekly_wall_reached",
    });
    expect(
      evaluateQuotaForNewJob(usageSnapshot("codex", 50, 0), codexIdentity, now, policy),
    ).toEqual({
      state: "quota_blocked",
      reason: "five_hour_limit_reached",
    });
  });

  it("treats stale, future, duplicate weekly, and switched-account samples as unknown", () => {
    const cases: QuotaSnapshot[] = [
      {
        ...usageSnapshot(),
        samples: [
          usage("codex", "weekly", 50, "2026-08-04T11:00:00.000Z"),
          usage("codex", "five_hour", 50),
        ],
      },
      {
        ...usageSnapshot(),
        samples: [
          usage("codex", "weekly", 50, "2026-08-04T12:06:00.000Z"),
          usage("codex", "five_hour", 50),
        ],
      },
      { ...usageSnapshot(), samples: [...usageSnapshot().samples, usage("codex", "weekly", 50)] },
      { ...usageSnapshot(), accountFingerprint: "codex-account-v2" },
    ];
    for (const snapshot of cases) {
      expect(evaluateQuotaForNewJob(snapshot, codexIdentity, now, policy).state).toBe(
        "quota_unknown",
      );
    }
  });

  it("fails closed on runtime-invalid percentages, identity, source, and CLI metadata", () => {
    const invalidSnapshots: QuotaSnapshot[] = [
      usageSnapshot("codex", Number.NaN, 50),
      usageSnapshot("codex", -1, 50),
      usageSnapshot("codex", 101, 50),
      usageSnapshot("codex", 50, Number.POSITIVE_INFINITY),
      { ...usageSnapshot(), accountFingerprint: "" },
      {
        ...usageSnapshot(),
        samples: usageSnapshot().samples.map((sample) => ({ ...sample, source: "" })),
      },
      {
        ...usageSnapshot(),
        samples: usageSnapshot().samples.map((sample) => ({ ...sample, cliVersion: "" })),
      },
    ];
    for (const snapshot of invalidSnapshots) {
      expect(evaluateQuotaForNewJob(snapshot, codexIdentity, now, policy).state).toBe(
        "quota_unknown",
      );
      expect(evaluateRunningQuota(snapshot, codexIdentity, now, policy).action).toBe("checkpoint");
    }
    expect(
      evaluateQuotaForNewJob(usageSnapshot(), codexIdentity, now, {
        ...policy,
        expectedCliVersions: { ...policy.expectedCliVersions, codex: "" },
      }).state,
    ).toBe("quota_unknown");
  });

  it("checkpoints running work at 3%, a known five-hour limit, or an unknown weekly signal", () => {
    expect(evaluateRunningQuota(usageSnapshot("codex", 3, 50), codexIdentity, now, policy)).toEqual(
      {
        action: "checkpoint",
        reason: "terminal_weekly_boundary",
      },
    );
    expect(evaluateRunningQuota(usageSnapshot("codex", 50, 0), codexIdentity, now, policy)).toEqual(
      {
        action: "checkpoint",
        reason: "five_hour_limit_reached",
      },
    );
    expect(
      evaluateRunningQuota(
        { ...usageSnapshot(), samples: [usage("codex", "five_hour", 50)] },
        codexIdentity,
        now,
        policy,
      ).action,
    ).toBe("checkpoint");
  });

  it("uses Gemini availability without pretending it has account usage buckets", () => {
    const identity = { provider: "gemini", accountFingerprint: "gemini-account-v1" };
    const available: QuotaSnapshot = {
      ...identity,
      samples: [geminiAvailabilitySample(true, context("gemini"))],
    };
    expect(evaluateQuotaForNewJob(available, identity, now, policy).state).toBe("ready");
    expect(evaluateRunningQuota(available, identity, now, policy).action).toBe("continue");
    const unavailable = {
      ...available,
      samples: [geminiAvailabilitySample(false, context("gemini"))],
    };
    expect(evaluateQuotaForNewJob(unavailable, identity, now, policy).state).toBe(
      "provider_unavailable",
    );
  });

  it("invalidates samples when the configured CLI version changes", () => {
    expect(
      evaluateQuotaForNewJob(usageSnapshot(), codexIdentity, now, {
        ...policy,
        expectedCliVersions: { ...policy.expectedCliVersions, codex: "0.147.0" },
      }).state,
    ).toBe("quota_unknown");
  });

  it("refreshes at most once and rejects a refresh from a switched account", async () => {
    class FakeQuotaPort implements QuotaPort {
      refreshCalls = 0;
      constructor(readonly refreshed: QuotaSnapshot | "failure") {}
      readCached() {
        return Promise.resolve(ok(invalidateQuotaSnapshot(usageSnapshot(), "manual_reset")));
      }
      refresh() {
        this.refreshCalls += 1;
        return Promise.resolve(
          this.refreshed === "failure" ? err(domainError("unavailable")) : ok(this.refreshed),
        );
      }
    }

    const recoveredPort = new FakeQuotaPort(usageSnapshot());
    const recovered = await resolveQuotaForNewJob(recoveredPort, codexIdentity, now, policy);
    expect(recovered).toMatchObject({ refreshed: true, decision: { state: "ready" } });
    expect(recoveredPort.refreshCalls).toBe(1);

    const switched = new FakeQuotaPort({
      ...usageSnapshot(),
      accountFingerprint: "codex-account-v2",
    });
    expect((await resolveQuotaForNewJob(switched, codexIdentity, now, policy)).decision.state).toBe(
      "quota_unknown",
    );
    expect(switched.refreshCalls).toBe(1);

    const failed = new FakeQuotaPort("failure");
    expect(await resolveQuotaForNewJob(failed, codexIdentity, now, policy)).toMatchObject({
      refreshed: true,
      decision: { state: "quota_unknown", reason: "refresh_failed" },
    });
    expect(failed.refreshCalls).toBe(1);
  });

  it("invalidates manual-reset samples without changing their account binding", () => {
    const invalidated = invalidateQuotaSnapshot(usageSnapshot(), "manual_reset");
    expect(invalidated.accountFingerprint).toBe("codex-account-v1");
    expect(invalidated.samples).toEqual([
      expect.objectContaining({ bucket: "weekly", state: "stale", reason: "manual_reset" }),
      expect.objectContaining({ bucket: "five_hour", state: "stale", reason: "manual_reset" }),
    ]);
  });
});
