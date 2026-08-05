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
import type { RuntimeStatusReadModel } from "../../src/ui/features/runtime-status/index.js";

const reviewDirectory = "/tmp/ui-review";
const worktreeReviewDirectory = join(process.cwd(), "tmp", "ui-review");
let shell: LocalUiServerHandle | undefined;
let longIdentifierShell: LocalUiServerHandle | undefined;

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

interface RuntimeLayoutElement {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly tagName: string;
  readonly getBoundingClientRect: () => Readonly<{ readonly right: number }>;
}

interface RuntimeLayoutDocument {
  readonly documentElement: Readonly<{
    readonly clientWidth: number;
    readonly scrollWidth: number;
  }>;
  readonly querySelectorAll: (selectors: string) => readonly RuntimeLayoutElement[];
}

function requiredShell(target: LocalUiServerHandle | undefined): LocalUiServerHandle {
  if (target === undefined) throw new Error("Runtime status UI did not start.");
  return target;
}

function shellBaseUrl(target = shell): string {
  return requiredShell(target).baseUrl;
}

async function authenticate(page: Page, target = shell): Promise<void> {
  const activeShell = requiredShell(target);
  const sessionToken = activeShell.sessionToken;
  await page.context().route(`${shellBaseUrl(activeShell)}/**`, async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), authorization: `Bearer ${sessionToken}` },
    });
  });
}

async function visit(
  page: Page,
  path: "/" | "/runtime-status" = "/runtime-status",
  target = shell,
): Promise<void> {
  await authenticate(page, target);
  await page.goto(`${shellBaseUrl(target)}${path}`, { waitUntil: "networkidle" });
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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const browser = globalThis as typeof globalThis & {
      readonly document?: RuntimeLayoutDocument;
    };
    if (browser.document === undefined) throw new Error("Runtime status document is unavailable.");
    const root = browser.document.documentElement;
    const overflowingSelectors: string[] = [];
    for (const element of browser.document.querySelectorAll(
      ".ui-runtime-card, .ui-runtime-card code",
    )) {
      const rect = element.getBoundingClientRect();
      const horizontallyScrollable = element.scrollWidth > element.clientWidth + 1;
      const extendsPastViewport = rect.right > root.clientWidth + 1;
      if (horizontallyScrollable || extendsPastViewport) {
        overflowingSelectors.push(element.tagName.toLowerCase());
      }
    }

    return {
      documentFitsViewport: root.scrollWidth <= root.clientWidth,
      overflowingSelectors,
    };
  });

  expect(layout.documentFitsViewport).toBe(true);
  expect(layout.overflowingSelectors).toEqual([]);
}

function longIdentifier(value: string): string {
  return `${value}_${"long-runtime-identifier".repeat(20)}`;
}

function longIdentifierReadModel(): RuntimeStatusReadModel {
  const [source] = fixtureUiShellReadModel.listRuntimeStatuses();
  if (source === undefined)
    throw new Error("Runtime status fixture is required for visual coverage.");
  const checkpoint = source.checkpoint;

  return Object.freeze({
    source: "fixture",
    listRuntimeStatuses: () =>
      Object.freeze([
        Object.freeze({
          ...source,
          job: Object.freeze({
            ...source.job,
            id: longIdentifier("job") as typeof source.job.id,
            projectId: longIdentifier("project") as typeof source.job.projectId,
            issueId: longIdentifier("issue") as typeof source.job.issueId,
          }),
          lease: Object.freeze({
            ...source.lease,
            id: longIdentifier("lease") as typeof source.lease.id,
          }),
          ...(checkpoint === undefined
            ? {}
            : {
                checkpoint: Object.freeze({
                  ...checkpoint,
                  id: longIdentifier("checkpoint") as typeof checkpoint.id,
                }),
              }),
        }),
      ]),
  });
}

test.describe("U007 runtime status UI", () => {
  test.beforeAll(async () => {
    shell = await startLocalUiServer({ handler: createUiShellHandler(fixtureUiShellReadModel) });
    longIdentifierShell = await startLocalUiServer({
      handler: createUiShellHandler({ ...fixtureUiShellReadModel, ...longIdentifierReadModel() }),
    });
  });

  test.afterAll(async () => {
    await Promise.all([shell?.close(), longIdentifierShell?.close()]);
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

  test("keeps Runtime Status cards read-only after a touch tap at 390px", async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      await visit(page);
      const card = page.getByRole("article").first();
      const box = await card.boundingBox();

      expect(box).not.toBeNull();
      if (box === null) throw new Error("Runtime status card is not touchable.");
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

      await expect(page).toHaveURL(`${shellBaseUrl()}/runtime-status`);
      await expect(card).toContainText("Process 異常結束");
      await expect(card.getByRole("link")).toHaveCount(0);
    } finally {
      await context.close();
    }
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
    await expect(page.getByRole("region", { name: "Runtime 工作狀態" })).toContainText(
      "issue_11111111-1111-5111-8111-111111111111",
    );
    const crashCard = cards.filter({ hasText: "Process 異常結束" });
    await expect(crashCard).toContainText("實作者");
    await expect(crashCard.getByRole("listitem").filter({ hasText: "Crash 復航" })).toContainText(
      "1 / 1",
    );
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

  test("keeps every fixture readable without horizontal overflow at 390px and captures the 390px demo", async ({
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
    await expectNoHorizontalOverflow(page);
    await copyReviewScreenshot(page, "u007-runtime-status-390.png");
  });

  test("keeps every fixture readable without horizontal overflow at 320px and captures the 320px demo", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await visit(page);

    await expect(page.getByRole("article")).toHaveCount(4);
    await expect(page.getByText("週額度不足")).toBeVisible();
    await expect(page.getByText("等待危險操作核可")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await copyReviewScreenshot(page, "u007-runtime-status-320.png");
  });

  test("wraps synthetic long Job, Lease, and Checkpoint identifiers at 390px and 320px", async ({
    page,
  }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await visit(page, "/runtime-status", longIdentifierShell);

      const card = page.getByRole("article");
      await expect(card).toHaveCount(1);
      await expect(card).toContainText(longIdentifier("job"));
      await expect(card).toContainText(longIdentifier("lease"));
      await expect(card).toContainText(longIdentifier("checkpoint"));
      await expect(card.getByRole("listitem").filter({ hasText: "Crash 復航" })).toContainText(
        "1 / 1",
      );
      await expect(card).toContainText("原因");
      await expect(card).toContainText("下一步");
      await expectNoHorizontalOverflow(page);
    }
  });

  test("has no definite axe violations", async ({ page }) => {
    await visit(page);
    await expectNoAxeViolations(page);
  });
});
