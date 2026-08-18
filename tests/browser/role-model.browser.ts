import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

import {
  createRoleModelFeature,
  roleModelUiSecurityRoutes,
} from "../../src/ui/features/role-model/index.js";
import {
  createUiSecurityPolicy,
  createUiShellHandler,
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

type BrowserScrollEnvironment = typeof globalThis & {
  readonly document?: {
    readonly body: Readonly<{ readonly scrollHeight: number }>;
    readonly documentElement: {
      readonly scrollHeight: number;
      readonly style: { scrollBehavior: string };
    };
  };
  readonly innerHeight?: number;
  readonly scrollTo?: (x: number, y: number) => void;
  readonly scrollY?: number;
};

function baseUrl(): string {
  if (shell === undefined) throw new Error("role model UI did not start");
  return shell.baseUrl;
}

async function visit(page: Page): Promise<void> {
  if (shell === undefined) throw new Error("role model UI did not start");
  await page.context().addInitScript({ content: axe.source });
  await page.goto(`${baseUrl()}/#${shell.sessionToken}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => sessionStorage.getItem("agent-team-csrf") !== null);
  await page.goto(`${baseUrl()}/roles-models`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-role-model-save]")).toBeEnabled();
}

async function copyReviewScreenshot(page: Page, name: string, fullPage = true): Promise<void> {
  await Promise.all([
    mkdir(reviewDirectory, { recursive: true }),
    mkdir(worktreeReviewDirectory, { recursive: true }),
  ]);
  const temporaryPath = join(reviewDirectory, name);
  await page.screenshot({ path: temporaryPath, fullPage });
  await copyFile(temporaryPath, join(worktreeReviewDirectory, name));
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const violations = await page.evaluate(async () => {
    const browser = globalThis as typeof globalThis & {
      readonly axe?: AxeRunner;
      readonly document?: unknown;
    };
    if (browser.axe === undefined || browser.document === undefined) {
      throw new Error("axe did not load into the page");
    }
    const result = await browser.axe.run(browser.document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
    });
    return result.violations;
  });
  expect(violations).toEqual([]);
}

async function candidateKeys(page: Page, role: string): Promise<readonly (string | null)[]> {
  const items = await page.locator(`[data-role-model-list="${role}"] > [data-candidate-key]`).all();
  return Promise.all(items.map(async (item) => item.getAttribute("data-candidate-key")));
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => {
      const browser = globalThis as typeof globalThis & {
        readonly document?: Readonly<{ documentElement: Readonly<{ scrollWidth: number }> }>;
        readonly innerWidth?: number;
      };
      if (browser.document === undefined || browser.innerWidth === undefined) return false;
      return browser.document.documentElement.scrollWidth <= browser.innerWidth;
    }),
  ).toBe(true);
}

async function scrollInstantly(page: Page, top: number): Promise<void> {
  await page.evaluate((position) => {
    const browser = globalThis as BrowserScrollEnvironment;
    if (browser.document === undefined || browser.scrollTo === undefined) {
      throw new Error("browser scrolling is unavailable");
    }
    const root = browser.document.documentElement;
    const originalBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    browser.scrollTo(0, position);
    root.style.scrollBehavior = originalBehavior;
  }, top);
  await page.waitForFunction((position) => {
    const browser = globalThis as BrowserScrollEnvironment;
    if (browser.scrollY === undefined) return false;
    return position === 0 ? browser.scrollY <= 1 : browser.scrollY >= position - 1;
  }, top);
}

async function scrollToBottom(page: Page): Promise<void> {
  const bottom = await page.evaluate(() => {
    const browser = globalThis as BrowserScrollEnvironment;
    if (browser.document === undefined || browser.innerHeight === undefined) {
      throw new Error("browser scrolling is unavailable");
    }
    return (
      Math.max(browser.document.body.scrollHeight, browser.document.documentElement.scrollHeight) -
      browser.innerHeight
    );
  });
  await scrollInstantly(page, bottom);
}

test.describe("U004 role model configuration", () => {
  test.beforeEach(async () => {
    const feature = createRoleModelFeature();
    shell = await startLocalUiServer({
      handler: createUiShellHandler(undefined, feature),
      securityPolicy: createUiSecurityPolicy({ routes: roleModelUiSecurityRoutes }),
    });
  });

  test.afterEach(async () => {
    await shell?.close();
    shell = undefined;
  });

  test("persists mouse drag and keyboard reorder while preserving the running assignment", async ({
    page,
  }) => {
    await visit(page);
    const active = page.locator('[data-active-job-id="job-running-implementer"]');
    await expect(active).toHaveAttribute("data-active-candidate", "codex:gpt-5.6-sol");
    await expect(active).toContainText("啟動時順位 2");

    const teamLeadList = page.locator('[data-role-model-list="team_lead"]');
    await expect(teamLeadList).toHaveAttribute("aria-describedby", "role-team_lead-order-note");
    await expect(page.locator("#role-team_lead-order-note")).toContainText("新 Job 順序");
    const topCandidateMoveUp = teamLeadList
      .locator('[data-candidate-key="codex:gpt-5.6-sol"]')
      .getByRole("button", { name: "已在最上" });
    await expect(topCandidateMoveUp).toBeDisabled();
    await expect(topCandidateMoveUp).toHaveClass(/ui-role-model-action--boundary/u);
    await expect(topCandidateMoveUp).toHaveCSS("cursor", "not-allowed");

    const implementers = page.locator(
      '[data-role-model-list="implementer"] > [data-candidate-key]',
    );
    await implementers.nth(1).dragTo(implementers.nth(0));
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["codex:gpt-5.6-sol", "codex:gpt-5.6-terra"]);

    await implementers.nth(0).dragTo(implementers.nth(1));
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["codex:gpt-5.6-terra", "codex:gpt-5.6-sol"]);
    const afterDownwardDrag = await candidateKeys(page, "implementer");
    expect(afterDownwardDrag).toHaveLength(2);
    expect(new Set(afterDownwardDrag).size).toBe(2);

    await implementers.nth(0).dragTo(implementers.nth(0));
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["codex:gpt-5.6-terra", "codex:gpt-5.6-sol"]);

    const implementerList = page.locator('[data-role-model-list="implementer"]');
    const firstBox = await implementers.nth(0).boundingBox();
    if (firstBox === null) throw new Error("implementer candidate is not visible");
    await implementers.nth(0).dragTo(implementerList, {
      targetPosition: { x: 4, y: Math.ceil(firstBox.height + 5) },
    });
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["codex:gpt-5.6-terra", "codex:gpt-5.6-sol"]);

    await implementers.nth(1).dragTo(implementers.nth(0));
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["codex:gpt-5.6-sol", "codex:gpt-5.6-terra"]);

    const teamLeadTerra = page.locator('[data-candidate-key="codex:gpt-5.6-terra"]').first();
    const moveUp = teamLeadTerra.getByRole("button", { name: /上移/u });
    await moveUp.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => candidateKeys(page, "team_lead"))
      .toEqual(["codex:gpt-5.6-terra", "codex:gpt-5.6-sol"]);

    await page.locator("[data-role-model-save]").click();
    await expect(page.locator("[data-role-model-status]")).toHaveText("已儲存並讀回目前設定。");
    await expect(active).toHaveAttribute("data-active-candidate", "codex:gpt-5.6-sol");
    await expect(active).toContainText("啟動時順位 2");

    const apiSnapshot = await page.evaluate(async () => {
      const response = await fetch("/api/role-models", { credentials: "same-origin" });
      if (!response.ok) throw new Error("API read failed");
      return response.json();
    });
    expect(apiSnapshot).toMatchObject({
      activeAssignments: [
        {
          jobId: "job-running-implementer",
          candidate: { provider: "codex", model: "gpt-5.6-sol" },
          candidateIndex: 1,
        },
      ],
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["codex:gpt-5.6-sol", "codex:gpt-5.6-terra"]);
    await expect
      .poll(() => candidateKeys(page, "team_lead"))
      .toEqual(["codex:gpt-5.6-terra", "codex:gpt-5.6-sol"]);
    await expectNoAxeViolations(page);
    await copyReviewScreenshot(page, "u004-role-model-desktop.png");
  });

  test("reports read-back mismatch as uncertain without promising rollback", async ({ page }) => {
    await visit(page);
    await page.route("**/api/role-models", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "read_back_mismatch" }),
      });
    });

    await page.locator("[data-role-model-save]").click();

    const status = page.locator("[data-role-model-status]");
    await expect(status).toHaveText("儲存結果無法確認，請重新載入核對。");
    await expect(status).toHaveAttribute("data-state", "uncertain");
    await expect(status).not.toContainText(/未被覆寫|保留舊設定/u);
  });

  test("only promises no overwrite for a validation rejection", async ({ page }) => {
    await visit(page);
    await page.route("**/api/role-models", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_input" }),
      });
    });

    await page.locator("[data-role-model-save]").click();

    const status = page.locator("[data-role-model-status]");
    await expect(status).toHaveText("輸入驗證失敗；原設定未被覆寫。請修正後再試。");
    await expect(status).toHaveAttribute("data-state", "error");
  });

  test("treats a non-422 response as uncertain even with a validation error code", async ({
    page,
  }) => {
    await visit(page);
    await page.route("**/api/role-models", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_input" }),
      });
    });

    await page.locator("[data-role-model-save]").click();

    const status = page.locator("[data-role-model-status]");
    await expect(status).toHaveText("儲存失敗；無法確認目前設定，請重新載入核對。");
    await expect(status).toHaveAttribute("data-state", "uncertain");
    await expect(status).not.toContainText(/未被覆寫|保留舊設定/u);
  });

  test("keeps the sticky save action reachable without horizontal overflow at 390px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page);

    const save = page.locator("[data-role-model-action-bar]");
    await expect(page.getByRole("heading", { level: 1, name: "角色與模型" })).toBeVisible();
    await expect(save).toHaveCSS("position", "sticky");
    await expect(save.getByRole("button", { name: "儲存模型順序" })).toBeVisible();
    await expect(page.getByRole("button", { name: /下移/u }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await scrollToBottom(page);
    await expect(save).toBeVisible();
    const saveBox = await save.boundingBox();
    if (saveBox === null) throw new Error("sticky save action is not visible");
    expect(saveBox.y).toBeGreaterThanOrEqual(0);
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(844);
    await expectNoAxeViolations(page);
    await copyReviewScreenshot(page, "u004-role-model-390.png", false);
  });

  test("keeps the sticky save action reachable without horizontal overflow at 320px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await visit(page);

    const save = page.locator("[data-role-model-action-bar]");
    await expect(save).toHaveCSS("position", "sticky");
    await expectNoHorizontalOverflow(page);
    await scrollToBottom(page);
    await expect(save.getByRole("button", { name: "儲存模型順序" })).toBeVisible();
    const saveBox = await save.boundingBox();
    if (saveBox === null) throw new Error("sticky save action is not visible");
    expect(saveBox.y).toBeGreaterThanOrEqual(0);
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(720);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await copyReviewScreenshot(page, "u004-role-model-320.png", false);
  });
});
