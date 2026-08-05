import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

import {
  createDangerApprovalUseCase,
  createDangerUiHandler,
  createUiSecurityPolicy,
  dangerUiRouteContract,
  InMemoryDangerApprovalStore,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";
import { dangerousOperationCategories } from "../../src/application/safety/index.js";

let shell: LocalUiServerHandle | undefined;
const screenshotRoot = "/tmp/ui-review";
const screenshotWorktree = join(process.cwd(), "tmp", "ui-review");

test.beforeAll(async () => {
  const waiting = [...dangerousOperationCategories, "unknown" as const].map((category, index) => ({
    requestId: `danger-${String(index + 1)}`,
    projectId: "project-alpha",
    projectName: "Alpha 測試專案",
    category,
    purpose: `驗證${category}的安全決策`,
    scope: `synthetic fixture ${String(index + 1)}`,
    revision: "abcdef"[index % 6]?.repeat(64) ?? "a".repeat(64),
  }));
  const routes = [
    dangerUiRouteContract,
    ...[
      "/security",
      "/assets/danger.js",
      "/assets/tabler-1.4.0.min.css",
      "/assets/ui-shell.css",
    ].map((path) => ({ path, allowedQueryParameters: [], response: "standard" as const })),
  ];
  shell = await startLocalUiServer({
    securityPolicy: createUiSecurityPolicy({ routes }),
    handler: createDangerUiHandler(
      createDangerApprovalUseCase(new InMemoryDangerApprovalStore(waiting)),
    ),
  });
});

test.afterAll(async () => shell?.close());

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

test("renders all categories, mutates by keyboard, remains responsive, and passes axe", async ({
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
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  const unknownCard = page.locator("article").filter({ hasText: "未知操作（只能拒絕）" });
  await expect(unknownCard.getByRole("button", { name: "核可一次" })).toBeDisabled();
  await expect(unknownCard.getByRole("button", { name: "此專案長期允許此類別" })).toHaveCount(0);
  await mkdir(screenshotRoot, { recursive: true });
  await mkdir(screenshotWorktree, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${screenshotRoot}/u006-danger-desktop.png`, fullPage: true });
  await copyFile(
    `${screenshotRoot}/u006-danger-desktop.png`,
    join(screenshotWorktree, "u006-danger-desktop.png"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshotRoot}/u006-danger-mobile.png`, fullPage: true });
  await copyFile(
    `${screenshotRoot}/u006-danger-mobile.png`,
    join(screenshotWorktree, "u006-danger-mobile.png"),
  );
  const firstReject = page.getByRole("button", { name: "拒絕" }).first();
  const focusables = await page
    .locator('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])')
    .count();
  for (let index = 0; index < focusables; index += 1) {
    const focused = await firstReject.evaluate(
      (element) =>
        element ===
        (globalThis as typeof globalThis & { document: { activeElement: unknown } }).document
          .activeElement,
    );
    if (focused) break;
    await page.keyboard.press("Tab");
  }
  await expect(firstReject).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("安全決策與稽核摘要已記錄。")).toBeVisible();

  expect(
    await page.evaluate(async () => {
      const browser = globalThis as typeof globalThis & {
        axe: { run(document: unknown): Promise<{ violations: unknown[] }> };
        document: unknown;
      };
      return (await browser.axe.run(browser.document)).violations;
    }),
  ).toEqual([]);
});
