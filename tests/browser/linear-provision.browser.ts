import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

import {
  createFixtureLinearProvisionUseCase,
  createRegistrationWizardUiFeatureRegistration,
  createUiApplication,
  fixtureRegistrationReadOnlyScanUseCase,
  fixtureUiShellReadModel,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const reviewDirectory = "/tmp/ui-review";
const worktreeReviewDirectory = join(process.cwd(), "tmp", "ui-review");
let shell: LocalUiServerHandle | undefined;
const authenticatedTargets = new WeakMap<Page, LocalUiServerHandle>();

interface AxeRunner {
  readonly run: (
    context: unknown,
    options: Readonly<{
      readonly runOnly: Readonly<{ readonly type: "tag"; readonly values: string[] }>;
    }>,
  ) => Promise<Readonly<{ readonly violations: readonly unknown[] }>>;
}

interface LayoutElement {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly getBoundingClientRect: () => Readonly<{ readonly right: number }>;
}

interface LayoutDocument {
  readonly documentElement: Readonly<{
    readonly clientWidth: number;
    readonly scrollWidth: number;
  }>;
  readonly querySelectorAll: (selectors: string) => readonly LayoutElement[];
}

function activeShell(): LocalUiServerHandle {
  if (shell === undefined) throw new Error("O003 browser shell did not start.");
  return shell;
}

async function visit(page: Page): Promise<void> {
  const target = activeShell();
  await page.context().addInitScript({ content: axe.source });
  if (authenticatedTargets.get(page) !== target) {
    await page.goto(`${target.baseUrl}/#${target.sessionToken}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => sessionStorage.getItem("agent-team-csrf") !== null);
    authenticatedTargets.set(page, target);
  }
  await page.goto(`${target.baseUrl}/registration`, { waitUntil: "domcontentloaded" });
  await page.locator("#linear-provision-section").waitFor();
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const violations = await page.evaluate(async () => {
    const browser = globalThis as typeof globalThis & {
      readonly axe?: AxeRunner;
      readonly document?: unknown;
    };
    if (browser.axe === undefined || browser.document === undefined) throw new Error("axe missing");
    return (
      await browser.axe.run(browser.document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
      })
    ).violations;
  });
  expect(violations).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const browser = globalThis as typeof globalThis & { readonly document?: LayoutDocument };
    if (browser.document === undefined) throw new Error("O003 document missing");
    const root = browser.document.documentElement;
    let overflowing = 0;
    for (const element of browser.document.querySelectorAll(
      ".ui-linear-provision, .ui-linear-summary, .ui-linear-action, .ui-linear-controls, .ui-linear-confirmation",
    )) {
      if (
        element.scrollWidth > element.clientWidth + 1 ||
        element.getBoundingClientRect().right > root.clientWidth + 1
      ) {
        overflowing += 1;
      }
    }
    return { documentFits: root.scrollWidth <= root.clientWidth, overflowing };
  });
  expect(layout).toEqual({ documentFits: true, overflowing: 0 });
}

async function screenshot(page: Page, name: string): Promise<void> {
  await Promise.all([
    mkdir(reviewDirectory, { recursive: true }),
    mkdir(worktreeReviewDirectory, { recursive: true }),
  ]);
  const temporaryPath = join(reviewDirectory, name);
  await page.screenshot({ path: temporaryPath, fullPage: true });
  await copyFile(temporaryPath, join(worktreeReviewDirectory, name));
}

test.describe("O003 Linear provision UI", () => {
  test.beforeEach(async () => {
    const application = createUiApplication({
      readModel: fixtureUiShellReadModel,
      features: [
        createRegistrationWizardUiFeatureRegistration(
          fixtureRegistrationReadOnlyScanUseCase,
          createFixtureLinearProvisionUseCase(),
        ),
      ],
    });
    shell = await startLocalUiServer({
      securityPolicy: application.securityPolicy,
      handler: application.handler,
    });
  });

  test.afterEach(async () => {
    await shell?.close();
    shell = undefined;
  });

  test("shows a synthetic diff, uses a keyboard-operable second confirmation, and reads back", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await visit(page);
    const section = page.getByRole("region", { name: "Linear 設定預覽" });
    await expect(section.getByText("設定未完成", { exact: true })).toBeVisible();
    await expect(section.getByText("可自動建立").locator("..").getByText("27")).toBeVisible();
    await expect(section.getByText("人工步驟").locator("..").getByText("6")).toBeVisible();
    await expect(section).toContainText("不刪除、不改名");
    await expect(section).toContainText("不從 Linear 留言取得核可");
    await expectNoAxeViolations(page);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, "o003-linear-provision-desktop.png");

    const review = section.getByRole("button", { name: "檢視套用確認" });
    await review.focus();
    await page.keyboard.press("Enter");
    const confirm = section.getByRole("button", { name: "確認套用 Linear 設定" });
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(review).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(section.getByRole("status")).toContainText("已建立並 read-back 27 項");
  });

  test("has no horizontal overflow at 390px and 320px and captures synthetic evidence", async ({
    page,
  }) => {
    for (const width of [390, 320] as const) {
      await page.setViewportSize({ width, height: 844 });
      await visit(page);
      await expect(page.getByRole("region", { name: "Linear 設定預覽" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page);
      await screenshot(page, `o003-linear-provision-${String(width)}.png`);
    }
  });
});
