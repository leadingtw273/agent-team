import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ClaudeQuotaCollector,
  ClaudeQuotaDiagnosticResult,
  ClaudeQuotaRefresher,
} from "../../src/adapters/providers/claude/index.js";
import type { ProcessPort } from "../../src/application/ports/index.js";
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

const neverProcess: ProcessPort = {
  spawn() {
    throw new Error("collector injection must prevent process spawn");
  },
};

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
        codex: { diagnosticEnabled: true, expectedCliVersion: "0.147.0" },
      }),
      { mode: 0o600 },
    );
  }
  return root;
}

function full(
  weeklyRemaining = 90,
  fiveHourRemaining = 80,
  observedAt = now,
): Extract<ClaudeQuotaDiagnosticResult, { state: "full" }> {
  return {
    provider: "claude",
    state: "full",
    accountFingerprint: "provider-owned-fingerprint",
    cliVersion: "2.1.229",
    observedAt,
    provenance: "claude_status_line_v1",
    buckets: {
      weekly: { remainingPercent: weeklyRemaining, resetsAt: weeklyReset },
      fiveHour: {
        remainingPercent: fiveHourRemaining,
        resetsAt: fiveHourReset,
      },
    },
  };
}

function collector(
  implementation: () => Promise<ClaudeQuotaDiagnosticResult>,
): ClaudeQuotaCollector & { collect: ReturnType<typeof vi.fn> } {
  return { collect: vi.fn(implementation) };
}

function refresher(
  implementation: ClaudeQuotaRefresher["refresh"],
): ClaudeQuotaRefresher & { refresh: ReturnType<typeof vi.fn> } {
  return { refresh: vi.fn(implementation) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production Claude quota admission composition", () => {
  it("actively refreshes evidence older than 60 seconds and singleflights concurrent resolves", async () => {
    const old = parseInstant("2026-08-13T07:13:59.000Z");
    if (!old.ok) throw new Error(old.error.code);
    let collected = 0;
    const source = collector(() =>
      Promise.resolve(collected++ === 0 ? full(90, 80, old.value) : full()),
    );
    const active = refresher(() =>
      Promise.resolve({ state: "refreshed", reason: "snapshot_refreshed" }),
    );
    const admission = await createProductionQuotaAdmission({
      agentTeamHome: await home(),
      claudeProcess: neverProcess,
      workingDirectory: "/tmp",
      collector: source,
      refresher: active,
      clock,
    });

    await expect(
      Promise.all([
        admission.resolve("claude"),
        admission.resolve("claude"),
        admission.resolve("claude"),
      ]),
    ).resolves.toEqual([
      { state: "ready", reason: "quota_confirmed" },
      { state: "ready", reason: "quota_confirmed" },
      { state: "ready", reason: "quota_confirmed" },
    ]);
    expect(active.refresh.mock.calls).toHaveLength(1);
    expect(source.collect.mock.calls).toHaveLength(2);
  });

  it("does not refresh evidence exactly 60 seconds old", async () => {
    const boundary = parseInstant("2026-08-13T07:14:00.000Z");
    if (!boundary.ok) throw new Error(boundary.error.code);
    const active = refresher(() => {
      throw new Error("boundary evidence must be reused");
    });
    const admission = await createProductionQuotaAdmission({
      agentTeamHome: await home(),
      claudeProcess: neverProcess,
      workingDirectory: "/tmp",
      collector: collector(() => Promise.resolve(full(90, 80, boundary.value))),
      refresher: active,
      clock,
    });
    await expect(admission.resolve("claude")).resolves.toEqual({
      state: "ready",
      reason: "quota_confirmed",
    });
    expect(active.refresh.mock.calls).toHaveLength(0);
  });

  it("fails closed when active refresh cannot produce evidence", async () => {
    const active = refresher(() =>
      Promise.resolve({ state: "failed", reason: "snapshot_not_refreshed" }),
    );
    let collected = 0;
    const source = collector(() =>
      Promise.resolve(
        collected++ === 0
          ? { provider: "claude", state: "unknown", reason: "snapshot_stale" }
          : full(),
      ),
    );
    const admission = await createProductionQuotaAdmission({
      agentTeamHome: await home(),
      claudeProcess: neverProcess,
      workingDirectory: "/tmp",
      collector: source,
      refresher: active,
      clock,
    });
    await expect(admission.resolve("claude")).resolves.toEqual({
      state: "quota_unknown",
      reason: "runtime_context_unavailable",
    });
    expect(active.refresh.mock.calls).toHaveLength(1);
    expect(source.collect.mock.calls).toHaveLength(1);
  });

  it("admits a fresh full snapshot and singleflights concurrent resolutions", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = collector(async () => {
      await gate;
      return full();
    });
    const admission = await createProductionQuotaAdmission({
      agentTeamHome: await home(),
      claudeProcess: neverProcess,
      workingDirectory: "/tmp",
      collector: source,
      clock,
    });

    const pending = [
      admission.resolve("claude"),
      admission.resolve("claude"),
      admission.resolve("claude"),
    ];
    release?.();
    await expect(Promise.all(pending)).resolves.toEqual([
      { state: "ready", reason: "quota_confirmed" },
      { state: "ready", reason: "quota_confirmed" },
      { state: "ready", reason: "quota_confirmed" },
    ]);
    expect(source.collect.mock.calls).toHaveLength(1);
  });

  it("fails closed for absent config, partial evidence, and every non-Claude provider", async () => {
    const unavailable = collector(() =>
      Promise.resolve({ provider: "claude", state: "unknown", reason: "snapshot_stale" }),
    );
    const absent = await createProductionQuotaAdmission({
      agentTeamHome: await home(false),
      claudeProcess: neverProcess,
      workingDirectory: "/tmp",
      collector: unavailable,
      clock,
    });
    await expect(absent.resolve("claude")).resolves.toEqual({
      state: "quota_unknown",
      reason: "collector_unavailable",
    });
    expect(unavailable.collect.mock.calls).toHaveLength(0);

    const partial = collector(() =>
      Promise.resolve({ provider: "claude", state: "unknown", reason: "snapshot_stale" }),
    );
    const admission = await createProductionQuotaAdmission({
      agentTeamHome: await home(),
      claudeProcess: neverProcess,
      workingDirectory: "/tmp",
      collector: partial,
      clock,
    });
    await expect(admission.resolve("claude")).resolves.toEqual({
      state: "quota_unknown",
      reason: "runtime_context_unavailable",
    });
    await expect(admission.resolve("codex")).resolves.toEqual({
      state: "quota_unknown",
      reason: "runtime_context_unavailable",
    });
    expect(partial.collect.mock.calls).toHaveLength(1);
  });

  it("enforces the weekly wall and five-hour exhaustion", async () => {
    for (const [result, reason] of [
      [full(20, 50), "weekly_wall_reached"],
      [full(90, 0), "five_hour_limit_reached"],
    ] as const) {
      const admission = await createProductionQuotaAdmission({
        agentTeamHome: await home(),
        claudeProcess: neverProcess,
        workingDirectory: "/tmp",
        collector: collector(() => Promise.resolve(result)),
        clock,
      });
      await expect(admission.resolve("claude")).resolves.toEqual({
        state: "quota_blocked",
        reason,
      });
    }
  });

  it("refreshes a stale full sample once and never retains a failed-ready cache", async () => {
    const staleInstant = parseInstant("2026-08-13T07:00:00.000Z");
    if (!staleInstant.ok) throw new Error(staleInstant.error.code);
    const source = collector(() => Promise.resolve(full(90, 80, staleInstant.value)));
    const admission = await createProductionQuotaAdmission({
      agentTeamHome: await home(),
      claudeProcess: neverProcess,
      workingDirectory: "/tmp",
      collector: source,
      clock,
    });
    await expect(admission.resolve("claude")).resolves.toEqual({
      state: "quota_unknown",
      reason: "usage_unknown_or_stale",
    });
    expect(source.collect.mock.calls).toHaveLength(2);
    await expect(admission.resolve("claude")).resolves.toEqual({
      state: "quota_unknown",
      reason: "usage_unknown_or_stale",
    });
    expect(source.collect.mock.calls).toHaveLength(4);
  });
});
