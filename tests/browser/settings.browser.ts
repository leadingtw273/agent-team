import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

import { parseInstant, type Instant } from "../../src/domain/foundation/index.js";
import {
  createDangerApprovalUseCase,
  createDangerUiFeatureRegistration,
  createSettingsUiFeatureRegistration,
  createSettingsUseCase,
  createUiApplication,
  FileSettingsStore,
  InMemoryDangerApprovalStore,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";
import {
  createQuotaUiFeature,
  QuotaDashboardUseCase,
  type QuotaDashboardPort,
} from "../../src/ui/features/quota/index.js";
import { createRoleModelFeature } from "../../src/ui/features/role-model/index.js";

let shell: LocalUiServerHandle | undefined;
let directory: string | undefined;
let sessionCookiePair: string | undefined;
let sessionCsrf: string | undefined;
const screenshotRoot = "/tmp/ui-review";
const screenshotWorktree = join(process.cwd(), "tmp", "ui-review");

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function quotaFeature() {
  const port: QuotaDashboardPort = {
    listProviders: () => Promise.resolve([]),
    invalidateSnapshot: () => Promise.resolve(),
    refreshSample: () => Promise.resolve({ state: "accepted" as const, reason: "refresh_started" }),
    resumeDispatch: () =>
      Promise.resolve({ state: "accepted" as const, reason: "manual_review_recorded" }),
  };
  return createQuotaUiFeature(
    new QuotaDashboardUseCase(port, {
      now: () => instant("2026-08-04T12:05:00.000Z"),
      maxSampleAgeMs: 15 * 60 * 1_000,
      expectedCliVersions: { codex: "0.146.0", claude: "2.1.221", gemini: "0.52.0" },
    }),
  );
}

function luminance(color: string): number {
  const legacy = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u.exec(color)?.slice(1).map(Number);
  const modern = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/u
    .exec(color)
    ?.slice(1)
    .map(Number);
  const channels = legacy?.map((channel) => channel / 255) ?? modern;
  if (channels?.length !== 3) throw new Error(`opaque sRGB expected: ${color}`);
  const values = channels.map((normalized) => {
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (values[0] ?? 0) + 0.7152 * (values[1] ?? 0) + 0.0722 * (values[2] ?? 0);
}

function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "settings-browser-"));
  await mkdir(join(directory, "config"));
  const application = createUiApplication({
    features: [
      createRoleModelFeature(),
      quotaFeature(),
      createDangerUiFeatureRegistration(
        createDangerApprovalUseCase(new InMemoryDangerApprovalStore()),
      ),
      createSettingsUiFeatureRegistration(
        createSettingsUseCase(new FileSettingsStore(join(directory, "config", "settings.yaml"))),
      ),
    ],
  });
  shell = await startLocalUiServer({
    securityPolicy: application.securityPolicy,
    handler: application.handler,
  });
  const exchange = await fetch(`${shell.baseUrl}/__session/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${shell.sessionToken}` },
  });
  sessionCookiePair = exchange.headers.get("set-cookie")?.split(";", 1)[0];
  sessionCsrf = exchange.headers.get("x-csrf-token") ?? undefined;
  if (sessionCookiePair === undefined || sessionCsrf === undefined) {
    throw new Error("session exchange failed");
  }
});

test.afterAll(async () => {
  await shell?.close();
  if (directory !== undefined) await rm(directory, { recursive: true });
});

async function visitSettings(page: Page): Promise<void> {
  if (shell === undefined || sessionCookiePair === undefined || sessionCsrf === undefined) {
    throw new Error("settings browser session missing");
  }
  const separator = sessionCookiePair.indexOf("=");
  if (separator <= 0) throw new Error("invalid session cookie");
  await page.context().addCookies([
    {
      name: sessionCookiePair.slice(0, separator),
      value: sessionCookiePair.slice(separator + 1),
      url: shell.baseUrl,
    },
  ]);
  await page.addInitScript(
    ({ origin, token }) => {
      const browser = globalThis as typeof globalThis & {
        readonly location?: { readonly origin: string };
        readonly sessionStorage: { setItem(key: string, value: string): void };
      };
      if (browser.location?.origin === origin) {
        browser.sessionStorage.setItem("agent-team-csrf", token);
      }
    },
    { origin: shell.baseUrl, token: sessionCsrf },
  );
  await page.addInitScript({ content: axe.source });
  await page.goto(`${shell.baseUrl}/settings`, { waitUntil: "networkidle" });
}

async function expectCanonicalYamlAtWidth(page: Page, width: 320 | 390): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  const metrics = await page.locator("#settings-raw-yaml").evaluate((element) => {
    const browser = globalThis as typeof globalThis & {
      getComputedStyle(target: unknown): Readonly<{ whiteSpace: string }>;
      readonly document: { readonly documentElement: { readonly scrollWidth: number } };
      readonly innerWidth: number;
    };
    const textarea = element as unknown as {
      readonly value: string;
      scrollLeft: number;
      readonly scrollWidth: number;
      readonly clientWidth: number;
    };
    const originalScrollLeft = textarea.scrollLeft;
    textarea.scrollLeft = textarea.scrollWidth;
    const maximumScrollLeft = textarea.scrollLeft;
    textarea.scrollLeft = originalScrollLeft;
    return {
      lastLine: textarea.value.trimEnd().split("\n").at(-1),
      whiteSpace: browser.getComputedStyle(element).whiteSpace,
      clientWidth: textarea.clientWidth,
      scrollWidth: textarea.scrollWidth,
      maximumScrollLeft,
      documentWidth: browser.document.documentElement.scrollWidth,
      viewportWidth: browser.innerWidth,
    };
  });
  expect(metrics.lastLine).toBe("  perRepositoryIntegrationJobs: 1");
  expect(metrics.whiteSpace).toBe("pre");
  expect(metrics.scrollWidth <= metrics.clientWidth || metrics.maximumScrollLeft > 0).toBe(true);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => {
      const browser = globalThis as typeof globalThis & {
        readonly document: { readonly documentElement: { readonly scrollWidth: number } };
        readonly innerWidth: number;
      };
      return browser.document.documentElement.scrollWidth <= browser.innerWidth;
    }),
  ).toBe(true);
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const violations = await page.evaluate(async () => {
    const browser = globalThis as typeof globalThis & {
      axe: { run(document: unknown): Promise<{ violations: unknown[] }> };
      readonly document: unknown;
    };
    return (await browser.axe.run(browser.document)).violations;
  });
  expect(violations).toEqual([]);
}

test("settings edit control has AA normal/focus contrast and no axe violations", async ({
  page,
}) => {
  await visitSettings(page);
  const edit = page.locator("#settings-edit");
  const normal = await edit.evaluate((element) => {
    const style = (
      globalThis as typeof globalThis & {
        getComputedStyle(target: unknown): Readonly<{ color: string; backgroundColor: string }>;
      }
    ).getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(contrast(normal.color, normal.background)).toBeGreaterThanOrEqual(4.5);

  const focusableCount = await page
    .locator(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    .count();
  for (let index = 0; index < focusableCount; index += 1) {
    const focused = await edit.evaluate(
      (element) =>
        element ===
        (globalThis as typeof globalThis & { readonly document?: { activeElement: unknown } })
          .document?.activeElement,
    );
    if (focused) break;
    await page.keyboard.press("Tab");
  }
  await expect(edit).toBeFocused();
  const focused = await edit.evaluate((element) => {
    const style = (
      globalThis as typeof globalThis & {
        getComputedStyle(target: unknown): Readonly<{
          outlineColor: string;
          backgroundColor: string;
        }>;
      }
    ).getComputedStyle(element);
    return { outline: style.outlineColor, background: style.backgroundColor };
  });
  expect(contrast(focused.outline, focused.background)).toBeGreaterThanOrEqual(3);

  await expectNoAxeViolations(page);
});

test("Role, Quota, Danger, and Settings share one mobile shell at 390px and 320px", async ({
  page,
}) => {
  await visitSettings(page);
  if (shell === undefined) throw new Error("settings browser session missing");

  for (const width of [390, 320] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    for (const destination of [
      { path: "/roles-models", title: "角色與模型", link: "角色與模型" },
      { path: "/quota", title: "額度", link: "額度" },
      { path: "/security", title: "安全核可", link: "安全" },
      { path: "/settings", title: "設定", link: "設定" },
    ] as const) {
      await page.goto(`${shell.baseUrl}${destination.path}`, { waitUntil: "networkidle" });
      const disclosure = page.locator("details.ui-mobile-nav");
      const toggle = disclosure.locator("summary");
      const navigation = disclosure.getByRole("navigation", { name: "主要導覽" });

      await expect(page.getByRole("heading", { level: 1, name: destination.title })).toBeVisible();
      await expect(page.locator(".ui-app")).toHaveCount(1);
      await expect(page.locator(".ui-sidebar")).toHaveCount(1);
      await expect(page.locator(".ui-brand")).toHaveCount(1);
      await expect(page.locator('a.skip-link[href="#main-content"]')).toHaveCount(1);
      await expect(disclosure).toBeVisible();
      await expect(disclosure).not.toHaveAttribute("open", "");
      await expect(toggle).toContainText(`目前頁面：${destination.link}`);
      await expect(navigation).toBeHidden();
      await expectNoHorizontalOverflow(page);

      await toggle.click();
      await expect(disclosure).toHaveAttribute("open", "");
      await expect(
        navigation.getByRole("link", { name: destination.link, exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page);

      await toggle.click();
      await expect(disclosure).not.toHaveAttribute("open", "");
    }
  }
});

test("raw YAML stays canonical on mobile and edit mode exposes the only save path", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await visitSettings(page);
  const editor = page.locator("#settings-raw-yaml");
  const edit = page.locator("#settings-edit");
  const cancel = page.locator("#settings-cancel");
  const save = page.locator("#settings-save");

  await expect(editor).toHaveAttribute("wrap", "off");
  await expect(editor).toHaveAttribute("readonly", "");
  await expect(edit).toBeVisible();
  await expect(cancel).toBeHidden();
  await expect(save).toBeHidden();
  await expect(page.locator("[placeholder]")).toHaveCount(0);

  const helperColors = await page.locator("#settings-webhook-help").evaluate((element) => {
    const browser = globalThis as typeof globalThis & {
      getComputedStyle(target: unknown): Readonly<{ color: string; backgroundColor: string }>;
      readonly document: { readonly body: unknown };
    };
    const target = element as unknown as { closest(selector: string): unknown };
    return {
      color: browser.getComputedStyle(element).color,
      background: browser.getComputedStyle(target.closest(".card") ?? browser.document.body)
        .backgroundColor,
    };
  });
  const statusColors = await page.locator("#settings-status").evaluate((element) => {
    const browser = globalThis as typeof globalThis & {
      getComputedStyle(target: unknown): Readonly<{ color: string; backgroundColor: string }>;
      readonly document: { readonly body: unknown };
    };
    const target = element as unknown as { closest(selector: string): unknown };
    return {
      color: browser.getComputedStyle(element).color,
      background: browser.getComputedStyle(target.closest(".card") ?? browser.document.body)
        .backgroundColor,
    };
  });
  expect(contrast(helperColors.color, helperColors.background)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(statusColors.color, statusColors.background)).toBeGreaterThanOrEqual(4.5);

  await mkdir(screenshotRoot, { recursive: true });
  await mkdir(screenshotWorktree, { recursive: true });
  await page.screenshot({
    path: `${screenshotRoot}/u008-settings-desktop-final.png`,
    fullPage: true,
  });
  await copyFile(
    `${screenshotRoot}/u008-settings-desktop-final.png`,
    join(screenshotWorktree, "u008-settings-desktop-final.png"),
  );

  await expectCanonicalYamlAtWidth(page, 390);
  await expect(page.locator("details.ui-mobile-nav")).not.toHaveAttribute("open", "");
  await page.screenshot({
    path: `${screenshotRoot}/u008-settings-390-final.png`,
    fullPage: true,
  });
  await copyFile(
    `${screenshotRoot}/u008-settings-390-final.png`,
    join(screenshotWorktree, "u008-settings-390-final.png"),
  );
  await edit.focus();
  await page.keyboard.press("Enter");
  await expect(editor).toBeFocused();
  await expect(editor).toBeEditable();
  await expect(edit).toBeHidden();
  await expect(cancel).toBeVisible();
  await expect(save).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(page.getByText("受控編輯已啟用；儲存前會重新驗證完整設定。")).toBeVisible();
  await editor.fill(
    (await editor.inputValue()).replace("globalModelJobs: 2", "globalModelJobs: 3"),
  );
  await page.keyboard.press("Control+s");
  await expect(page.getByText("設定已安全儲存。")).toBeVisible();
  await expect(page.locator("#settings-global-jobs")).toHaveValue("3");
  await expect(editor).toHaveAttribute("readonly", "");
  await expect(edit).toBeVisible();
  await expect(save).toBeHidden();

  await expectCanonicalYamlAtWidth(page, 320);
  await expectNoAxeViolations(page);
});
