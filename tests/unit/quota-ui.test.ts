import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { QuotaSnapshot } from "../../src/application/ports/index.js";
import {
  QuotaDashboardUseCase,
  renderQuotaDashboard,
  type QuotaDashboardPort,
  type QuotaProviderRecord,
} from "../../src/ui/features/quota/index.js";
import { parseInstant, type Instant } from "../../src/domain/foundation/index.js";

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

interface QuotaFixture {
  readonly record: QuotaProviderRecord;
}

async function fixture(name: string): Promise<QuotaFixture> {
  return JSON.parse(
    await readFile(new URL(`../../fixtures/ui/${name}`, import.meta.url), "utf8"),
  ) as QuotaFixture;
}

class FakeQuotaDashboardPort implements QuotaDashboardPort {
  readonly invalidated: (readonly [string, string])[] = [];
  readonly refreshed: string[] = [];
  readonly resumed: string[] = [];

  constructor(private readonly providers: readonly QuotaProviderRecord[]) {}

  listProviders = vi.fn((): Promise<readonly QuotaProviderRecord[]> =>
    Promise.resolve(this.providers),
  );

  invalidateSnapshot = vi.fn((provider: string, reason: string): Promise<void> => {
    this.invalidated.push([provider, reason]);
    return Promise.resolve();
  });

  refreshSample = vi.fn((provider: string) => {
    this.refreshed.push(provider);
    return Promise.resolve({ state: "accepted" as const, reason: "refresh_started" });
  });

  resumeDispatch = vi.fn((provider: string) => {
    this.resumed.push(provider);
    return Promise.resolve({ state: "accepted" as const, reason: "manual_review_recorded" });
  });
}

function createUseCase(port: QuotaDashboardPort): QuotaDashboardUseCase {
  return new QuotaDashboardUseCase(port, {
    now: () => instant("2026-08-04T12:05:00.000Z"),
    maxSampleAgeMs: 15 * 60 * 1_000,
    expectedCliVersions: { codex: "0.146.0", claude: "2.1.221", gemini: "0.52.0" },
  });
}

describe("quota UI read model", () => {
  it("keeps stale observed usage separate from the Codex weekly setting", async () => {
    const stale = (await fixture("quota-stale.json")).record;
    const port = new FakeQuotaDashboardPort([stale]);

    const dashboard = await createUseCase(port).read();
    const codex = dashboard.providers.find((provider) => provider.provider === "codex");
    if (codex === undefined) throw new Error("Codex read model is missing.");

    expect(codex.weeklyConfiguration).toEqual({ state: "configured", usageLimitPercent: 80 });
    expect(codex.buckets).toEqual([
      expect.objectContaining({ bucket: "weekly", state: "stale", reason: "sample_expired" }),
      expect.objectContaining({ bucket: "five_hour", state: "stale", reason: "sample_expired" }),
    ]);
    expect(codex.buckets.every((bucket) => bucket.remainingPercent === undefined)).toBe(true);
    expect(port.invalidated).toEqual([]);
  });

  it("keeps a missing five-hour signal unknown instead of rendering it as 0%", async () => {
    const unknown = (await fixture("quota-unknown.json")).record;
    const port = new FakeQuotaDashboardPort([unknown]);

    const dashboard = await createUseCase(port).read();
    const claude = dashboard.providers.find((provider) => provider.provider === "claude");
    if (claude === undefined) throw new Error("Claude read model is missing.");
    const fiveHour = claude.buckets.find((bucket) => bucket.bucket === "five_hour");
    if (fiveHour === undefined) throw new Error("Five-hour bucket is missing.");

    expect(claude.weeklyConfiguration).toEqual({ state: "configured", usageLimitPercent: 75 });
    expect(fiveHour).toEqual(
      expect.objectContaining({ state: "unknown", reason: "sample_missing" }),
    );
    expect(fiveHour.remainingPercent).toBeUndefined();
    const rendered = renderQuotaDashboard(dashboard);
    expect(rendered).toContain("五小時額度");
    expect(rendered).toContain("無法確認");
    expect(rendered).toContain("使用者設定週使用上限：<strong>75%</strong>");
    expect(rendered).toContain("93% 已使用 · 7% 剩餘");
    expect(rendered).not.toContain("五小時額度</h3><p>0%");
  });

  it("renders an explicitly invalidated sample as stale without retaining its percentage", async () => {
    const stale = (await fixture("quota-stale.json")).record;
    const snapshot = stale.snapshot;
    if (snapshot === undefined) throw new Error("Stale fixture is missing a snapshot.");
    const invalidated: QuotaProviderRecord = {
      ...stale,
      snapshot: {
        ...snapshot,
        samples: snapshot.samples.map((sample) =>
          sample.kind === "usage"
            ? { ...sample, state: "stale" as const, reason: "manual_reset" }
            : sample,
        ),
      },
    };

    const codex = (
      await createUseCase(new FakeQuotaDashboardPort([invalidated])).read()
    ).providers.find((provider) => provider.provider === "codex");
    if (codex === undefined) throw new Error("Codex read model is missing.");
    expect(codex.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "stale", reason: "sample_marked_stale" }),
      ]),
    );
    expect(codex.buckets.every((bucket) => bucket.remainingPercent === undefined)).toBe(true);
  });

  it("invalidates a switched account's old snapshot without refreshing or resuming it", async () => {
    const switched = (await fixture("quota-account-switch.json")).record;
    const port = new FakeQuotaDashboardPort([switched]);

    const dashboard = await createUseCase(port).read();
    const gemini = dashboard.providers.find((provider) => provider.provider === "gemini");
    if (gemini === undefined) throw new Error("Gemini read model is missing.");

    expect(port.invalidated).toEqual([["gemini", "account_switched"]]);
    expect(port.refreshed).toEqual([]);
    expect(port.resumed).toEqual([]);
    expect(gemini.accountSwitch).toEqual(
      expect.objectContaining({ state: "invalidated", reason: "account_switched" }),
    );
    expect(gemini.buckets).toEqual([
      expect.objectContaining({
        bucket: "availability",
        state: "stale",
        reason: "account_switched",
      }),
    ]);
    const rendered = renderQuotaDashboard(dashboard);
    expect(rendered).toContain("偵測到帳號切換，舊樣本已失效");
    expect(rendered).not.toContain("gemini-old-account-001");
    expect(rendered).not.toContain("gemini-new-account-002");
  });

  it("shows only allowlisted source labels and never echoes raw provider output or identities", async () => {
    const record: QuotaProviderRecord = {
      provider: "codex",
      activeIdentity: { provider: "codex", accountFingerprint: "codex-private-account-9900" },
      weeklyUsageLimitPercent: 80,
      snapshot: {
        provider: "codex",
        accountFingerprint: "codex-private-account-9900",
        samples: [
          {
            provider: "codex",
            accountFingerprint: "codex-private-account-9900",
            cliVersion: "0.146.0",
            source: "raw provider output: token=secret-value",
            observedAt: instant("2026-08-04T12:00:00.000Z"),
            kind: "usage",
            bucket: "weekly",
            state: "confirmed",
            remainingPercent: 64,
          },
          {
            provider: "codex",
            accountFingerprint: "codex-private-account-9900",
            cliVersion: "0.146.0",
            source: "raw provider output: token=secret-value",
            observedAt: instant("2026-08-04T12:00:00.000Z"),
            kind: "usage",
            bucket: "five_hour",
            state: "unknown",
            reason: "raw provider output: token=secret-value",
          },
        ],
      } satisfies QuotaSnapshot,
    };
    const rendered = renderQuotaDashboard(
      await createUseCase(new FakeQuotaDashboardPort([record])).read(),
    );

    expect(rendered).toContain("未驗證來源");
    expect(rendered).not.toContain("raw provider output");
    expect(rendered).not.toContain("secret-value");
    expect(rendered).not.toContain("codex-private-account-9900");
  });
});

describe("quota UI actions", () => {
  it("keeps refresh and manual resume as independent mutations", async () => {
    const port = new FakeQuotaDashboardPort([]);
    const useCase = createUseCase(port);

    await expect(useCase.refresh("codex")).resolves.toEqual({
      action: "refresh_sample",
      provider: "codex",
      state: "accepted",
      reason: "refresh_started",
    });
    expect(port.refreshed).toEqual(["codex"]);
    expect(port.resumed).toEqual([]);

    await expect(useCase.resume("codex")).resolves.toEqual({
      action: "resume_dispatch",
      provider: "codex",
      state: "accepted",
      reason: "manual_review_recorded",
    });
    expect(port.refreshed).toEqual(["codex"]);
    expect(port.resumed).toEqual(["codex"]);
  });

  it("rejects an unknown provider locally without calling either runtime mutation", async () => {
    const port = new FakeQuotaDashboardPort([]);
    const useCase = createUseCase(port);

    await expect(useCase.refresh("not-a-provider")).resolves.toEqual({
      action: "refresh_sample",
      provider: "unknown",
      state: "rejected",
      reason: "provider_invalid",
    });
    expect(port.refreshed).toEqual([]);
    expect(port.resumed).toEqual([]);
  });
});
