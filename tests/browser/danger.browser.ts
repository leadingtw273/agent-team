import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

import { dangerousOperationCategories } from "../../src/application/safety/index.js";
import {
  createDangerApprovalUseCase,
  createDangerUiHandler,
  createUiSecurityPolicy,
  dangerUiRouteContract,
  InMemoryDangerApprovalStore,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

let shell: LocalUiServerHandle | undefined;
const screenshotRoot = "/tmp/ui-review";
const screenshotWorktree = join(process.cwd(), "tmp", "ui-review");
const waiting = Object.freeze(
  [...dangerousOperationCategories, "unknown" as const].map((category, index) =>
    Object.freeze({
      requestId: `danger-${String(index + 1)}`,
      projectId: "project-alpha",
      projectName: "Alpha 測試專案",
      category,
      purpose: `驗證${category}的安全決策`,
      scope: `synthetic fixture ${String(index + 1)}`,
      revision: "abcdef"[index % 6]?.repeat(64) ?? "a".repeat(64),
    }),
  ),
);

test.beforeEach(async () => {
  const routes = [
    dangerUiRouteContract,
    ...[
      "/security",
      "/assets/danger.js",
      "/assets/tabler-1.4.0.min.css",
      "/assets/ui-shell.css",
    ].map((path) => ({
      path,
      allowedQueryParameters: [],
      allowedMethods: ["GET"] as const,
      response: "standard" as const,
    })),
  ];
  shell = await startLocalUiServer({
    securityPolicy: createUiSecurityPolicy({ routes }),
    handler: createDangerUiHandler(
      createDangerApprovalUseCase(new InMemoryDangerApprovalStore(waiting)),
    ),
  });
});

test.afterEach(async () => {
  await shell?.close();
  shell = undefined;
});

async function visit(page: Page): Promise<void> {
  if (shell === undefined) throw new Error("danger server missing");
  await page.goto(`${shell.baseUrl}/#${shell.sessionToken}`);
  await page.waitForFunction(
    () =>
      (
        globalThis as typeof globalThis & {
          sessionStorage: { getItem(key: string): string | null };
        }
      ).sessionStorage.getItem("agent-team-csrf") !== null,
  );
  await page.goto(`${shell.baseUrl}/security`, { waitUntil: "networkidle" });
}

function requestCard(page: Page, requestId: string) {
  return page.locator(`article[data-request-id="${requestId}"]`);
}

async function capture(page: Page, name: string, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  expect(
    await page.evaluate(() => {
      const browser = globalThis as typeof globalThis & {
        document: { documentElement: { scrollWidth: number } };
        innerWidth: number;
      };
      return browser.document.documentElement.scrollWidth <= browser.innerWidth;
    }),
  ).toBe(true);
  await page.screenshot({ path: `${screenshotRoot}/${name}`, fullPage: true });
  await copyFile(`${screenshotRoot}/${name}`, join(screenshotWorktree, name));
}

async function axeViolations(page: Page): Promise<unknown[]> {
  return await page.evaluate(async () => {
    const browser = globalThis as typeof globalThis & {
      axe: { run(document: unknown): Promise<{ violations: unknown[] }> };
      document: unknown;
    };
    return (await browser.axe.run(browser.document)).violations;
  });
}

async function visibleButtonHeights(page: Page, selector: string): Promise<number[]> {
  const buttons = page.locator(selector);
  const heights: number[] = [];
  for (let index = 0; index < (await buttons.count()); index += 1) {
    const box = await buttons.nth(index).boundingBox();
    if (box !== null) heights.push(box.height);
  }
  return heights;
}

test("renders explicit warnings and unknown rejection safely at 320 and 390 pixels", async ({
  page,
}) => {
  await page.addInitScript({ content: axe.source });
  await visit(page);
  await expect(page.getByRole("heading", { level: 1, name: "安全核可" })).toBeVisible();
  for (const label of [
    "專案破壞性操作",
    "Git 破壞性操作",
    "本機環境變更",
    "部署變更",
    "外部系統寫入",
    "Secret 存取",
    "付費操作",
    "未知操作（只能拒絕）",
  ]) {
    await expect(page.locator(".badge").getByText(label, { exact: true })).toBeVisible();
  }
  const unknownCard = requestCard(page, "danger-8");
  await expect(unknownCard.getByText("未知類別只能拒絕", { exact: true })).toBeVisible();
  await expect(unknownCard.getByRole("button", { name: "核可一次" })).toHaveCount(0);
  await expect(unknownCard.getByRole("button", { name: /長期允許/u })).toHaveCount(0);
  await expect(unknownCard.getByRole("button", { name: "拒絕" })).toHaveCount(1);
  await expect(
    requestCard(page, "danger-1").getByRole("button", { name: /長期允許/u }),
  ).toContainText("⚠");
  await mkdir(screenshotRoot, { recursive: true });
  await mkdir(screenshotWorktree, { recursive: true });
  await capture(page, "u006-danger-desktop.png", 1440, 900);
  await capture(page, "u006-danger-mobile.png", 390, 844);
  const firstCard = requestCard(page, "danger-1");
  const touchHeights = await visibleButtonHeights(
    page,
    '[data-request-id="danger-1"] button:visible',
  );
  expect(touchHeights.every((height) => height >= 44)).toBe(true);
  const longTermBox = await firstCard.getByRole("button", { name: /長期允許/u }).boundingBox();
  const rejectBox = await firstCard.getByRole("button", { name: "拒絕" }).boundingBox();
  if (longTermBox === null || rejectBox === null) throw new Error("danger action box missing");
  expect(rejectBox.y - (longTermBox.y + longTermBox.height)).toBeGreaterThanOrEqual(20);
  expect(await axeViolations(page)).toEqual([]);
  await firstCard.getByRole("button", { name: "核可一次" }).click();
  await expect(firstCard.locator("[data-confirmation]")).toBeVisible();
  await capture(page, "u006-danger-confirm-mobile.png", 390, 844);
  expect(
    (
      await visibleButtonHeights(
        page,
        '[data-request-id="danger-1"] [data-confirmation] button:visible',
      )
    ).every((height) => height >= 44),
  ).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await firstCard.getByRole("button", { name: "取消" }).click();
  await capture(page, "u006-danger-mobile-320.png", 320, 844);
  expect(await axeViolations(page)).toEqual([]);
});

test("requires an explicit keyboard-confirmed second step for both approval commands", async ({
  page,
}) => {
  const commands: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/api/danger")) {
      commands.push(request.postDataJSON());
    }
  });
  await visit(page);

  const approveCard = requestCard(page, "danger-1");
  const approve = approveCard.getByRole("button", { name: "核可一次" });
  await approve.click();
  await page.waitForLoadState("networkidle");
  expect(commands).toEqual([]);
  const approvePanel = approveCard.locator("[data-confirmation]");
  await expect(approvePanel).toBeVisible();
  await expect(approvePanel).toContainText("Alpha 測試專案");
  await expect(approvePanel).toContainText("專案破壞性操作");
  await expect(approvePanel).toContainText("a".repeat(64));
  const approveConfirm = approvePanel.getByRole("button", { name: "確認核可一次" });
  const approveCancel = approvePanel.getByRole("button", { name: "取消" });
  await expect(approveConfirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(approveCancel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(approvePanel).toBeHidden();
  await expect(approve).toBeFocused();
  expect(commands).toEqual([]);

  await approve.click();
  await page.keyboard.press("Enter");
  await expect(approveCard).toHaveCount(0);
  expect(commands).toEqual([
    {
      requestId: "danger-1",
      projectId: "project-alpha",
      category: "project_destructive",
      expectedRevision: "a".repeat(64),
      decision: "approve_once",
    },
  ]);

  const longTermCard = requestCard(page, "danger-2");
  await longTermCard.getByRole("button", { name: /長期允許/u }).click();
  await page.waitForLoadState("networkidle");
  expect(commands).toHaveLength(1);
  const longTermPanel = longTermCard.locator("[data-confirmation]");
  await expect(longTermPanel).toContainText("之後相同專案與類別的請求");
  await expect(longTermPanel).toContainText("Git 破壞性操作");
  await expect(longTermPanel.getByRole("button", { name: "確認長期允許" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(longTermCard).toHaveCount(0);
  expect(commands[1]).toEqual({
    requestId: "danger-2",
    projectId: "project-alpha",
    category: "git_destructive",
    expectedRevision: "b".repeat(64),
    decision: "allow_project_category",
  });
});

test("collapses double clicks to one request and keeps stale CAS conflicts visible", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route("**/api/danger", async (route) => {
    const command = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(command);
    if (command["requestId"] === "danger-1") {
      await firstResponseGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"state":"saved"}',
      });
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: '{"state":"error","code":"conflict"}',
    });
  });
  await visit(page);

  const firstCard = requestCard(page, "danger-1");
  await firstCard.getByRole("button", { name: "核可一次" }).dblclick();
  expect(commands).toEqual([]);
  const firstConfirm = firstCard.getByRole("button", { name: "確認核可一次" });
  await firstConfirm.dblclick();
  await expect.poll(() => commands.length).toBe(1);
  await expect(firstConfirm).toBeDisabled();
  releaseFirst?.();
  await expect(firstCard).toHaveCount(0);

  const staleCard = requestCard(page, "danger-2");
  await staleCard.getByRole("button", { name: "核可一次" }).click();
  await staleCard.getByRole("button", { name: "確認核可一次" }).click();
  await expect(page.getByText("項目已更新，請重新載入。")).toBeVisible();
  await expect(staleCard).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(
    expect.objectContaining({ requestId: "danger-2", expectedRevision: "b".repeat(64) }),
  );
});
