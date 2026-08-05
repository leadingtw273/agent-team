import { afterEach, describe, expect, it } from "vitest";

import {
  createUiShellHandler,
  fixtureUiShellReadModel,
  startLocalUiServer,
  type LocalUiServerHandle,
} from "../../src/ui/index.js";

const handles: LocalUiServerHandle[] = [];

async function start(): Promise<LocalUiServerHandle> {
  const handle = await startLocalUiServer({
    handler: createUiShellHandler(fixtureUiShellReadModel),
  });
  handles.push(handle);
  return handle;
}

async function request(
  handle: LocalUiServerHandle,
  method: "GET" | "HEAD" | "POST" = "GET",
): Promise<Readonly<{ response: Response; body: string }>> {
  const response = await fetch(`${handle.baseUrl}/runtime-status`, {
    method,
    headers: { authorization: `Bearer ${handle.sessionToken}` },
  });
  return Object.freeze({ response, body: await response.text() });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("runtime status localhost UI", () => {
  it("serves the four blocker fixtures as a read-only Chinese runtime-status page", async () => {
    const handle = await start();

    const { response, body } = await request(handle);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(body).toContain("<title>執行中｜Agent Team</title>");
    expect(body).toContain('<a class="ui-nav-link" href="/runtime-status" aria-current="page">');
    expect(body).toContain("Process 異常結束");
    expect(body).toContain("週額度不足");
    expect(body).toContain("5 小時額度限制");
    expect(body).toContain("等待危險操作核可");
    expect(body).toContain("未知錯誤");
    expect(body).toContain("不顯示完整命令、Secret 或模型隱藏推理");
    expect(body).not.toContain("<script");
  });

  it("keeps the page GET/HEAD only and does not send a HEAD response body", async () => {
    const handle = await start();

    const head = await request(handle, "HEAD");
    const post = await request(handle, "POST");

    expect(head.response.status).toBe(200);
    expect(head.body).toBe("");
    expect(post.response.status).toBe(405);
    expect(post.response.headers.get("allow")).toBe("GET, HEAD");
  });
});
