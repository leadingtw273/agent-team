import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
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

function shellBaseUrl(): string {
  if (shell === undefined) throw new Error("Runtime status UI did not start.");
  return shell.baseUrl;
}

async function authenticate(page: Page): Promise<void> {
  if (shell === undefined) throw new Error("Runtime status UI did not start.");
  const sessionToken = shell.sessionToken;
  await page.context().route(`${shellBaseUrl()}/**`, async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), authorization: `Bearer ${sessionToken}` },
    });
  });
}

async function visit(page: Page, path: "/" | "/runtime-status" = "/runtime-status"): Promise<void> {
  await authenticate(page);
  await page.goto(`${shellBaseUrl()}${path}`, { waitUntil: "networkidle" });
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

test.describe("U007 runtime status UI", () => {
  test.beforeAll(async () => {
    shell = await startLocalUiServer({ handler: createUiShellHandler(fixtureUiShellReadModel) });
  });

  test.afterAll(async () => {
    await shell?.close();
  });

  test("navigates to 執行中 with the keyboard", async ({ page }) => {
    await visit(page, "/");
    const runtimeStatusLink = page
      .getByRole("navigation", { name: "主要導覽" })
      .getByRole("link", { name: "執行中", exact: true });

    await runtimeStatusLink.focus();
    await expect(runtimeStatusLink).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(`${shellBaseUrl()}/runtime-status`);
    await expect(page.getByRole("heading", { level: 1, name: "執行中" })).toBeVisible();
    await expect(runtimeStatusLink).toHaveAttribute("aria-current", "page");
  });

  test("renders all four safe blocker fixtures with the offline Tabler fallback and captures desktop", async ({
    page,
  }) => {
    await authenticate(page);
    await page.route("https://cdn.jsdelivr.net/npm/@tabler/core@1.4.0/**", async (route) => {
      await route.abort();
    });
    const localFallbackRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/assets/tabler-1.4.0.min.css",
    );
    await page.goto(`${shellBaseUrl()}/runtime-status`, { waitUntil: "networkidle" });
    await localFallbackRequest;

    const cards = page.getByRole("article");
    await expect(cards).toHaveCount(4);
    await expect(cards.filter({ hasText: "Process 異常結束" })).toContainText("實作者");
    await expect(cards.filter({ hasText: "Process 異常結束" })).toContainText("Crash 復航 1 / 1");
    await expect(cards.filter({ hasText: "週額度不足" })).toContainText("5 小時額度限制");
    const dangerCard = cards.filter({ hasText: "等待危險操作核可" });
    await expect(dangerCard).toContainText("Git 破壞性操作");
    await expect(dangerCard).toContainText(
      "安全核可功能尚未接入，本頁僅呈現等待狀態，現在不可操作。",
    );
    await expect(dangerCard).not.toContainText("在安全頁確認類別、目的與範圍後核可或拒絕");
    await expect(dangerCard.getByRole("link")).toHaveCount(0);
    await expect(
      page
        .getByRole("navigation", { name: "主要導覽" })
        .getByRole("link", { name: "安全", exact: true }),
    ).toHaveCount(0);
    await expect(cards.filter({ hasText: "未知錯誤" })).toContainText("已到 60 分鐘硬邊界並停止");
    await expect(page.getByText("不顯示完整命令、Secret 或模型隱藏推理")).toBeVisible();
    await expect(page.getByText("45 分鐘檢查").first()).toBeVisible();
    await expect(page.getByText("60 分鐘硬邊界").first()).toBeVisible();
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
    await copyReviewScreenshot(page, "u007-runtime-status-desktop.png");
  });

  test("keeps every fixture readable without horizontal overflow on mobile and captures mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page);

    const cards = page.getByRole("article");
    await expect(cards).toHaveCount(4);
    await expect(page.getByText("週額度不足")).toBeVisible();
    await expect(page.getByText("5 小時額度限制")).toBeVisible();
    await expect(page.getByText("等待危險操作核可")).toBeVisible();
    await expect(page.getByText("未知錯誤", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => {
        const browser = globalThis as typeof globalThis & {
          readonly document?: Readonly<{
            readonly documentElement: Readonly<{
              readonly scrollWidth: number;
              readonly clientWidth: number;
            }>;
          }>;
        };
        const documentElement = browser.document?.documentElement;
        return (
          documentElement !== undefined &&
          documentElement.scrollWidth <= documentElement.clientWidth
        );
      }),
    ).toBe(true);
    await copyReviewScreenshot(page, "u007-runtime-status-mobile.png");
  });

  test("has no definite axe violations", async ({ page }) => {
    await visit(page);
    await expectNoAxeViolations(page);
  });
});
