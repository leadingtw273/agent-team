import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

import {
  createRegistrationWizardUiFeatureRegistration,
  createUiApplication,
  fixtureRegistrationReadOnlyScanUseCase,
  fixtureUiShellReadModel,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";
import type {
  RegistrationReadOnlyScanReadModel,
  RegistrationReadOnlyScanUseCase,
} from "../../src/application/registration/index.js";

const reviewDirectory = "/tmp/ui-review";
const worktreeReviewDirectory = join(process.cwd(), "tmp", "ui-review");
let shell: LocalUiServerHandle | undefined;
let longTextShell: LocalUiServerHandle | undefined;
const authenticatedTargets = new WeakMap<Page, LocalUiServerHandle>();

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: readonly unknown[];
}

interface AxeRunner {
  readonly run: (
    context: unknown,
    options: Readonly<{
      readonly runOnly: Readonly<{ readonly type: "tag"; readonly values: string[] }>;
    }>,
  ) => Promise<Readonly<{ readonly violations: readonly AxeViolation[] }>>;
}

interface LayoutElement {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly tagName: string;
  readonly getBoundingClientRect: () => Readonly<{ readonly right: number }>;
}

interface LayoutDocument {
  readonly documentElement: Readonly<{
    readonly clientWidth: number;
    readonly scrollWidth: number;
  }>;
  readonly querySelectorAll: (selectors: string) => readonly LayoutElement[];
}

function requiredShell(target: LocalUiServerHandle | undefined): LocalUiServerHandle {
  if (target === undefined) throw new Error("Registration Wizard UI did not start.");
  return target;
}

function baseUrl(target = shell): string {
  return requiredShell(target).baseUrl;
}

async function authenticate(page: Page, target = shell): Promise<void> {
  const activeShell = requiredShell(target);
  if (authenticatedTargets.get(page) === activeShell) return;
  await page.goto(`${baseUrl(activeShell)}/#${activeShell.sessionToken}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => sessionStorage.getItem("agent-team-csrf") !== null);
  authenticatedTargets.set(page, activeShell);
}

async function visit(page: Page, target = shell): Promise<void> {
  await page.context().addInitScript({ content: axe.source });
  await authenticate(page, target);
  await page.goto(`${baseUrl(target)}/registration`, { waitUntil: "domcontentloaded" });
  await page.locator("#main-content").waitFor();
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
      throw new Error("axe did not load into the page.");
    }
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
    const browser = globalThis as typeof globalThis & {
      readonly document?: LayoutDocument;
    };
    if (browser.document === undefined)
      throw new Error("Registration Wizard document is unavailable.");
    const root = browser.document.documentElement;
    const overflowingSelectors: string[] = [];
    for (const element of browser.document.querySelectorAll(
      ".ui-registration-card, .ui-registration-detail, .ui-registration-facts dd",
    )) {
      const rect = element.getBoundingClientRect();
      if (element.scrollWidth > element.clientWidth + 1 || rect.right > root.clientWidth + 1) {
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

function longTextUseCase(): RegistrationReadOnlyScanUseCase {
  return Object.freeze({
    scan: async (): Promise<RegistrationReadOnlyScanReadModel> => {
      const base = await fixtureRegistrationReadOnlyScanUseCase.scan();
      const first = base.gates[0];
      if (first === undefined) throw new Error("Registration fixture must have a first Gate.");
      return Object.freeze({
        ...base,
        gates: Object.freeze([
          Object.freeze({
            ...first,
            evidence: Object.freeze([`合成長證據${"資料".repeat(100)}`]),
            repair: `合成長修復建議${"步驟".repeat(100)}`,
          }),
          ...base.gates.slice(1),
        ]),
      });
    },
  });
}

async function startRegistrationShell(
  useCase: RegistrationReadOnlyScanUseCase,
): Promise<LocalUiServerHandle> {
  const application = createUiApplication({
    readModel: fixtureUiShellReadModel,
    features: [createRegistrationWizardUiFeatureRegistration(useCase)],
  });
  return startLocalUiServer({
    securityPolicy: application.securityPolicy,
    handler: application.handler,
  });
}

test.describe("O002 registration wizard", () => {
  test.beforeEach(async () => {
    shell = await startRegistrationShell(fixtureRegistrationReadOnlyScanUseCase);
    longTextShell = await startRegistrationShell(longTextUseCase());
  });

  test.afterEach(async () => {
    await Promise.all([shell?.close(), longTextShell?.close()]);
    shell = undefined;
    longTextShell = undefined;
  });

  test("navigates to 註冊精靈 with the keyboard and makes its read-only scope explicit", async ({
    page,
  }) => {
    await visit(page);
    const registrationLink = page
      .getByRole("navigation", { name: "主要導覽" })
      .getByRole("link", { name: "註冊精靈", exact: true });

    await registrationLink.focus();
    await expect(registrationLink).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(`${baseUrl()}/registration`);
    await expect(page.getByRole("heading", { level: 1, name: "註冊精靈" })).toBeVisible();
    await expect(registrationLink).toHaveAttribute("aria-current", "page");
    await expect(page.getByLabel("操作範圍")).toContainText("不建立 PR");
    await expect(page.getByText("這是合成示範資料")).toBeVisible();
  });

  test("renders eleven synthetic Gate cards without scripts, captures desktop, and passes axe", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await visit(page);

    const cards = page.getByRole("article");
    await expect(cards).toHaveCount(11);
    await expect(cards.filter({ hasText: "本機 Repository" })).toContainText("證據");
    await expect(page.getByRole("article", { name: "CI", exact: true })).toContainText("修復建議");
    await expect(cards.filter({ hasText: "Webhook Runtime" })).toContainText(
      "主動 delivery 驗證留待 O006",
    );
    await expect(page.locator("script")).toHaveCount(0);
    await expectNoAxeViolations(page);
    await copyReviewScreenshot(page, "o002-registration-wizard-desktop.png");
  });

  test("keeps synthetic Gates readable without horizontal overflow at 390px and 320px", async ({
    page,
  }) => {
    for (const width of [390, 320] as const) {
      await page.setViewportSize({ width, height: 844 });
      await visit(page);

      const mobileNavigation = page.locator("details.ui-mobile-nav");
      const activeLink = mobileNavigation.locator('a[href="/registration"]');
      await expect(page.getByRole("article")).toHaveCount(11);
      await expect(mobileNavigation).toHaveCount(1);
      await expect(activeLink).toHaveAttribute("aria-current", "page");
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page);
      await copyReviewScreenshot(page, `o002-registration-wizard-${String(width)}.png`);
    }
  });

  test("wraps long synthetic evidence and repair text at 390px and 320px", async ({ page }) => {
    for (const width of [390, 320] as const) {
      await page.setViewportSize({ width, height: 844 });
      await visit(page, longTextShell);

      const card = page.getByRole("article").first();
      await expect(card).toContainText("合成長證據");
      await expect(card).toContainText("合成長修復建議");
      await expectNoHorizontalOverflow(page);
    }
  });
});
