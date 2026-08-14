import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexQuotaCollector,
  CodexQuotaDiagnosticResult,
} from "../../src/adapters/providers/codex/index.js";
import { createProductionQuotaAdmission } from "../../src/cli/dispatch/quota-composition.js";
import { createFixedClock, parseInstant } from "../../src/domain/foundation/index.js";

const parsedNow = parseInstant("2026-08-13T07:15:00.000Z");
if (!parsedNow.ok) throw new Error(parsedNow.error.code);
const now = parsedNow.value;
const parsedWeeklyReset = parseInstant("2026-08-20T07:15:00.000Z");
const parsedFiveHourReset = parseInstant("2026-08-13T11:15:00.000Z");
if (!parsedWeeklyReset.ok || !parsedFiveHourReset.ok) throw new Error("invalid reset fixture");
const weeklyReset = parsedWeeklyReset.value;
const fiveHourReset = parsedFiveHourReset.value;
const clock = createFixedClock(now);
const roots: string[] = [];

async function home(configured = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quota-composition-"));
  roots.push(root);
  if (configured) {
    const directory = join(root, "config");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, "quota.json"),
      JSON.stringify({
        schemaVersion: 1,
        claude: {
          enabled: true,
          statusSnapshotPath: "/operator/quota/latest.json",
          expectedCliVersion: "2.1.229",
          weeklyUsageLimitPercent: 80,
          terminalRemainingPercent: 3,
          maxSampleAgeMs: 300_000,
        },
        codex: {
          enabled: true,
          diagnosticEnabled: true,
          expectedCliVersion: "0.147.0",
          weeklyUsageLimitPercent: 80,
          terminalRemainingPercent: 3,
          maxSampleAgeMs: 300_000,
        },
      }),
      { mode: 0o600 },
    );
  }
  return root;
}

function partial(
  weeklyRemaining = 90,
  fiveHourRemaining?: number,
  observedAt = now,
): Extract<CodexQuotaDiagnosticResult, { state: "partial" }> {
  return {
    provider: "codex",
    state: "partial",
    reason: fiveHourRemaining === undefined ? "five_hour_unavailable" : "admission_not_enabled",
    accountFingerprint: "provider-owned-fingerprint",
    cliVersion: "0.147.0",
    observedAt,
    provenance: "codex_app_server_v1",
    buckets: {
      weekly: { remainingPercent: weeklyRemaining, resetsAt: weeklyReset },
      ...(fiveHourRemaining === undefined
        ? {}
        : { fiveHour: { remainingPercent: fiveHourRemaining, resetsAt: fiveHourReset } }),
    },
  };
}

function collector(
  implementation: () => Promise<CodexQuotaDiagnosticResult>,
): CodexQuotaCollector & { collect: ReturnType<typeof vi.fn> } {
  return { collect: vi.fn(implementation) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production Codex quota admission composition", () => {
  it("admits a fresh weekly-only snapshot and singleflights concurrent resolutions", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = collector(async () => {
      await gate;
      return partial();
    });
    const admission = await createProductionQuotaAdmission({
      agentTeamHome: await home(),
      collector: source,
      clock,
    });

    const pending = [
      admission.resolve("codex"),
      admission.resolve("codex"),
      admission.resolve("codex"),
    ];
    release?.();
    await expect(Promise.all(pending)).resolves.toEqual([
      { state: "ready", reason: "weekly_quota_confirmed" },
      { state: "ready", reason: "weekly_quota_confirmed" },
      { state: "ready", reason: "weekly_quota_confirmed" },
    ]);
    expect(source.collect.mock.calls).toHaveLength(1);
  });

  it("fails closed for absent config, unknown evidence, and every non-Codex provider", async () => {
    const unavailable = collector(() =>
      Promise.resolve({ provider: "codex", state: "unknown", reason: "app_server_unavailable" }),
    );
    const absent = await createProductionQuotaAdmission({
      agentTeamHome: await home(false),
      collector: unavailable,
      clock,
    });
    await expect(absent.resolve("codex")).resolves.toEqual({
      state: "quota_unknown",
      reason: "collector_unavailable",
    });
    expect(unavailable.collect.mock.calls).toHaveLength(0);

    const unknown = collector(() =>
      Promise.resolve({ provider: "codex", state: "unknown", reason: "app_server_unavailable" }),
    );
    const admission = await createProductionQuotaAdmission({
      agentTeamHome: await home(),
      collector: unknown,
      clock,
    });
    await expect(admission.resolve("codex")).resolves.toEqual({
      state: "quota_unknown",
      reason: "runtime_context_unavailable",
    });
    await expect(admission.resolve("claude")).resolves.toEqual({
      state: "quota_unknown",
      reason: "runtime_context_unavailable",
    });
    expect(unknown.collect.mock.calls).toHaveLength(1);
  });

  it("enforces the weekly wall and five-hour exhaustion", async () => {
    for (const [result, reason] of [
      [partial(20), "weekly_wall_reached"],
      [partial(90, 0), "five_hour_limit_reached"],
    ] as const) {
      const admission = await createProductionQuotaAdmission({
        agentTeamHome: await home(),
        collector: collector(() => Promise.resolve(result)),
        clock,
      });
      await expect(admission.resolve("codex")).resolves.toEqual({
        state: "quota_blocked",
        reason,
      });
    }
  });

  it("refreshes a stale full sample once and never retains a failed-ready cache", async () => {
    const staleInstant = parseInstant("2026-08-13T07:00:00.000Z");
    if (!staleInstant.ok) throw new Error(staleInstant.error.code);
    const source = collector(() => Promise.resolve(partial(90, undefined, staleInstant.value)));
    const admission = await createProductionQuotaAdmission({
      agentTeamHome: await home(),
      collector: source,
      clock,
    });
    await expect(admission.resolve("codex")).resolves.toEqual({
      state: "quota_unknown",
      reason: "usage_unknown_or_stale",
    });
    expect(source.collect.mock.calls).toHaveLength(2);
    await expect(admission.resolve("codex")).resolves.toEqual({
      state: "quota_unknown",
      reason: "usage_unknown_or_stale",
    });
    expect(source.collect.mock.calls).toHaveLength(4);
  });
});
