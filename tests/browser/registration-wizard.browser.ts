import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

import {
  createFixtureRegistrationWizardUiFeatureRegistration,
  createUiApplication,
  fixtureRegistrationReadOnlyScanUseCase,
  fixtureUiShellReadModel,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";
import type {
  RegistrationReadOnlyScanReadModel,
  RegistrationReadOnlyScanUseCase,
  RegistrationSetupControllerReadModel,
  RegistrationSetupControllerUseCase,
} from "../../src/application/registration/index.js";

const reviewDirectory = "/tmp/ui-review";
const worktreeReviewDirectory = join(process.cwd(), "tmp", "ui-review");
let shell: LocalUiServerHandle | undefined;
let longTextShell: LocalUiServerHandle | undefined;
const authenticatedTargets = new WeakMap<Page, LocalUiServerHandle>();
const setupSessionId = `setup-${"c".repeat(64)}`;
const setupPreviewDigest = "b".repeat(64);
const setupPreviewModel: RegistrationSetupControllerReadModel = Object.freeze({
  state: "preview_ready",
  evidence: Object.freeze([
    Object.freeze({ code: "merge_w3b_unwired", message: "merge remains unavailable" }),
    Object.freeze({ code: "audit_w3b_unwired", message: "audit remains unavailable" }),
    Object.freeze({ code: "activation_w3b_unwired", message: "activation remains unavailable" }),
    Object.freeze({
      code: "conversation_approval_w3b_unwired",
      message: "conversation approval remains unavailable",
    }),
  ]),
  nextStep: "確認 server-side preview。",
  preview: Object.freeze({
    setupSessionId,
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectName: "Sandbox",
    repository: "owner/sandbox",
    defaultBranch: "main",
    baseRevision: "d".repeat(40),
    previewDigest: setupPreviewDigest,
    requirementsDigest: "e".repeat(64),
    linearAuditIssueId: "LINEAR-AUDIT-1",
  }),
});

const setupPendingSession = Object.freeze({
  setupSessionId,
  revision: 7,
  phase: "merge_pending" as const,
  pullRequestUrl: "https://github.test/owner/sandbox/pull/42",
  changeRequestId: "PR_node_1",
  headSha: "f".repeat(40),
  diffDigest: "a".repeat(64),
  ciPassed: true,
  freshReviewPassed: true,
});

const setupMergePendingModel: RegistrationSetupControllerReadModel = Object.freeze({
  ...setupPreviewModel,
  state: "merge_pending",
  nextStep: "繼續 authoritative merge／activation 驗證。",
  session: setupPendingSession,
});

const setupAwaitingApprovalModel: RegistrationSetupControllerReadModel = Object.freeze({
  ...setupMergePendingModel,
  state: "awaiting_user_approval",
  nextStep: "簽發本機核可 intent。",
  session: Object.freeze({
    ...setupPendingSession,
    phase: "awaiting_user_approval",
  }),
});

const setupActivatedModel: RegistrationSetupControllerReadModel = Object.freeze({
  ...setupMergePendingModel,
  state: "activated",
  nextStep: "Activation 與 project index 已確認。",
  session: Object.freeze({
    ...setupPendingSession,
    revision: 8,
    phase: "activated",
  }),
});

function setupController(): RegistrationSetupControllerUseCase {
  return Object.freeze({
    read: () => Promise.resolve(setupPreviewModel),
    confirmPreview: () =>
      Promise.resolve(
        Object.freeze({
          state: "preview_confirmation_issued" as const,
          setupSessionId,
          previewDigest: setupPreviewDigest,
          tokenId: "preview-token-1",
          expiresAt: "2026-08-06T12:05:00.000Z",
        }),
      ),
    start: () =>
      Promise.resolve(Object.freeze({ ...setupPreviewModel, state: "ci_waiting" as const })),
    refresh: () => Promise.resolve(setupPreviewModel),
    resume: () =>
      Promise.resolve(Object.freeze({ state: "blocked" as const, reason: "not_found" as const })),
    issueLocalUiApprovalIntent: () =>
      Promise.resolve(Object.freeze({ state: "blocked" as const, reason: "not_found" as const })),
    approveAndMergeLocalUi: () =>
      Promise.resolve(Object.freeze({ state: "blocked" as const, reason: "not_found" as const })),
  });
}

function resumableSetupController(): Readonly<{
  controller: RegistrationSetupControllerUseCase;
  resumeCalls: () => number;
}> {
  let resumes = 0;
  return Object.freeze({
    controller: Object.freeze({
      ...setupController(),
      read: () => Promise.resolve(setupMergePendingModel),
      resume: () => {
        resumes += 1;
        return Promise.resolve(resumes === 1 ? setupMergePendingModel : setupActivatedModel);
      },
    }),
    resumeCalls: () => resumes,
  });
}

function pendingTransitionSetupController(): RegistrationSetupControllerUseCase {
  return Object.freeze({
    ...setupController(),
    read: () => Promise.resolve(setupAwaitingApprovalModel),
    issueLocalUiApprovalIntent: () =>
      Promise.resolve(
        Object.freeze({
          state: "approval_intent_issued" as const,
          setupSessionId,
          expectedSetupRevision: 7,
          approvalId: "approval-browser-1",
          expiresAt: "2026-08-06T12:05:00.000Z",
          mergeState: "configuration_incomplete" as const,
        }),
      ),
    approveAndMergeLocalUi: () => Promise.resolve(setupMergePendingModel),
    resume: () => Promise.resolve(setupActivatedModel),
  });
}

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
      ".ui-registration-card, .ui-registration-detail, .ui-registration-facts dd, .ui-linear-provision, .ui-linear-action, .ui-linear-controls, .ui-registration-setup, .ui-registration-setup-facts dd, .ui-registration-setup-controls",
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
  controller: RegistrationSetupControllerUseCase = setupController(),
): Promise<LocalUiServerHandle> {
  const application = createUiApplication({
    readModel: fixtureUiShellReadModel,
    features: [
      createFixtureRegistrationWizardUiFeatureRegistration(
        useCase,
        undefined,
        undefined,
        undefined,
        controller,
      ),
    ],
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

  test("renders eleven synthetic Gate cards with the registered O003 script and passes axe", async ({
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
    await expect(page.locator('script[src="/assets/registration.js"]')).toHaveCount(1);
    await expect(page.locator('script[src="/assets/registration-setup.js"]')).toHaveCount(1);
    await expect(page.locator("#registration-setup-section")).toHaveCount(1);
    await expectNoAxeViolations(page);
    await copyReviewScreenshot(page, "o002-registration-wizard-desktop.png");
  });

  test("requires the exact visible phrase and a second click before starting Setup", async ({
    page,
  }) => {
    await visit(page);
    const panel = page.locator("#registration-setup-section");
    const confirmation = panel.getByLabel("輸入 CREATE SETUP DRAFT PR");
    const confirm = panel.getByRole("button", { name: "確認 Preview" });
    const start = panel.getByRole("button", { name: "建立 Draft PR" });
    const status = panel.getByRole("status");

    await expect(panel.getByText("CREATE SETUP DRAFT PR", { exact: true })).toBeVisible();
    await expect(start).toBeDisabled();
    await confirmation.fill("WRONG PHRASE");
    await confirm.click();
    await expect(status).toContainText("確認文字不符");
    await expect(start).toBeDisabled();

    await confirmation.fill("CREATE SETUP DRAFT PR");
    await confirm.click();
    await expect(status).toContainText("一次性 Preview 確認已簽發");
    await expect(start).toBeEnabled();
    await start.click();
    await expect(status).toContainText("Setup Draft PR 已建立");
  });

  test("renders a durable resume control after reload and keeps pending continuation reachable", async ({
    page,
  }) => {
    const resumable = resumableSetupController();
    await shell?.close();
    shell = await startRegistrationShell(
      fixtureRegistrationReadOnlyScanUseCase,
      resumable.controller,
    );
    await visit(page);
    await page.reload({ waitUntil: "domcontentloaded" });

    const panel = page.locator("#registration-setup-section");
    const resume = panel.getByRole("button", { name: "繼續驗證 Merge／Activation" });
    const status = panel.getByRole("status");
    const resumeRequests: Readonly<{ method: string; body: unknown }>[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/registration/setup") && request.method() === "POST") {
        resumeRequests.push({ method: request.method(), body: request.postDataJSON() });
      }
    });

    await expect(resume).toBeVisible();
    await expect(resume).toBeEnabled();
    await resume.click();
    await expect(status).toContainText("恢復狀態：merge_pending");
    await expect(resume).toBeEnabled();
    await resume.click();
    await expect(status).toContainText("project index 已確認");
    await expect(resume).toBeDisabled();
    expect(resumable.resumeCalls()).toBe(2);
    expect(resumeRequests).toHaveLength(2);
    for (const request of resumeRequests) {
      expect(request.method).toBe("POST");
      expect(request.body).toEqual({
        action: "resume",
        operationId: expect.stringMatching(/^setup-ui-/u),
      });
    }
  });

  test("exposes resume immediately when approval returns durable merge_pending", async ({
    page,
  }) => {
    await shell?.close();
    shell = await startRegistrationShell(
      fixtureRegistrationReadOnlyScanUseCase,
      pendingTransitionSetupController(),
    );
    await visit(page);

    const panel = page.locator("#registration-setup-section");
    const approval = panel.getByLabel("輸入 APPROVE SETUP MERGE");
    const issue = panel.getByRole("button", { name: "簽發本機核可 Intent" });
    const merge = panel.getByRole("button", { name: "確認 SQUASH 合併並啟用" });
    const resume = panel.getByRole("button", { name: "繼續驗證 Merge／Activation" });
    const status = panel.getByRole("status");

    await expect(resume).toBeHidden();
    await approval.fill("APPROVE SETUP MERGE");
    await issue.click();
    await expect(merge).toBeEnabled();
    await merge.click();
    await expect(status).toContainText("合併狀態：merge_pending");
    await expect(resume).toBeVisible();
    await expect(resume).toBeEnabled();
    await resume.click();
    await expect(status).toContainText("project index 已確認");
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
