import { createHash } from "node:crypto";

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  LinearGraphqlTransport,
  LinearUploadClient,
  renderLinearArtifactComment,
  type LinearCommentReceipt,
  type LinearCommentWriter,
  type LinearFetch,
  type LinearProjectContext,
} from "../../src/adapters/linear/index.js";
import type { WorkManagementArtifact } from "../../src/application/ports/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";

const context = {
  team: { id: "team-fixture", name: "Fixture", key: "FIX" },
  project: { id: "project-fixture", name: "Fixture" },
} as LinearProjectContext;

function instant() {
  const parsed = parseInstant("2026-08-04T15:00:00.000Z");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function artifact(mediaType = "image/png"): WorkManagementArtifact {
  const content = new TextEncoder().encode(`fixture:${mediaType}`);
  return {
    filename: mediaType.startsWith("image/") ? "畫面 [首頁].png" : "流程示範.mp4",
    mediaType,
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
  };
}

function bodyOf(init: RequestInit): Readonly<Record<string, unknown>> {
  if (typeof init.body !== "string") throw new Error("expected_graphql_body");
  return JSON.parse(init.body) as Readonly<Record<string, unknown>>;
}

class CommentHarness implements LinearCommentWriter {
  readonly calls: { issueId: string; body: string; idempotencyKey: string }[] = [];
  result: Result<LinearCommentReceipt, DomainError> = ok({
    id: "comment-upload",
    body: "stored",
    createdAt: instant(),
    reused: false,
  });

  appendComment(
    _context: LinearProjectContext,
    issueId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<Result<LinearCommentReceipt, DomainError>> {
    this.calls.push({ issueId, body, idempotencyKey });
    return Promise.resolve(this.result);
  }
}

class UploadHarness {
  readonly comments = new CommentHarness();
  readonly graphqlFetch: Mock<LinearFetch>;
  readonly uploadFetch: Mock<LinearFetch>;
  readonly putRequests: { url: string; init: RequestInit }[] = [];
  graphqlPayload: unknown;
  putStatus = 200;

  constructor(readonly input = artifact()) {
    this.graphqlPayload = {
      fileUpload: {
        success: true,
        uploadFile: {
          filename: input.filename,
          contentType: input.mediaType,
          size: input.content.byteLength,
          uploadUrl: "https://uploads.linear.example/signed",
          assetUrl: "https://uploads.linear.example/asset/image",
          headers: [{ key: "x-upload-token", value: "signed-value" }],
        },
      },
    };
    this.graphqlFetch = vi.fn<LinearFetch>().mockImplementation(() => {
      return Promise.resolve(
        new Response(JSON.stringify({ data: this.graphqlPayload }), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    this.uploadFetch = vi.fn<LinearFetch>().mockImplementation((url, init) => {
      this.putRequests.push({ url, init });
      return Promise.resolve(new Response(null, { status: this.putStatus }));
    });
  }

  client(timeoutMs = 1_000): LinearUploadClient {
    return new LinearUploadClient(
      new LinearGraphqlTransport({ apiKey: "fixture-key", fetch: this.graphqlFetch }),
      this.comments,
      { fetch: this.uploadFetch, timeoutMs },
    );
  }
}

describe("Linear upload adapter", () => {
  it("requests a signed URL, applies returned headers, uploads, and embeds image evidence", async () => {
    const harness = new UploadHarness();
    const result = await harness
      .client()
      .uploadArtifact(context, "issue-fixture", harness.input, "artifact-attempt-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      externalId: "https://uploads.linear.example/asset/image",
      url: "https://uploads.linear.example/asset/image",
      sha256: harness.input.sha256,
      commentId: "comment-upload",
      commentBody: harness.comments.calls[0]?.body,
    });
    const graphqlBody = bodyOf(harness.graphqlFetch.mock.calls[0]?.[1] ?? {});
    expect(graphqlBody["operationName"]).toBe("AgentTeamFileUpload");
    expect(graphqlBody["variables"]).toEqual({
      contentType: "image/png",
      filename: "畫面 [首頁].png",
      size: harness.input.content.byteLength,
    });
    expect(harness.putRequests).toHaveLength(1);
    const put = harness.putRequests[0];
    expect(put?.url).toBe("https://uploads.linear.example/signed");
    expect(put?.init.method).toBe("PUT");
    const headers = new Headers(put?.init.headers);
    expect(headers.get("content-type")).toBe("image/png");
    expect(headers.get("cache-control")).toBe("public, max-age=31536000");
    expect(headers.get("x-upload-token")).toBe("signed-value");
    expect(headers.has("authorization")).toBe(false);
    expect(harness.comments.calls).toEqual([
      expect.objectContaining({ issueId: "issue-fixture", idempotencyKey: "artifact-attempt-1" }),
    ]);
    expect(result.value.commentBody).toContain(
      "![畫面 \\[首頁\\].png](<https://uploads.linear.example/asset/image>)",
    );
    expect(result.value.commentBody).toContain(harness.input.sha256);
  });

  it("accepts Linear's server-generated storage-path filename that differs from the request filename", async () => {
    const harness = new UploadHarness();
    harness.graphqlPayload = {
      fileUpload: {
        success: true,
        uploadFile: {
          filename:
            "1fbe13f4-1111-4c1a-9b1a-000000000001/db84f0f8-2222-4c1a-9b1a-000000000002/17951e26-3333-4c1a-9b1a-000000000003",
          contentType: harness.input.mediaType,
          size: harness.input.content.byteLength,
          uploadUrl: "https://uploads.linear.example/signed",
          assetUrl: "https://uploads.linear.example/asset/image",
          headers: [
            { key: "x-goog-content-length-range", value: "0,10485760" },
            { key: "Content-Disposition", value: "inline" },
          ],
        },
      },
    };

    const result = await harness
      .client()
      .uploadArtifact(context, "issue-fixture", harness.input, "storage-path-attempt");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe("https://uploads.linear.example/asset/image");
    expect(harness.putRequests).toHaveLength(1);
    expect(harness.comments.calls).toHaveLength(1);
  });

  it("renders a raw HTTPS video URL so Linear can create its video placeholder", async () => {
    const input = artifact("video/mp4");
    const harness = new UploadHarness(input);
    const result = await harness
      .client()
      .uploadArtifact(context, "issue-fixture", input, "video-attempt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.commentBody).toContain("影片：https://uploads.linear.example/asset/image");
    expect(result.value.commentBody).not.toContain("![");
  });

  it("rejects invalid bytes and metadata before any external write", async () => {
    for (const input of [
      { ...artifact(), sha256: "0".repeat(64) },
      { ...artifact(), filename: "../escape.png" },
      { ...artifact(), mediaType: "text/plain" },
      { ...artifact(), content: new Uint8Array() },
    ]) {
      const harness = new UploadHarness(input);
      const result = await harness
        .client()
        .uploadArtifact(context, "issue-fixture", input, "invalid-attempt");
      expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
      expect(harness.graphqlFetch).not.toHaveBeenCalled();
      expect(harness.uploadFetch).not.toHaveBeenCalled();
      expect(harness.comments.calls).toHaveLength(0);
    }
  });

  it("fails closed on rejected, malformed, mismatched, or unsafe upload payloads", async () => {
    const cases: unknown[] = [
      { fileUpload: { success: false, uploadFile: null } },
      { fileUpload: { success: true, uploadFile: null } },
      { fileUpload: { success: true, uploadFile: { unexpected: true } } },
      {
        fileUpload: {
          success: true,
          uploadFile: {
            filename: artifact().filename,
            contentType: "image/jpeg",
            size: artifact().content.byteLength,
            uploadUrl: "https://uploads.linear.example/signed",
            assetUrl: "https://uploads.linear.example/asset/image",
            headers: [],
          },
        },
      },
      {
        fileUpload: {
          success: true,
          uploadFile: {
            filename: artifact().filename,
            contentType: "image/png",
            size: artifact().content.byteLength + 1,
            uploadUrl: "https://uploads.linear.example/signed",
            assetUrl: "https://uploads.linear.example/asset/image",
            headers: [],
          },
        },
      },
      {
        fileUpload: {
          success: true,
          uploadFile: {
            filename: artifact().filename,
            contentType: "image/png",
            size: artifact().content.byteLength,
            uploadUrl: "http://127.0.0.1/upload",
            assetUrl: "https://uploads.linear.example/asset/image",
            headers: [],
          },
        },
      },
      {
        fileUpload: {
          success: true,
          uploadFile: {
            filename: artifact().filename,
            contentType: "image/png",
            size: artifact().content.byteLength,
            uploadUrl: "https://uploads.linear.example/signed",
            assetUrl: "https://uploads.linear.example/asset/image",
            headers: [{ key: "Authorization", value: "must-not-forward" }],
          },
        },
      },
    ];
    for (const payload of cases) {
      const harness = new UploadHarness();
      harness.graphqlPayload = payload;
      const result = await harness
        .client()
        .uploadArtifact(context, "issue-fixture", harness.input, "payload-attempt");
      expect(result.ok ? "ok" : result.error.code).toBe("external_failure");
      expect(harness.uploadFetch).not.toHaveBeenCalled();
      expect(harness.comments.calls).toHaveLength(0);
    }
  });

  it("does not publish evidence when PUT fails or the evidence comment fails", async () => {
    const putFailure = new UploadHarness();
    putFailure.putStatus = 403;
    const failedPut = await putFailure
      .client()
      .uploadArtifact(context, "issue-fixture", putFailure.input, "put-failure");
    expect(failedPut.ok ? "ok" : failedPut.error.code).toBe("permission_denied");
    expect(putFailure.comments.calls).toHaveLength(0);

    const commentFailure = new UploadHarness();
    commentFailure.comments.result = err(domainError("external_failure"));
    const failedComment = await commentFailure
      .client()
      .uploadArtifact(context, "issue-fixture", commentFailure.input, "comment-failure");
    expect(failedComment.ok ? "ok" : failedComment.error.code).toBe("external_failure");
    expect(commentFailure.putRequests).toHaveLength(1);
    expect(commentFailure.comments.calls).toHaveLength(1);
  });

  it("maps interrupted, timed out, and unavailable PUT requests without a comment", async () => {
    const interrupted = new UploadHarness();
    const controller = new AbortController();
    controller.abort();
    const interruptedResult = await interrupted
      .client()
      .uploadArtifact(context, "issue-fixture", interrupted.input, "interrupted", {
        signal: controller.signal,
      });
    expect(interruptedResult.ok ? "ok" : interruptedResult.error.code).toBe("interrupted");
    expect(interrupted.uploadFetch).not.toHaveBeenCalled();

    const timedOut = new UploadHarness();
    timedOut.uploadFetch.mockImplementationOnce((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    });
    const timedOutResult = await timedOut
      .client(5)
      .uploadArtifact(context, "issue-fixture", timedOut.input, "timed-out");
    expect(timedOutResult.ok ? "ok" : timedOutResult.error.code).toBe("timeout");
    expect(timedOut.comments.calls).toHaveLength(0);

    const unavailable = new UploadHarness();
    unavailable.uploadFetch.mockRejectedValueOnce(new Error("network"));
    const unavailableResult = await unavailable
      .client()
      .uploadArtifact(context, "issue-fixture", unavailable.input, "unavailable");
    expect(unavailableResult.ok ? "ok" : unavailableResult.error.code).toBe("unavailable");
    expect(unavailable.comments.calls).toHaveLength(0);
  });

  it("keeps the deterministic hash marker in both image and video comments", () => {
    const image = artifact();
    const video = artifact("video/mp4");
    expect(renderLinearArtifactComment(image, "https://assets.example/image")).toContain(
      `<!-- agent-team:artifact:${image.sha256} -->`,
    );
    expect(renderLinearArtifactComment(video, "https://assets.example/video")).toContain(
      `<!-- agent-team:artifact:${video.sha256} -->`,
    );
  });
});
