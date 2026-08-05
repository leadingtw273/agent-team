import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { ReadOptions } from "../../application/ports/common.js";

const defaultEndpoint = "https://api.linear.app/graphql";
const defaultTimeoutMs = 15_000;
const defaultMaxPages = 100;
const defaultMaxResponseBytes = 2 * 1024 * 1024;
const maximumConfiguredResponseBytes = 16 * 1024 * 1024;
const abortSettlementGraceMs = 100;

export type LinearTransportResult<Value> = Result<Value, DomainError>;

export type LinearFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LinearGraphqlRequest<Variables extends Record<string, unknown>> {
  readonly query: string;
  readonly variables: Variables;
  readonly operationName?: string;
}

export type LinearRequestOptions = ReadOptions;

export interface LinearGraphqlConnection<Node> {
  readonly nodes: readonly Node[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor?: string | null;
  };
}

export interface LinearPaginationRequest<Data, Node> {
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly operationName?: string;
  readonly cursorVariable?: string;
  readonly maxPages?: number;
  readonly selectConnection: (data: Data) => LinearGraphqlConnection<Node>;
}

export interface LinearGraphqlTransportOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: LinearFetch;
}

interface GraphqlErrorEnvelope {
  readonly extensions?: { readonly code?: unknown };
}

interface GraphqlEnvelope {
  readonly data?: unknown;
  readonly errors?: unknown;
}

class RequestStopped extends Error {
  constructor(readonly reason: "timeout" | "interrupted") {
    super(reason);
  }
}

class ResponseBodyRejected extends Error {}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: GraphqlErrorEnvelope): string | undefined {
  const code = error.extensions?.code;
  return typeof code === "string" ? code.toUpperCase().replace(/[^A-Z0-9]/gu, "") : undefined;
}

export function mapLinearHttpStatus(status: number): DomainError {
  if (status === 401 || status === 403) return domainError("permission_denied");
  if (status === 404) return domainError("not_found");
  if (status === 408 || status === 504) return domainError("timeout");
  if (status === 409) return domainError("conflict");
  if (status === 429) return domainError("rate_limited");
  if (status >= 500) return domainError("unavailable");
  return domainError("external_failure");
}

export function mapLinearGraphqlErrors(errors: readonly GraphqlErrorEnvelope[]): DomainError {
  const codes = new Set(errors.map(errorCode).filter((code) => code !== undefined));
  if (
    codes.has("AUTHENTICATIONERROR") ||
    codes.has("FORBIDDEN") ||
    codes.has("FORBIDDENERROR") ||
    codes.has("UNAUTHENTICATED")
  ) {
    return domainError("permission_denied");
  }
  if (codes.has("RATELIMITED") || codes.has("RATELIMITEXCEEDED")) {
    return domainError("rate_limited");
  }
  if (codes.has("NOTFOUND") || codes.has("ENTITYNOTFOUND")) return domainError("not_found");
  return domainError("external_failure");
}

function parseEnvelope<Data>(body: unknown): LinearTransportResult<Data> {
  if (!isRecord(body)) return err(domainError("external_failure"));
  const envelope: GraphqlEnvelope = body;
  if (envelope.errors !== undefined) {
    if (!Array.isArray(envelope.errors) || envelope.errors.length === 0) {
      return err(domainError("external_failure"));
    }
    if (envelope.data !== undefined && envelope.data !== null) {
      return err(domainError("external_failure"));
    }
    const errors = envelope.errors.filter(isRecord) as readonly GraphqlErrorEnvelope[];
    return err(
      errors.length === envelope.errors.length
        ? mapLinearGraphqlErrors(errors)
        : domainError("external_failure"),
    );
  }
  if (envelope.data === undefined || envelope.data === null) {
    return err(domainError("external_failure"));
  }
  return ok(envelope.data as Data);
}

function validConnection<Node>(value: unknown): value is LinearGraphqlConnection<Node> {
  if (!isRecord(value) || !Array.isArray(value["nodes"]) || !isRecord(value["pageInfo"])) {
    return false;
  }
  const pageInfo = value["pageInfo"];
  if (typeof pageInfo["hasNextPage"] !== "boolean") return false;
  const endCursor = pageInfo["endCursor"];
  return endCursor === undefined || endCursor === null || typeof endCursor === "string";
}

function validMaxResponseBytes(value: number | undefined): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= maximumConfiguredResponseBytes
    ? value
    : defaultMaxResponseBytes;
}

function declaredContentLength(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (header === null) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(header)) throw new ResponseBodyRejected();
  const length = Number(header);
  if (!Number.isSafeInteger(length)) throw new ResponseBodyRejected();
  return length;
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body === null || response.body.locked) return;
  try {
    await response.body.cancel();
  } catch {
    // Cancellation is best-effort; callers still fail closed without echoing the body.
  }
}

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declaredBytes = declaredContentLength(response);
  if (declaredBytes !== undefined && declaredBytes > maximumBytes) {
    await cancelBody(response);
    throw new ResponseBodyRejected();
  }
  if (response.body === null) return "";

  const body: ReadableStream<Uint8Array> = response.body;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";
  let cancellation: Promise<void> | undefined;
  const cancelReader = () => {
    cancellation ??= reader.cancel().catch(() => undefined);
  };
  const onAbort = () => {
    cancelReader();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const requireActiveRequest = () => {
    if (signal.aborted) throw new RequestStopped("interrupted");
  };
  try {
    for (;;) {
      requireActiveRequest();
      const chunk = await reader.read();
      requireActiveRequest();
      if (chunk.done) {
        text += decoder.decode();
        return text;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > maximumBytes) {
        cancelReader();
        if (cancellation !== undefined) await cancellation;
        throw new ResponseBodyRejected();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (error instanceof RequestStopped || error instanceof ResponseBodyRejected) throw error;
    throw new ResponseBodyRejected();
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      cancelReader();
      if (cancellation !== undefined) await cancellation;
    }
    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may already have released its reader.
    }
  }
}

async function waitForSettlement(promise: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, abortSettlementGraceMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class LinearGraphqlTransport {
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: LinearFetch;

  constructor(options: LinearGraphqlTransportOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("linear_api_key_required");
    this.#apiKey = options.apiKey.trim();
    this.#endpoint = options.endpoint ?? defaultEndpoint;
    this.#timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? defaultTimeoutMs));
    this.#maxResponseBytes = validMaxResponseBytes(options.maxResponseBytes);
    this.#fetch = options.fetch ?? fetch;
  }

  async request<Data, Variables extends Record<string, unknown>>(
    request: LinearGraphqlRequest<Variables>,
    options: LinearRequestOptions = {},
  ): Promise<LinearTransportResult<Data>> {
    if (options.signal?.aborted === true) return err(domainError("interrupted"));

    let body: string;
    try {
      body = JSON.stringify(request);
    } catch {
      return err(domainError("external_failure"));
    }

    const controller = new AbortController();
    let stoppedReason: RequestStopped["reason"] | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        stoppedReason = "timeout";
        const stoppedError = new RequestStopped(stoppedReason);
        controller.abort(stoppedError);
        reject(stoppedError);
      }, this.#timeoutMs);
      if (options.signal !== undefined) {
        const onAbort = () => {
          stoppedReason = "interrupted";
          const stoppedError = new RequestStopped(stoppedReason);
          controller.abort(stoppedError);
          reject(stoppedError);
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeExternalAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
    });

    const operation = (async () => {
      const fetched = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: Object.freeze({
          authorization: this.#apiKey,
          "content-type": "application/json",
        }),
        body,
        signal: controller.signal,
      });
      if (!fetched.ok) {
        await cancelBody(fetched);
        return { response: fetched, bodyText: undefined };
      }
      return {
        response: fetched,
        bodyText: await readBoundedResponseBody(fetched, this.#maxResponseBytes, controller.signal),
      };
    })();

    let response: Response;
    let bodyText: string | undefined;
    try {
      ({ response, bodyText } = await Promise.race([operation, stopped]));
    } catch (error) {
      if (error instanceof RequestStopped || stoppedReason !== undefined) {
        controller.abort(error);
        await waitForSettlement(operation);
        return err(
          domainError(
            stoppedReason ?? (error instanceof RequestStopped ? error.reason : "timeout"),
          ),
        );
      }
      if (error instanceof ResponseBodyRejected) {
        controller.abort(error);
        await waitForSettlement(operation);
        return err(domainError("external_failure"));
      }
      return err(domainError("unavailable"));
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeExternalAbort?.();
    }

    if (!response.ok) return err(mapLinearHttpStatus(response.status));
    let envelope: unknown;
    try {
      envelope = JSON.parse(bodyText ?? "");
    } catch {
      return err(domainError("external_failure"));
    }
    return parseEnvelope<Data>(envelope);
  }

  async paginate<Data, Node>(
    request: LinearPaginationRequest<Data, Node>,
    options: LinearRequestOptions = {},
  ): Promise<LinearTransportResult<readonly Node[]>> {
    const cursorVariable = request.cursorVariable ?? "after";
    const maxPages = Math.max(1, Math.trunc(request.maxPages ?? defaultMaxPages));
    const nodes: Node[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.request<Data, Record<string, unknown>>(
        {
          query: request.query,
          variables: { ...(request.variables ?? {}), [cursorVariable]: cursor },
          ...(request.operationName === undefined ? {} : { operationName: request.operationName }),
        },
        options,
      );
      if (!result.ok) return result;

      let connection: unknown;
      try {
        connection = request.selectConnection(result.value);
      } catch {
        return err(domainError("external_failure"));
      }
      if (!validConnection<Node>(connection)) return err(domainError("external_failure"));
      nodes.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return ok(Object.freeze(nodes));

      const nextCursor = connection.pageInfo.endCursor;
      if (
        typeof nextCursor !== "string" ||
        nextCursor.length === 0 ||
        seenCursors.has(nextCursor)
      ) {
        return err(domainError("external_failure"));
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return err(domainError("external_failure"));
  }
}
