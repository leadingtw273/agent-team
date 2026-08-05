import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

import { parseInstant, type Instant } from "../../src/domain/foundation/index.js";
import {
  createQuotaUiFeature,
  QuotaDashboardUseCase,
  quotaUiSecurityRoutes,
  type QuotaDashboardPort,
  type QuotaMutationResult,
  type QuotaProviderId,
  type QuotaProviderRecord,
} from "../../src/ui/features/quota/index.js";
import {
  createUiSecurityPolicy,
  createUiShellHandler,
  fixtureUiShellReadModel,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const reviewDirectory = "/tmp/ui-review";
const worktreeReviewDirectory = join(process.cwd(), "tmp", "ui-review");

interface AxeViolation {
  readonly help: string;
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: readonly Readonly<{ readonly target: readonly string[] }>[];
}

interface AxeRunner {
  readonly run: (
    context: unknown,
    options: Readonly<{
      readonly runOnly: Readonly<{ readonly type: "tag"; readonly values: string[] }>;
    }>,
  ) => Promise<Readonly<{ readonly violations: readonly AxeViolation[] }>>;
}

function relativeLuminance(color: string): number {
  const matches = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u.exec(color);
  if (matches === null) throw new Error(`Expected an opaque rgb color, received ${color}.`);
  const channels = matches.slice(1).map(Number);
  if (channels.length !== 3) throw new Error(`Expected three RGB channels, received ${color}.`);
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const records: readonly QuotaProviderRecord[] = Object.freeze([
  Object.freeze({
    provider: "codex",
    activeIdentity: Object.freeze({
      provider: "codex",
      accountFingerprint: "codex-current-account-001",
    }),
    weeklyUsageLimitPercent: 80,
    snapshot: Object.freeze({
      provider: "codex",
      accountFingerprint: "codex-current-account-001",
      samples: Object.freeze([
        Object.freeze({
          provider: "codex",
          accountFingerprint: "codex-current-account-001",
          cliVersion: "0.146.0",
          source: "provider-structured-event",
          observedAt: instant("2026-08-04T11:00:00.000Z"),
          kind: "usage",
          bucket: "weekly",
          state: "confirmed",
          remainingPercent: 58,
          resetsAt: instant("2026-08-11T12:00:00.000Z"),
        }),
        Object.freeze({
          provider: "codex",
          accountFingerprint: "codex-current-account-001",
          cliVersion: "0.146.0",
          source: "provider-structured-event",
          observedAt: instant("2026-08-04T11:00:00.000Z"),
          kind: "usage",
          bucket: "five_hour",
          state: "confirmed",
          remainingPercent: 72,
          resetsAt: instant("2026-08-04T16:00:00.000Z"),
        }),
      ]),
    }),
  }),
  Object.freeze({
    provider: "claude",
    activeIdentity: Object.freeze({
      provider: "claude",
      accountFingerprint: "claude-current-account-001",
    }),
    weeklyUsageLimitPercent: 75,
    snapshot: Object.freeze({
      provider: "claude",
      accountFingerprint: "claude-current-account-001",
      samples: Object.freeze([
        Object.freeze({
          provider: "claude",
          accountFingerprint: "claude-current-account-001",
          cliVersion: "2.1.221",
          source: "provider-structured-event",
          observedAt: instant("2026-08-04T12:00:00.000Z"),
          kind: "usage",
          bucket: "weekly",
          state: "confirmed",
          remainingPercent: 7,
          resetsAt: instant("2026-08-10T12:00:00.000Z"),
        }),
      ]),
    }),
  }),
  Object.freeze({
    provider: "gemini",
    activeIdentity: Object.freeze({
      provider: "gemini",
      accountFingerprint: "gemini-new-account-002",
    }),
    snapshot: Object.freeze({
      provider: "gemini",
      accountFingerprint: "gemini-old-account-001",
      samples: Object.freeze([
        Object.freeze({
          provider: "gemini",
          accountFingerprint: "gemini-old-account-001",
          cliVersion: "0.52.0",
          source: "provider-structured-event",
          observedAt: instant("2026-08-04T12:00:00.000Z"),
          kind: "availability",
          state: "confirmed",
          available: true,
        }),
      ]),
    }),
  }),
]);

class BrowserQuotaPort implements QuotaDashboardPort {
  readonly invalidated: QuotaProviderId[] = [];
  readonly refreshed: QuotaProviderId[] = [];
  readonly resumed: QuotaProviderId[] = [];

  listProviders(): Promise<readonly QuotaProviderRecord[]> {
    return Promise.resolve(records);
  }

  invalidateSnapshot(provider: QuotaProviderId): Promise<void> {
    this.invalidated.push(provider);
    return Promise.resolve();
  }

  refreshSample(provider: QuotaProviderId): Promise<QuotaMutationResult> {
    this.refreshed.push(provider);
    return Promise.resolve({ state: "accepted", reason: "refresh_started" });
  }

  resumeDispatch(provider: QuotaProviderId): Promise<QuotaMutationResult> {
    this.resumed.push(provider);
    return Promise.resolve({ state: "accepted", reason: "manual_review_recorded" });
  }
}

let shell: LocalUiServerHandle | undefined;
let port: BrowserQuotaPort | undefined;

function actionPort(): BrowserQuotaPort {
  if (port === undefined) throw new Error("Quota port was not created.");
  return port;
}

async function visitQuota(page: Page): Promise<void> {
  if (shell === undefined) throw new Error("Quota UI server did not start.");
  await page.goto(`${shell.baseUrl}/#${shell.sessionToken}`, { waitUntil: "networkidle" });
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("agent-team-csrf")))
    .not.toBeNull();
  await page.goto(`${shell.baseUrl}/quota`, { waitUntil: "networkidle" });
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const violations = await page.evaluate(async () => {
    const browser = globalThis as typeof globalThis & {
      readonly axe?: AxeRunner;
      readonly document?: unknown;
    };
    if (browser.axe === undefined || browser.document === undefined) {
      throw new Error("axe did not load into the page.");
    }
    const result = await browser.axe.run(browser.document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
    });
    return result.violations;
  });
  expect(violations).toEqual([]);
}

async function copyReviewScreenshot(page: Page, name: string): Promise<void> {
  await Promise.all([
    mkdir(reviewDirectory, { recursive: true }),
    mkdir(worktreeReviewDirectory, { recursive: true }),
  ]);
  const temporaryPath = join(reviewDirectory, name);
  await page.screenshot({ path: temporaryPath, fullPage: true });
  await copyFile(temporaryPath, join(worktreeReviewDirectory, name));
}

async function hasNoHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const browser = globalThis as typeof globalThis & {
      readonly document?: Readonly<{
        readonly documentElement: Readonly<{ readonly scrollWidth: number }>;
      }>;
      readonly innerWidth?: number;
    };
    return (
      browser.document !== undefined &&
      browser.innerWidth !== undefined &&
      browser.document.documentElement.scrollWidth <= browser.innerWidth
    );
  });
}

test.describe("U005 quota management UI", () => {
  test.beforeEach(async () => {
    port = new BrowserQuotaPort();
    const quota = createQuotaUiFeature(
      new QuotaDashboardUseCase(port, {
        now: () => instant("2026-08-04T12:05:00.000Z"),
        maxSampleAgeMs: 15 * 60 * 1_000,
        expectedCliVersions: { codex: "0.146.0", claude: "2.1.221", gemini: "0.52.0" },
      }),
    );
    shell = await startLocalUiServer({
      securityPolicy: createUiSecurityPolicy({ routes: quotaUiSecurityRoutes }),
      handler: createUiShellHandler(fixtureUiShellReadModel, { quota }),
    });
  });

  test.afterEach(async ({ page }) => {
    await page.context().close();
    await shell?.close();
    shell = undefined;
    port = undefined;
  });

  test("renders stale, unknown, and account-switch states without inventing zero", async ({
    page,
  }) => {
    await visitQuota(page);

    const codex = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Codex" }) });
    const claude = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Claude" }) });
    const gemini = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Gemini" }) });
    await expect(codex).toContainText("使用者設定週使用上限：80%");
    await expect(codex).toContainText("已過期");
    await expect(claude.locator('[data-quota-state="fresh"]')).toContainText("已確認");
    const unknownFiveHour = claude
      .locator(".ui-quota-bucket")
      .filter({ has: page.getByRole("heading", { name: "五小時額度" }) });
    await expect(unknownFiveHour).toContainText("無法確認");
    await expect(unknownFiveHour).not.toContainText("0%");
    await expect(gemini.getByRole("complementary", { name: "帳號切換警示" })).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("codex-current-account-001");
    await expect(page.getByRole("main")).not.toContainText("gemini-new-account-002");
    await expect(page.getByRole("main")).not.toContainText("gemini-old-account-001");
    expect(actionPort().invalidated).toEqual([]);
    expect(actionPort().refreshed).toEqual([]);
    expect(actionPort().resumed).toEqual([]);
  });

  test("calls refresh and resume ports independently and reads back each status", async ({
    page,
  }) => {
    await visitQuota(page);
    const codex = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Codex" }) });
    const claude = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Claude" }) });

    await codex.getByRole("button", { name: "刷新樣本" }).click();
    await expect(codex.getByText("刷新樣本已完成 read-back。")).toBeVisible();
    expect(actionPort().refreshed).toEqual(["codex"]);
    expect(actionPort().resumed).toEqual([]);

    await claude.getByRole("button", { name: "確認並恢復派工" }).click();
    await expect(claude.getByText("手動覆核已記錄；恢復派工狀態已 read-back。")).toBeVisible();
    expect(actionPort().refreshed).toEqual(["codex"]);
    expect(actionPort().resumed).toEqual(["claude"]);
    expect(actionPort().invalidated).toEqual([]);
  });

  test("supports keyboard refresh and only then invalidates an account-switched snapshot", async ({
    page,
  }) => {
    await visitQuota(page);
    const gemini = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Gemini" }) });
    const refresh = gemini.getByRole("button", { name: "刷新樣本" });
    await refresh.focus();
    await expect(refresh).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(gemini.getByText("刷新樣本已完成 read-back。")).toBeVisible();

    expect(actionPort().invalidated).toEqual(["gemini"]);
    expect(actionPort().refreshed).toEqual(["gemini"]);
    expect(actionPort().resumed).toEqual([]);
  });

  test("passes axe, remains responsive, and captures desktop and mobile review", async ({
    page,
  }) => {
    await page.addInitScript({ content: axe.source });
    await visitQuota(page);
    await expect(page).toHaveTitle("額度｜Agent Team");
    await expect(page.getByRole("main")).toHaveCSS("display", "block");
    await expect(page.locator(".ui-app")).toHaveCSS("display", "grid");
    await expectNoAxeViolations(page);
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
    const stateBadges = page.locator(".ui-quota-state-badge");
    await expect(stateBadges).toHaveCount(5);
    await expect(stateBadges.locator(".ui-quota-state-symbol")).toHaveCount(5);
    for (let index = 0; index < (await stateBadges.count()); index += 1) {
      const badge = stateBadges.nth(index);
      const colors = await badge.evaluate((element) => {
        const browser = globalThis as typeof globalThis & {
          readonly getComputedStyle?: (target: unknown) => Readonly<{
            readonly color: string;
            readonly backgroundColor: string;
          }>;
        };
        const style = browser.getComputedStyle?.(element);
        if (style === undefined) throw new Error("Computed styles are unavailable.");
        return { foreground: style.color, background: style.backgroundColor };
      });
      expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
    }
    await copyReviewScreenshot(page, "u005-quota-desktop.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: "額度" })).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新樣本" }).first()).toBeVisible();
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
    await expectNoAxeViolations(page);
    await copyReviewScreenshot(page, "u005-quota-mobile.png");
  });
});
