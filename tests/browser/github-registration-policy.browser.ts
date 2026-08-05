import { expect, test } from "@playwright/test";
import axe from "axe-core";

import {
  createRegistrationWizardUiFeatureRegistration,
  createUiApplication,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

let shell: LocalUiServerHandle | undefined;

test.describe("O004 GitHub registration policy component", () => {
  test.beforeEach(async ({ page }) => {
    const application = createUiApplication({
      features: [createRegistrationWizardUiFeatureRegistration()],
    });
    shell = await startLocalUiServer({
      handler: application.handler,
      securityPolicy: application.securityPolicy,
    });
    await page.context().addInitScript({ content: axe.source });
    await page.goto(`${shell.baseUrl}/#${shell.sessionToken}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => sessionStorage.getItem("agent-team-csrf") !== null);
    await page.goto(`${shell.baseUrl}/registration`, {
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
    await expect(page.getByRole("heading", { name: "套用前：GitHub 現況" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "套用後：目標政策" })).toBeVisible();
    await expect(page.getByText("目前作用中的 required checks", { exact: true })).toBeVisible();
    await expect(page.getByText("CI、agent-team/review", { exact: true })).toBeVisible();
    await review.click();
    await expect(confirmation).toBeVisible();
    await expect(page.getByRole("button", { name: "確認套用", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(review).toBeFocused();

    await review.click();
    await page.getByRole("button", { name: "確認套用", exact: true }).click();
    await expect(page.locator("[data-github-policy-panel]").getByRole("status")).toContainText(
      "已由 Read-back 確認",
    );
    await expect(review).toHaveCount(0);

    const violations = await page.evaluate(async () => {
      const browser = globalThis as typeof globalThis & {
        axe?: {
          run: (context: unknown, options: unknown) => Promise<{ violations: unknown[] }>;
        };
        document?: unknown;
      };
      if (browser.axe === undefined || browser.document === undefined)
        throw new Error("axe missing");
      return (
        await browser.axe.run(browser.document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
          },
        })
      ).violations;
    });
    expect(violations).toEqual([]);
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 720 },
  ] as const) {
    test(`has no horizontal overflow at ${String(viewport.width)}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const metrics = await page.evaluate(() => {
        const browser = globalThis as typeof globalThis & {
          document: {
            documentElement: { scrollWidth: number; clientWidth: number };
            querySelector: (
              selector: string,
            ) => { scrollWidth: number; clientWidth: number } | null;
          };
        };
        const panel = browser.document.querySelector("[data-github-policy-panel]");
        return {
          documentWidth: browser.document.documentElement.scrollWidth,
          viewportWidth: browser.document.documentElement.clientWidth,
          panelWidth: panel?.scrollWidth,
          panelViewportWidth: panel?.clientWidth,
        };
      });
      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.panelWidth).toBeLessThanOrEqual(metrics.panelViewportWidth ?? 0);
    });
  }
});
