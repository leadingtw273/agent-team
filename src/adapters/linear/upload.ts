import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  WorkManagementArtifact,
  WorkManagementArtifactReceipt,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { LinearProjectContext } from "./model.js";
import { LinearGraphqlTransport, mapLinearHttpStatus, type LinearFetch } from "./transport.js";
import type { LinearCommentReceipt } from "./write.js";

const defaultUploadTimeoutMs = 30_000;
const maximumUploadBytes = 2_147_483_647;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const filenamePattern = /^[^/\\\u0000-\u001f\u007f]{1,255}$/u;
const mediaTypePattern = /^(?:image|video)\/[a-z0-9][a-z0-9.+-]*$/u;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const forbiddenUploadHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "transfer-encoding",
]);

const uploadHeaderSchema = z.object({ key: z.string().min(1), value: z.string() }).strict();
const uploadFileSchema = z
  .object({
    filename: z.string().min(1),
    contentType: z.string().min(1),
    size: z.number().int().nonnegative(),
    uploadUrl: z.string().min(1),
    assetUrl: z.string().min(1),
    headers: z.array(uploadHeaderSchema).max(100),
  })
  .strict();
const fileUploadMutationSchema = z
  .object({
    fileUpload: z
      .object({ success: z.boolean(), uploadFile: uploadFileSchema.nullable() })
      .strict(),
  })
  .strict();

const fileUploadQuery = `
  mutation AgentTeamFileUpload($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size) {
      success
      uploadFile { filename contentType size uploadUrl assetUrl headers { key value } }
    }
  }
`;

export interface LinearCommentWriter {
  appendComment(
    context: LinearProjectContext,
    issueId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<Result<LinearCommentReceipt, DomainError>>;
}

export interface LinearArtifactUploadReceipt extends WorkManagementArtifactReceipt {
  readonly commentId: string;
  readonly commentBody: string;
}

export interface LinearUploadRequestOptions {
  readonly signal?: AbortSignal;
}

export interface LinearUploadClientOptions {
  readonly fetch?: LinearFetch;
  readonly timeoutMs?: number;
}

interface ValidatedUploadFile {
  readonly uploadUrl: string;
  readonly assetUrl: string;
  readonly headers: Headers;
}

class UploadStopped extends Error {
  constructor(readonly reason: "timeout" | "interrupted") {
    super(reason);
  }
}

function failure<Value>(code: "external_failure" | "interrupted" | "timeout" | "unavailable") {
  return err(domainError(code)) as Result<Value, DomainError>;
}

function secureUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function artifactDigest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function escapedMarkdownText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

export function renderLinearArtifactComment(
  artifact: Pick<WorkManagementArtifact, "filename" | "mediaType" | "sha256">,
  assetUrl: string,
): string {
  const title = escapedMarkdownText(artifact.filename);
  const media = artifact.mediaType.startsWith("image/")
    ? `![${title}](<${assetUrl}>)`
    : `影片：${assetUrl}`;
  return [
    `### 視覺證據：${artifact.filename}`,
    "",
    media,
    "",
    `- 媒體類型：\`${artifact.mediaType}\``,
    `- SHA-256：\`${artifact.sha256}\``,
    `<!-- agent-team:artifact:${artifact.sha256} -->`,
  ].join("\n");
}

function validatedHeaders(
  artifact: WorkManagementArtifact,
  returned: readonly { readonly key: string; readonly value: string }[],
): Headers | undefined {
  const headers = new Headers({
    "cache-control": "public, max-age=31536000",
    "content-type": artifact.mediaType,
  });
  const seen = new Set<string>();
  for (const header of returned) {
    const name = header.key.toLowerCase();
    if (
      !headerNamePattern.test(header.key) ||
      /[\r\n]/u.test(header.value) ||
      forbiddenUploadHeaders.has(name) ||
      seen.has(name)
    ) {
      return undefined;
    }
    if (name === "content-type" && header.value.toLowerCase() !== artifact.mediaType) {
      return undefined;
    }
    seen.add(name);
    headers.set(header.key, header.value);
  }
  return headers;
}

/**
 * Linear 的 fileUpload mutation 回傳的 uploadFile.filename 是伺服器端生成的內部儲存路徑
 * （例如三段 UUID 組成的字串），並非客戶端請求時送出的原始檔名，因此不能對其做等值斷言。
 * contentType 與 size 仍會被 Linear 原樣 echo 回來，故繼續逐欄驗證以防竄改或大小不符。
 */
function validateUploadFile(
  artifact: WorkManagementArtifact,
  value: z.infer<typeof uploadFileSchema>,
): ValidatedUploadFile | undefined {
  if (value.contentType !== artifact.mediaType || value.size !== artifact.content.byteLength) {
    return undefined;
  }
  const uploadUrl = secureUrl(value.uploadUrl);
  const assetUrl = secureUrl(value.assetUrl);
  const headers = validatedHeaders(artifact, value.headers);
  return uploadUrl === undefined || assetUrl === undefined || headers === undefined
    ? undefined
    : { uploadUrl, assetUrl, headers };
}

function validArtifact(artifact: WorkManagementArtifact): boolean {
  return (
    filenamePattern.test(artifact.filename) &&
    mediaTypePattern.test(artifact.mediaType) &&
    artifact.content.byteLength > 0 &&
    artifact.content.byteLength <= maximumUploadBytes &&
    sha256Pattern.test(artifact.sha256) &&
    artifactDigest(artifact.content) === artifact.sha256
  );
}

export class LinearUploadClient {
  readonly #fetch: LinearFetch;
  readonly #timeoutMs: number;

  constructor(
    readonly transport: LinearGraphqlTransport,
    readonly comments: LinearCommentWriter,
    options: LinearUploadClientOptions = {},
  ) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? defaultUploadTimeoutMs));
  }

  /**
   * Returns success only after the bytes are uploaded and their evidence comment
   * is readable through Linear. A failed comment can leave an unreferenced asset
   * because the observed Linear plan does not expose asset deletion. The caller's
   * issue lease must serialize upload attempts for one artifact across processes.
   */
  async uploadArtifact(
    context: LinearProjectContext,
    issueId: string,
    artifact: WorkManagementArtifact,
    idempotencyKey: string,
    options: LinearUploadRequestOptions = {},
  ): Promise<Result<LinearArtifactUploadReceipt, DomainError>> {
    const snapshot: WorkManagementArtifact = {
      filename: artifact.filename,
      mediaType: artifact.mediaType,
      sha256: artifact.sha256,
      content: Uint8Array.from(artifact.content),
    };
    if (!validArtifact(snapshot) || issueId.length === 0 || idempotencyKey.length === 0) {
      return failure("external_failure");
    }
    const requested = await this.transport.request<
      unknown,
      { contentType: string; filename: string; size: number }
    >(
      {
        operationName: "AgentTeamFileUpload",
        query: fileUploadQuery,
        variables: {
          contentType: snapshot.mediaType,
          filename: snapshot.filename,
          size: snapshot.content.byteLength,
        },
      },
      options,
    );
    if (!requested.ok) return requested;
    const parsed = fileUploadMutationSchema.safeParse(requested.value);
    if (
      !parsed.success ||
      !parsed.data.fileUpload.success ||
      parsed.data.fileUpload.uploadFile === null
    ) {
      return failure("external_failure");
    }
    const uploadFile = validateUploadFile(snapshot, parsed.data.fileUpload.uploadFile);
    if (uploadFile === undefined) return failure("external_failure");

    const uploaded = await this.#put(uploadFile, snapshot.content, options.signal);
    if (!uploaded.ok) return uploaded;

    const commentBody = renderLinearArtifactComment(snapshot, uploadFile.assetUrl);
    const comment = await this.comments.appendComment(
      context,
      issueId,
      commentBody,
      idempotencyKey,
    );
    if (!comment.ok) return comment;
    return ok({
      externalId: uploadFile.assetUrl,
      url: uploadFile.assetUrl,
      sha256: snapshot.sha256,
      commentId: comment.value.id,
      commentBody,
    });
  }

  async #put(
    upload: ValidatedUploadFile,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Result<true, DomainError>> {
    if (signal?.aborted === true) return failure("interrupted");
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new UploadStopped("timeout"));
        controller.abort();
      }, this.#timeoutMs);
      if (signal !== undefined) {
        const onAbort = () => {
          reject(new UploadStopped("interrupted"));
          controller.abort();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeExternalAbort = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }
    });

    try {
      const response = await Promise.race([
        this.#fetch(upload.uploadUrl, {
          method: "PUT",
          headers: upload.headers,
          body: content,
          signal: controller.signal,
        }),
        stopped,
      ]);
      return response.ok ? ok(true) : err(mapLinearHttpStatus(response.status));
    } catch (error) {
      return error instanceof UploadStopped ? failure(error.reason) : failure("unavailable");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeExternalAbort?.();
    }
  }
}
