import { describe, expect, it } from "vitest";

import type {
  PlatformIdentity,
  QuotaPort,
  QuotaSnapshot,
  ReadOptions,
} from "../../src/application/ports/index.js";
import {
  PolicyBackedNewJobQuotaAdmission,
  type QuotaPolicy,
  type QuotaRuntimeContextPort,
} from "../../src/application/quota/index.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseInstant,
} from "../../src/domain/foundation/index.js";

const parsedNow = parseInstant("2026-08-11T12:00:00.000Z");
if (!parsedNow.ok) throw new Error(parsedNow.error.code);
const now = parsedNow.value;

const identity: PlatformIdentity = {
  provider: "claude",
  accountFingerprint: "opaque-claude-account",
};
const policy: QuotaPolicy = {
  weeklyUsageLimitPercent: 80,
  terminalRemainingPercent: 3,
  maxSampleAgeMs: 15 * 60 * 1_000,
  expectedCliVersions: { claude: "2.1.223" },
};

function snapshot(): QuotaSnapshot {
  const common = {
    ...identity,
    cliVersion: "2.1.223",
    source: "structured-event",
    observedAt: now,
    kind: "usage" as const,
    state: "confirmed" as const,
  };
  return {
    ...identity,
    samples: [
      { ...common, bucket: "weekly", remainingPercent: 60 },
      { ...common, bucket: "five_hour", remainingPercent: 50 },
    ],
  };
}

class RecordingQuotaPort implements QuotaPort {
  cachedCalls = 0;
  refreshCalls = 0;
  lastOptions: ReadOptions | undefined;

  readCached(_identity: PlatformIdentity, options?: ReadOptions) {
    this.cachedCalls += 1;
    this.lastOptions = options;
    return Promise.resolve(ok(snapshot()));
  }

  refresh(_provider: string, options?: ReadOptions) {
    this.refreshCalls += 1;
    this.lastOptions = options;
    return Promise.resolve(ok(snapshot()));
  }
}

function context(value = { identity, cliVersion: "2.1.223" }): QuotaRuntimeContextPort {
  return { observe: () => Promise.resolve(ok(value)) };
}

describe("PolicyBackedNewJobQuotaAdmission", () => {
  it("allows a Provider-owned identity with a fresh confirmed double-window snapshot", async () => {
    const quota = new RecordingQuotaPort();
    const admission = new PolicyBackedNewJobQuotaAdmission(
      context(),
      quota,
      policy,
      createFixedClock(now),
    );
    const controller = new AbortController();

    await expect(admission.resolve("claude", { signal: controller.signal })).resolves.toEqual({
      state: "ready",
      reason: "quota_confirmed",
    });
    expect(quota.cachedCalls).toBe(1);
    expect(quota.refreshCalls).toBe(0);
    expect(quota.lastOptions?.signal).toBe(controller.signal);
  });

  it("fails closed before cache access on unavailable or inconsistent runtime identity", async () => {
    const cases: QuotaRuntimeContextPort[] = [
      { observe: () => Promise.resolve(err(domainError("unavailable"))) },
      context({ identity: { ...identity, provider: "codex" }, cliVersion: "2.1.223" }),
      context({ identity: { ...identity, accountFingerprint: "" }, cliVersion: "2.1.223" }),
      context({ identity, cliVersion: "2.1.222" }),
      context({ identity, cliVersion: "" }),
    ];

    for (const contexts of cases) {
      const quota = new RecordingQuotaPort();
      const admission = new PolicyBackedNewJobQuotaAdmission(
        contexts,
        quota,
        policy,
        createFixedClock(now),
      );
      expect((await admission.resolve("claude")).state).toBe("quota_unknown");
      expect(quota.cachedCalls).toBe(0);
      expect(quota.refreshCalls).toBe(0);
    }
  });
});
