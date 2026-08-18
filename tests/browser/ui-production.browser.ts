import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const screenshotDirectory = join(process.cwd(), "tmp", "ui-review");
let root: string | undefined;
let uiProcess: ChildProcess | undefined;
let uiUrl: string | undefined;

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

function runGit(cwd: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) {
    throw new Error("Unable to prepare the isolated local Git fixture.");
  }
}

function buildCli(): void {
  const result = spawnSync("pnpm", ["run", "build"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error("Unable to build the production CLI for browser verification.");
  }
}

async function provisionHome(): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-team-ui-production-"));
  const repository = join(temporaryRoot, "repository");
  const agentTeamHome = join(temporaryRoot, ".agent-team");
  await mkdir(repository, { recursive: true });
  runGit(repository, ["init", "--initial-branch=main"]);
  runGit(repository, ["config", "user.email", "ui-production@example.invalid"]);
  runGit(repository, ["config", "user.name", "UI Production Test"]);
  await writeFile(join(repository, "README.md"), "isolated UI fixture\n", "utf8");
  runGit(repository, ["add", "README.md"]);
  runGit(repository, ["commit", "-m", "isolated fixture"]);

  const registrationDirectory = join(agentTeamHome, "config", "registration");
  await mkdir(registrationDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(registrationDirectory, `${projectId}.draft.json`),
    JSON.stringify({
      schemaVersion: 1,
      project: {
        schemaVersion: 1,
        id: projectId,
        displayName: "Production Browser 專案",
        localRepositoryPath: repository,
        defaultBranch: "main",
        workManagement: {
          provider: "linear",
          containerId: "isolated-linear-container",
          projectId: "isolated-linear-project",
        },
        sourceControl: { provider: "github", repository: "isolated/production-browser" },
      },
      config: {
        schemaVersion: 1,
        projectId,
        defaultBranch: "main",
        platforms: {
          workManagement: {
            provider: "linear",
            containerId: "isolated-linear-container",
            projectId: "isolated-linear-project",
          },
          sourceControl: { provider: "github", repository: "isolated/production-browser" },
        },
        projectRules: ["此測試只讀取本機資料。"],
        roleInstructions: { implementer: ["Do not mutate this fixture."] },
        commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
      },
      linearAuditIssueId: "ISOLATED-UI-1",
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return agentTeamHome;
}

async function launchUi(
  agentTeamHome: string,
): Promise<{ readonly child: ChildProcess; readonly url: string }> {
  const child = spawn(process.execPath, [resolve("dist/cli/index.js"), "ui"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_TEAM_HOME: agentTeamHome,
      GITHUB_TOKEN: undefined,
      LINEAR_API_KEY: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    let stdout = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => {
        rejectUrl(new Error("Production UI did not announce its localhost URL."));
      });
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const match = /Agent Team UI：http:\/\/127\.0\.0\.1:\d+\/#([A-Za-z0-9_-]{43})/u.exec(stdout);
      if (match === null) return;
      const full = match[0];
      finish(() => {
        resolveUrl(full.slice("Agent Team UI：".length));
      });
    });
    child.once("error", () => {
      finish(() => {
        rejectUrl(new Error("Production UI process could not start."));
      });
    });
    child.once("exit", () => {
      finish(() => {
        rejectUrl(new Error("Production UI process exited before readiness."));
      });
    });
  });
  return Object.freeze({ child, url });
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  return await new Promise((resolveExit) => {
    if (child.exitCode !== null) {
      resolveExit(child.exitCode);
      return;
    }
    child.once("exit", (code) => {
      resolveExit(code);
    });
  });
}

async function stopUi(): Promise<number | null> {
  const child = uiProcess;
  if (child === undefined) return null;
  if (child.exitCode !== null) return child.exitCode;
  const pid = child.pid;
  if (pid === undefined) throw new Error("Production UI process has no PID.");
  process.kill(pid, "SIGINT");
  return await waitForExit(child);
}

function baseUrl(): string {
  const url = uiUrl;
  if (url === undefined) throw new Error("Production UI URL is unavailable.");
  return url.slice(0, url.indexOf("/#"));
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    interface LayoutProbeElement {
      readonly clientHeight: number;
      readonly clientWidth: number;
      readonly scrollHeight: number;
      readonly scrollWidth: number;
    }
    interface QueryableDocument {
      readonly querySelector: (selector: string) => LayoutProbeElement | null;
    }
    const browser = globalThis as typeof globalThis & {
      readonly axe?: AxeRunner;
      readonly document?: unknown;
      readonly getComputedStyle?: (
        element: LayoutProbeElement,
      ) => Readonly<{ overflowX: string; overflowY: string }>;
    };
    if (browser.axe === undefined || browser.document === undefined) {
      throw new Error("axe did not load into the page.");
    }
    const result = await browser.axe.run(browser.document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
    });
    const document = browser.document as QueryableDocument;
    const wrapper = document.querySelector(".ui-table-wrap");
    const table = document.querySelector(".ui-table--production-projects");
    const style =
      wrapper === null || browser.getComputedStyle === undefined
        ? undefined
        : browser.getComputedStyle(wrapper);
    return Object.freeze({
      violations: result.violations,
      productionTableLayout:
        wrapper === null || table === null
          ? undefined
          : Object.freeze({
              wrapper: Object.freeze({
                clientHeight: wrapper.clientHeight,
                clientWidth: wrapper.clientWidth,
                scrollHeight: wrapper.scrollHeight,
                scrollWidth: wrapper.scrollWidth,
                overflowX: style?.overflowX,
                overflowY: style?.overflowY,
              }),
              table: Object.freeze({
                clientHeight: table.clientHeight,
                clientWidth: table.clientWidth,
                scrollHeight: table.scrollHeight,
                scrollWidth: table.scrollWidth,
              }),
            }),
    });
  });
  expect(result.violations, JSON.stringify(result.productionTableLayout)).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => {
    interface LayoutProbeRect {
      readonly left: number;
      readonly right: number;
      readonly width: number;
    }
    interface LayoutProbeStyle {
      readonly display: string;
      readonly minWidth: string;
      readonly overflowWrap: string;
      readonly overflowX: string;
      readonly whiteSpace: string;
    }
    interface LayoutProbeElement {
      readonly classList: ArrayLike<string>;
      readonly clientWidth: number;
      readonly id: string;
      readonly localName: string;
      readonly scrollWidth: number;
      readonly textContent: string | null;
      readonly getBoundingClientRect: () => LayoutProbeRect;
    }
    interface LayoutProbeDocument {
      readonly documentElement: LayoutProbeElement;
      readonly querySelectorAll: (selector: string) => ArrayLike<LayoutProbeElement>;
    }
    const browser = globalThis as typeof globalThis & {
      readonly document?: LayoutProbeDocument;
      readonly getComputedStyle?: (element: LayoutProbeElement) => LayoutProbeStyle;
    };
    const root = browser.document?.documentElement;
    const getStyle = browser.getComputedStyle;
    if (root === undefined || browser.document === undefined || getStyle === undefined) {
      return undefined;
    }
    const document = browser.document;
    const viewportWidth = root.clientWidth;
    const identify = (element: LayoutProbeElement): string => {
      const classes = Array.from(element.classList).join(".");
      return `${element.localName}${element.id === "" ? "" : `#${element.id}`}${classes === "" ? "" : `.${classes}`}`;
    };
    const measure = (element: LayoutProbeElement) => {
      const rect = element.getBoundingClientRect();
      const style = getStyle(element);
      return Object.freeze({
        selector: identify(element),
        text: (element.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 80),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        display: style.display,
        minWidth: style.minWidth,
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        overflowX: style.overflowX,
      });
    };
    return Object.freeze({
      root: Object.freeze({ clientWidth: root.clientWidth, scrollWidth: root.scrollWidth }),
      overflowers: Array.from(document.querySelectorAll("body, body *"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            getStyle(element).display !== "none" &&
            (rect.left < -0.5 ||
              rect.right > viewportWidth + 0.5 ||
              element.scrollWidth > element.clientWidth + 0.5)
          );
        })
        .map(measure),
    });
  });
  expect(dimensions, "Root layout diagnostics are unavailable.").toBeDefined();
  if (dimensions === undefined) return;
  expect(dimensions.root.scrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.root.clientWidth,
  );
}

async function expectProductionProjectsTableFitsViewport(page: Page): Promise<void> {
  const dimensions = await page.locator(".ui-table--production-projects").evaluate((element) => {
    const table = element as unknown as {
      readonly clientWidth: number;
      readonly parentElement: Readonly<{
        readonly clientWidth: number;
        readonly scrollWidth: number;
      }> | null;
      readonly scrollWidth: number;
    };
    return Object.freeze({
      table: Object.freeze({ clientWidth: table.clientWidth, scrollWidth: table.scrollWidth }),
      wrapper:
        table.parentElement === null
          ? undefined
          : Object.freeze({
              clientWidth: table.parentElement.clientWidth,
              scrollWidth: table.parentElement.scrollWidth,
            }),
    });
  });
  expect(dimensions.table.scrollWidth).toBeLessThanOrEqual(dimensions.table.clientWidth);
  expect(dimensions.wrapper).toBeDefined();
  if (dimensions.wrapper === undefined) return;
  expect(dimensions.wrapper.scrollWidth).toBeLessThanOrEqual(dimensions.wrapper.clientWidth);
}

test.describe("T06 production localhost UI", () => {
  test.beforeAll(async () => {
    buildCli();
    root = await provisionHome();
    const launched = await launchUi(root);
    uiProcess = launched.child;
    uiUrl = launched.url;
  });

  test.afterAll(async () => {
    if (uiProcess?.exitCode === null) await stopUi();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  test("uses the compiled CLI, real loopback session, responsive core shell, local CSS fallback, and exact SIGINT shutdown", async ({
    page,
  }) => {
    await page.context().addInitScript({ content: axe.source });
    await page.route("https://cdn.jsdelivr.net/npm/@tabler/core@1.4.0/**", (route) =>
      route.abort(),
    );
    const fallback = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/assets/tabler-1.4.0.min.css",
    );

    await page.goto(uiUrl ?? "", { waitUntil: "load" });
    await page.waitForURL(`${baseUrl()}/`);
    await fallback;
    await page.locator("#main-content").waitFor();

    await expect(page.getByRole("heading", { level: 1, name: "總覽" })).toBeVisible();
    await expect(page.getByText("Production Browser 專案", { exact: true })).toBeVisible();
    await expect(page.locator(".ui-stat-grid--production .ui-stat-card")).toHaveCount(4);
    await expect(page.locator(".ui-stat-grid--production")).toHaveCSS(
      "grid-template-columns",
      /^\S+ \S+ \S+ \S+$/u,
    );
    await expect(page.locator(".ui-nav--desktop .ui-nav-link")).toHaveCount(3);
    await expect(page.getByText("註冊精靈", { exact: true })).toHaveCount(0);
    await expect(page.getByText("T06 尚未接入事件來源", { exact: true })).toHaveCount(0);
    expect(page.url()).toBe(`${baseUrl()}/`);
    await expectNoAxeViolations(page);
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({
      path: join(screenshotDirectory, "t06-production-ui-desktop.png"),
      fullPage: false,
    });

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "跳至主要內容" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl()}/projects`, { waitUntil: "load" });
    await expect(page.getByRole("heading", { level: 1, name: "專案" })).toBeVisible();
    await expect(page.getByRole("table")).toBeVisible();
    const projectsRegion = page.locator('.ui-table-wrap[role="region"]');
    await expect(projectsRegion).toHaveAccessibleName("專案");
    await expect(projectsRegion).toHaveAttribute("tabindex", "0");
    const mobileLabels = page.locator(".ui-table--production-projects .ui-mobile-cell-label");
    await expect(mobileLabels).toHaveCount(5);
    await expect(mobileLabels).toHaveText([
      "名稱",
      "註冊狀態／原因",
      "非終態工作",
      "活躍租約",
      "Linear lifecycle",
    ]);
    await expect(mobileLabels.first()).toBeVisible();
    await expect(mobileLabels.last()).toBeVisible();
    await expectProductionProjectsTableFitsViewport(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: join(screenshotDirectory, "t06-production-ui-mobile.png"),
      fullPage: false,
    });
    await page.locator(".ui-mobile-nav-toggle").focus();
    await page.keyboard.press("Tab");
    await expect(projectsRegion).toBeFocused();

    await page.setViewportSize({ width: 320, height: 720 });
    await expectNoHorizontalOverflow(page);
    await expectProductionProjectsTableFitsViewport(page);
    await page.goto(`${baseUrl()}/events`, { waitUntil: "load" });
    await expect(page.getByText("T06 尚未接入事件來源", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);

    expect(await stopUi()).toBe(130);
    await expect(fetch(`${baseUrl()}/`)).rejects.toThrow();
  });
});
