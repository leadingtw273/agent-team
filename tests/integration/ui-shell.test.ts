import { afterEach, describe, expect, it } from "vitest";

import {
  createUiShellHandler,
  startLocalUiServer,
  type LocalUiServerHandle,
  type UiShellReadModel,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

const fixtureReadModel: UiShellReadModel = Object.freeze({
  readOverview: () =>
    Object.freeze({
      source: "fixture" as const,
      teamState: "running" as const,
      activeJobCount: 1,
      registeredProjectCount: 1,
      recentEventCount: 1,
    }),
  listProjects: () =>
    Object.freeze([
      Object.freeze({
        id: "demo-project",
        name: "示範專案",
        repository: "local/demo-project",
        status: "active" as const,
        activeJobCount: 1,
        updatedAt: "剛剛",
      }),
    ]),
  listEvents: () =>
    Object.freeze([
      Object.freeze({
        id: "event-001",
        occurredAt: "今天 10:24",
        level: "info" as const,
        category: "系統",
        summary: "已載入有限示範資料。",
      }),
    ]),
});

async function start(readModel: UiShellReadModel = fixtureReadModel): Promise<LocalUiServerHandle> {
  const handle = await startLocalUiServer({ handler: createUiShellHandler(readModel) });
  handles.push(handle);
  return handle;
}

async function request(
  handle: LocalUiServerHandle,
  path: string,
  method: "GET" | "HEAD" | "POST" = "GET",
): Promise<Readonly<{ response: Response; body: string }>> {
  const response = await fetch(`${handle.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  return Object.freeze({ response, body: await response.text() });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("localhost UI shell", () => {
  it.each([
    ["/", "總覽", "示範專案"],
    ["/projects", "專案", "示範專案"],
    ["/events", "事件", "已載入有限示範資料。"],
  ] as const)("renders %s as an authenticated UTF-8 Chinese page", async (path, title, content) => {
    const handle = await start();

    const { response, body } = await request(handle, path);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(body).toContain('<html lang="zh-Hant">');
    expect(body).toContain(`<title>${title}｜Agent Team</title>`);
    expect(body).toContain(`<h1>${title}</h1>`);
    expect(body).toContain('aria-current="page"');
    expect(body).toContain(content);
    expect(body).toContain('href="#main-content"');
    expect(body).toContain(
      'href="https://cdn.jsdelivr.net/npm/@tabler/core@1.4.0/dist/css/tabler.min.css"',
    );
    expect(body).toContain('href="/assets/tabler-1.4.0.min.css"');
    expect(body).not.toContain("<script");
  });

  it("serves a path-allowlisted local fallback and never writes a HEAD body", async () => {
    const handle = await start();

    const asset = await request(handle, "/assets/tabler-1.4.0.min.css");
    const head = await request(handle, "/assets/ui-shell.css", "HEAD");
    const icon = await request(handle, "/assets/icons.svg");
    const unknown = await request(handle, "/assets/../server/index.ts");
    const unsupportedMethod = await request(handle, "/projects", "POST");

    expect(asset.response.status).toBe(200);
    expect(asset.response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(asset.body).toContain("--tblr-");
    expect(head.response.status).toBe(200);
    expect(head.response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(head.body).toBe("");
    expect(icon.response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(icon.body).toContain("<svg");
    expect(unknown.response.status).toBe(404);
    expect(unsupportedMethod.response.status).toBe(405);
    expect(unsupportedMethod.response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("renders supplied read-model values as text rather than raw HTML", async () => {
    const handle = await start(
      Object.freeze({
        ...fixtureReadModel,
        listProjects: () =>
          Object.freeze([
            Object.freeze({
              id: "unsafe-project",
              name: '<img src=x onerror="window.pwned=1">',
              repository: "local/<unsafe>",
              status: "attention" as const,
              activeJobCount: 0,
              updatedAt: "剛剛",
            }),
          ]),
        listEvents: () =>
          Object.freeze([
            Object.freeze({
              id: "unsafe-event",
              occurredAt: "今天",
              level: "warning" as const,
              category: "<unsafe>",
              summary: "<script>window.pwned=1</script>",
            }),
          ]),
      }),
    );

    const projects = await request(handle, "/projects");
    const events = await request(handle, "/events");

    expect(projects.body).not.toContain('<img src=x onerror="window.pwned=1">');
    expect(projects.body).toContain("&lt;img src=x onerror=&quot;window.pwned=1&quot;&gt;");
    expect(events.body).not.toContain("<script>window.pwned=1</script>");
    expect(events.body).toContain("&lt;script&gt;window.pwned=1&lt;/script&gt;");
  });

  it("labels empty state data without implying a connected production runtime", async () => {
    const handle = await start(
      Object.freeze({
        readOverview: () =>
          Object.freeze({
            source: "fixture" as const,
            teamState: "idle" as const,
            activeJobCount: 0,
            registeredProjectCount: 0,
            recentEventCount: 0,
          }),
        listProjects: () => Object.freeze([]),
        listEvents: () => Object.freeze([]),
      }),
    );

    const overview = await request(handle, "/");
    const projects = await request(handle, "/projects");
    const events = await request(handle, "/events");

    expect(overview.body).toContain("UI Shell 示範資料，尚未連接 Runtime。 ");
    expect(overview.body).toContain("目前沒有執行中的工作");
    expect(projects.body).toContain("尚無已註冊專案");
    expect(events.body).toContain("尚無事件紀錄");
  });
});
