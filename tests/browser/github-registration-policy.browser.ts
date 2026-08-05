import { expect, test } from "@playwright/test";
import axe from "axe-core";

import {
  createGitHubRegistrationUiContribution,
  createUiApplication,
  fixtureGitHubRegistrationUiController,
  startLocalUiServer,
  type LocalUiServerHandle,
  type UiFeatureRegistration,
} from "../../src/ui/index.js";

let shell: LocalUiServerHandle | undefined;

function feature(): UiFeatureRegistration {
  const contribution = createGitHubRegistrationUiContribution(
    fixtureGitHubRegistrationUiController,
  );
  return Object.freeze({
    id: "github-registration-policy-browser-test",
    slot: "registration",
    page: Object.freeze({
      path: "/registration-github-policy-test",
      title: "GitHub 合併保護",
      description: "合成 O004 瀏覽器驗證頁。",
      scripts: contribution.scripts,
      render: contribution.render,
    }),
    routes: contribution.routes,
  });
}

test.describe("O004 GitHub registration policy component", () => {
  test.beforeEach(async ({ page }) => {
    const application = createUiApplication({ features: [feature()] });
    shell = await startLocalUiServer({
      handler: application.handler,
      securityPolicy: application.securityPolicy,
    });
    await page.context().addInitScript({ content: axe.source });
    await page.goto(`${shell.baseUrl}/#${shell.sessionToken}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => sessionStorage.getItem("agent-team-csrf") !== null);
    await page.goto(`${shell.baseUrl}/registration-github-policy-test`, {
      waitUntil: "domcontentloaded",
    });
  });

  test.afterEach(async () => {
    await shell?.close();
    shell = undefined;
  });

  test("requires a second confirmation, supports Escape, and reports read-back success", async ({
    page,
  }) => {
    const review = page.getByRole("button", { name: "檢視並確認套用" });
    const confirmation = page.getByRole("heading", { name: "確認套用 GitHub 合併保護" });
    await expect(review).toBeVisible();
    await review.click();
    await expect(confirmation).toBeVisible();
    await expect(page.getByRole("button", { name: "確認套用", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(review).toBeFocused();

    await review.click();
    await page.getByRole("button", { name: "確認套用", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已由 Read-back 確認");
    await expect(review).toHaveCount(0);

    const violations = await page.evaluate(async () => {
      const browser = globalThis as typeof globalThis & {
        axe?: { run: (context: unknown) => Promise<{ violations: unknown[] }> };
        document?: unknown;
      };
      if (browser.axe === undefined || browser.document === undefined)
        throw new Error("axe missing");
      return (await browser.axe.run(browser.document)).violations;
    });
    expect(violations).toEqual([]);
  });
});
