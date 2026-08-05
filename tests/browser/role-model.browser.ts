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
    await expect(active).toHaveAttribute("data-active-candidate", "claude:sonnet");
    await expect(active).toContainText("啟動時順位 2");

    const implementers = page.locator(
      '[data-role-model-list="implementer"] > [data-candidate-key]',
    );
    await implementers.nth(1).dragTo(implementers.nth(0));
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["claude:sonnet", "codex:gpt-5.6-terra"]);

    await implementers.nth(0).dragTo(implementers.nth(1));
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["codex:gpt-5.6-terra", "claude:sonnet"]);
    const afterDownwardDrag = await candidateKeys(page, "implementer");
    expect(afterDownwardDrag).toHaveLength(2);
    expect(new Set(afterDownwardDrag).size).toBe(2);

    await implementers.nth(0).dragTo(implementers.nth(0));
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["codex:gpt-5.6-terra", "claude:sonnet"]);

    const implementerList = page.locator('[data-role-model-list="implementer"]');
    const firstBox = await implementers.nth(0).boundingBox();
    if (firstBox === null) throw new Error("implementer candidate is not visible");
    await implementers.nth(0).dragTo(implementerList, {
      targetPosition: { x: 4, y: Math.ceil(firstBox.height + 5) },
    });
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["codex:gpt-5.6-terra", "claude:sonnet"]);

    await implementers.nth(1).dragTo(implementers.nth(0));
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["claude:sonnet", "codex:gpt-5.6-terra"]);

    const teamLeadClaude = page.locator('[data-candidate-key="claude:opus"]').first();
    const moveUp = teamLeadClaude.getByRole("button", { name: /上移/u });
    await moveUp.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => candidateKeys(page, "team_lead"))
      .toEqual(["claude:opus", "codex:gpt-5.6-sol"]);

    await page.locator("[data-role-model-save]").click();
    await expect(page.locator("[data-role-model-status]")).toHaveText("已儲存並讀回目前設定。");
    await expect(active).toHaveAttribute("data-active-candidate", "claude:sonnet");
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
          candidate: { provider: "claude", model: "sonnet" },
          candidateIndex: 1,
        },
      ],
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect
      .poll(() => candidateKeys(page, "implementer"))
      .toEqual(["claude:sonnet", "codex:gpt-5.6-terra"]);
    await expect
      .poll(() => candidateKeys(page, "team_lead"))
      .toEqual(["claude:opus", "codex:gpt-5.6-sol"]);
    await expectNoAxeViolations(page);
    await copyReviewScreenshot(page, "u004-role-model-desktop.png");
  });

  test("keeps controls reachable without horizontal overflow on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page);

    await expect(page.getByRole("heading", { level: 1, name: "角色與模型" })).toBeVisible();
    await expect(page.locator("[data-role-model-save]")).toBeVisible();
    await expect(page.getByRole("button", { name: /下移/u }).first()).toBeVisible();
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
    await expectNoAxeViolations(page);
    await copyReviewScreenshot(page, "u004-role-model-mobile.png");
  });
});
