import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import axe from "axe-core";

import {
  createUiShellHandler,
  fixtureUiShellReadModel,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const reviewDirectory = "/tmp/ui-review";
const worktreeReviewDirectory = join(process.cwd(), "tmp", "ui-review");
let shell: LocalUiServerHandle | undefined;

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
  const [redChannel, greenChannel, blueChannel] = matches.slice(1);
  if (redChannel === undefined || greenChannel === undefined || blueChannel === undefined) {
    throw new Error(`Expected red, green, and blue channels, received ${color}.`);
  }
  const linearize = (channel: string): number => {
    const normalized = Number(channel) / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const red = linearize(redChannel);
  const green = linearize(greenChannel);
  const blue = linearize(blueChannel);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function opaqueComposite(foreground: string, background: string): string {
  const foregroundMatch = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d*\.?\d+))?\)$/u.exec(
    foreground,
  );
  const backgroundMatch = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u.exec(background);
  if (foregroundMatch === null || backgroundMatch === null) {
    throw new Error(`Expected rgba foreground over rgb background, received ${foreground}.`);
  }
  const alpha = foregroundMatch[4] === undefined ? 1 : Number(foregroundMatch[4]);
  const channel = (index: 1 | 2 | 3): number =>
    Math.round(
      Number(foregroundMatch[index]) * alpha + Number(backgroundMatch[index]) * (1 - alpha),
    );
  return `rgb(${String(channel(1))}, ${String(channel(2))}, ${String(channel(3))})`;
}

interface FocusAppearance {
  readonly outlineColor: string;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
}

async function computedStyleColor(
  target: Locator,
  property: "backgroundColor" | "outlineColor",
): Promise<string> {
  return target.evaluate((element, styleProperty) => {
    const browser = globalThis as typeof globalThis & {
      readonly getComputedStyle?: (target: unknown) => Readonly<{
        readonly backgroundColor: string;
        readonly outlineColor: string;
      }>;
    };
    const style = browser.getComputedStyle?.(element);
    if (style === undefined) throw new Error("Computed styles are unavailable in the page.");
    return style[styleProperty];
  }, property);
}

async function computedFocusAppearance(target: Locator): Promise<FocusAppearance> {
  return target.evaluate((element) => {
    const browser = globalThis as typeof globalThis & {
      readonly getComputedStyle?: (target: unknown) => Readonly<FocusAppearance>;
    };
    const style = browser.getComputedStyle?.(element);
    if (style === undefined) throw new Error("Computed styles are unavailable in the page.");
    return {
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
}

async function hasKeyboardFocus(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const browser = globalThis as typeof globalThis & {
      readonly document?: Readonly<{ readonly activeElement?: unknown }>;
    };
    return browser.document?.activeElement === element;
  });
}

function shellBaseUrl(): string {
  if (shell === undefined) throw new Error("UI shell did not start.");
  return shell.baseUrl;
}

async function authenticate(page: Page): Promise<void> {
  if (shell === undefined) throw new Error("UI shell did not start.");
  const sessionToken = shell.sessionToken;
  await page.context().route(`${shellBaseUrl()}/**`, async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), authorization: `Bearer ${sessionToken}` },
    });
  });
}

async function visit(page: Page, path: "/" | "/projects" | "/events" = "/"): Promise<void> {
  await authenticate(page);
  await page.goto(`${shellBaseUrl()}${path}`, { waitUntil: "networkidle" });
}

async function copyReviewScreenshot(page: Page, name: string): Promise<void> {
  await Promise.all([
    mkdir(reviewDirectory, { recursive: true }),
    mkdir(worktreeReviewDirectory, { recursive: true }),
  ]);
  const temporaryPath = join(reviewDirectory, name);
  await page.screenshot({ path: temporaryPath, fullPage: false });
  await copyFile(temporaryPath, join(worktreeReviewDirectory, name));
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  await page.addScriptTag({ content: axe.source });
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

test.describe("U003 localhost UI shell", () => {
  test.beforeAll(async () => {
    shell = await startLocalUiServer({ handler: createUiShellHandler(fixtureUiShellReadModel) });
  });

  test.afterAll(async () => {
    await shell?.close();
  });

  test("uses semantic navigation for the three completed read-only pages", async ({ page }) => {
    await visit(page);
    const navigation = page.locator(".ui-nav--desktop");

    await expect(page.getByRole("heading", { level: 1, name: "總覽" })).toBeVisible();
    await expect(page.locator(".ui-mobile-nav")).toBeHidden();
    await expect(navigation.locator(".ui-nav-link")).toHaveCount(8);
    await expect(navigation.getByRole("link", { name: "總覽", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(navigation.getByText("執行中", { exact: true })).toBeVisible();
    await expect(navigation.getByText("後續", { exact: true }).first()).toBeVisible();

    await navigation.getByRole("link", { name: "專案", exact: true }).click();
    await expect(page).toHaveURL(`${shellBaseUrl()}/projects`);
    await expect(page.getByRole("heading", { level: 1, name: "專案" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "專案", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("table")).toBeVisible();

    await navigation.getByRole("link", { name: "事件", exact: true }).click();
    await expect(page).toHaveURL(`${shellBaseUrl()}/events`);
    await expect(page.getByRole("heading", { level: 1, name: "事件" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "事件", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByText("已載入有限示範資料。", { exact: true })).toBeVisible();
  });

  test("supports keyboard skip and keyboard navigation", async ({ page }) => {
    await visit(page);

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "跳至主要內容" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();

    const projectLink = page
      .locator(".ui-nav--desktop")
      .getByRole("link", { name: "專案", exact: true });
    await projectLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${shellBaseUrl()}/projects`);
    await expect(page.getByRole("heading", { level: 1, name: "專案" })).toBeVisible();
  });

  test("shows a visible, contrasting focus ring when the CTA receives keyboard focus", async ({
    page,
  }) => {
    await visit(page);
    const projectLink = page.getByRole("link", { name: "查看全部專案" });
    const projectCard = page
      .getByRole("heading", { name: "專案摘要" })
      .locator("xpath=ancestor::section");
    const beforeFocus = await computedFocusAppearance(projectLink);

    for (let index = 0; index < 16; index += 1) {
      const reachedCta = await projectLink.evaluate((element) => {
        const focusable = element as unknown as Readonly<{ matches(selector: string): boolean }>;
        return focusable.matches(":focus");
      });
      if (reachedCta) break;
      await page.keyboard.press("Tab");
    }
    await expect(projectLink).toBeFocused();

    const afterFocus = await computedFocusAppearance(projectLink);
    const cardBackground = await computedStyleColor(projectCard, "backgroundColor");

    expect(afterFocus.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(afterFocus.outlineWidth)).toBeGreaterThanOrEqual(2);
    expect(afterFocus.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(cardBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(contrastRatio(afterFocus.outlineColor, cardBackground)).toBeGreaterThanOrEqual(3);
    expect(afterFocus).not.toEqual(beforeFocus);
  });

  test("remains readable when the Tabler CDN is offline and captures desktop review", async ({
    page,
  }) => {
    await authenticate(page);
    await page.route("https://cdn.jsdelivr.net/npm/@tabler/core@1.4.0/**", async (route) => {
      await route.abort();
    });
    const localFallbackRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/assets/tabler-1.4.0.min.css",
    );

    await page.goto(`${shellBaseUrl()}/`, { waitUntil: "networkidle" });
    await localFallbackRequest;

    await expect(page.getByRole("heading", { level: 1, name: "總覽" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Alpha 產品探索");
    await expect(page.getByRole("link", { name: "查看全部專案" })).toBeVisible();
    await expect(page.getByRole("main")).toHaveCSS("display", "block");
    await expect(page).toHaveTitle("總覽｜Agent Team");
    const emptyStateIcon = page.locator(".ui-empty-state .ui-inline-icon");
    await expect(emptyStateIcon).toHaveCSS("width", "32px");
    await expect(emptyStateIcon).toHaveCSS("background-color", "rgb(233, 241, 255)");
    expect(
      await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              readonly document?: Readonly<{
                readonly scripts: Readonly<{ readonly length: number }>;
              }>;
            }
          ).document?.scripts.length ?? -1,
      ),
    ).toBe(0);
    await copyReviewScreenshot(page, "u003-ui-shell-desktop.png");
  });

  test("collapses mobile navigation by default and supports explicit open and close", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, "/events");

    const disclosure = page.locator("details.ui-mobile-nav");
    const toggle = disclosure.locator("summary");
    const navigation = disclosure.getByRole("navigation", { name: "主要導覽" });
    await expect(page.getByRole("heading", { level: 1, name: "事件" })).toBeVisible();
    await expect(page.locator(".ui-brand")).toBeVisible();
    await expect(disclosure).toBeVisible();
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(toggle).toContainText("目前頁面：事件");
    await expect(toggle).toContainText("開啟選單");
    await expect(navigation).toBeHidden();
    await expect(page.getByRole("table")).toBeVisible();

    await toggle.click();
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(toggle).toContainText("關閉選單");
    await expect(navigation).toBeVisible();
    await expect(navigation.locator(".ui-nav-link")).toHaveCount(8);
    await expect(navigation.getByRole("link", { name: "事件", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await toggle.click();
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(navigation).toBeHidden();
    await copyReviewScreenshot(page, "u003-ui-shell-mobile.png");
  });

  test("operates the mobile disclosure with a keyboard and exposes no axe violations", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, "/events");
    const disclosure = page.locator("details.ui-mobile-nav");
    const toggle = disclosure.locator("summary");
    const navigation = disclosure.getByRole("navigation", { name: "主要導覽" });

    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(navigation).toBeVisible();
    await expectNoAxeViolations(page);

    await page.keyboard.press("Tab");
    await expect(navigation.getByRole("link", { name: "總覽", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Space");
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(navigation).toBeHidden();
    await expectNoAxeViolations(page);
  });

  test("has no horizontal overflow at 320px with the mobile menu closed or open", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await visit(page, "/projects");
    const disclosure = page.locator("details.ui-mobile-nav");
    const noOverflow = (): Promise<boolean> =>
      page.evaluate(() => {
        const browser = globalThis as typeof globalThis & {
          readonly document?: Readonly<{
            readonly documentElement: Readonly<{ readonly scrollWidth: number }>;
          }>;
          readonly innerWidth?: number;
        };
        const documentElement = browser.document?.documentElement;
        return Promise.resolve(
          documentElement !== undefined && documentElement.scrollWidth <= (browser.innerWidth ?? 0),
        );
      });

    expect(await noOverflow()).toBe(true);
    await disclosure.locator("summary").click();
    await expect(disclosure).toHaveAttribute("open", "");
    expect(await noOverflow()).toBe(true);
  });

  test("meets contrast for inactive and future navigation text and the future badge", async ({
    page,
  }) => {
    await visit(page);
    const navigation = page.locator(".ui-nav--desktop");
    const inactive = navigation.getByRole("link", { name: "專案", exact: true });
    const future = navigation.locator(".ui-nav-link--future").filter({ hasText: "執行中" });
    const futureBadge = future.getByText("後續", { exact: true });
    const sidebar = page.locator(".ui-sidebar");
    const sidebarBackground = await computedStyleColor(sidebar, "backgroundColor");
    const styles = async (target: Locator): Promise<{ color: string; backgroundColor: string }> =>
      target.evaluate((element) => {
        const browser = globalThis as typeof globalThis & {
          readonly getComputedStyle?: (target: unknown) => Readonly<{
            readonly color: string;
            readonly backgroundColor: string;
          }>;
        };
        const style = browser.getComputedStyle?.(element);
        if (style === undefined) throw new Error("Computed styles are unavailable in the page.");
        return { color: style.color, backgroundColor: style.backgroundColor };
      });

    const inactiveStyle = await styles(inactive);
    const futureStyle = await styles(future);
    const badgeStyle = await styles(futureBadge);
    expect(contrastRatio(inactiveStyle.color, sidebarBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(futureStyle.color, sidebarBackground)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        badgeStyle.color,
        opaqueComposite(badgeStyle.backgroundColor, sidebarBackground),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("has no definite axe violations on each completed page", async ({ page }) => {
    for (const path of ["/", "/projects", "/events"] as const) {
      await visit(page, path);
      await expectNoAxeViolations(page);
    }
  });
});
