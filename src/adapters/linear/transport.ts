import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";

const defaultEndpoint = "https://api.linear.app/graphql";
const defaultTimeoutMs = 15_000;
const defaultMaxPages = 100;

export type LinearTransportResult<Value> = Result<Value, DomainError>;

export type LinearFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LinearGraphqlRequest<Variables extends Record<string, unknown>> {
  readonly query: string;
  readonly variables: Variables;
  readonly operationName?: string;
}

export interface LinearRequestOptions {
  readonly signal?: AbortSignal;
}

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

export class LinearGraphqlTransport {
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #fetch: LinearFetch;

  constructor(options: LinearGraphqlTransportOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("linear_api_key_required");
    this.#apiKey = options.apiKey.trim();
    this.#endpoint = options.endpoint ?? defaultEndpoint;
    this.#timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? defaultTimeoutMs));
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new RequestStopped("timeout"));
        controller.abort();
      }, this.#timeoutMs);
      if (options.signal !== undefined) {
        const onAbort = () => {
          reject(new RequestStopped("interrupted"));
          controller.abort();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeExternalAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
    });

    let response: Response;
    let bodyText: string | undefined;
    try {
      ({ response, bodyText } = await Promise.race([
        (async () => {
          const fetched = await this.#fetch(this.#endpoint, {
            method: "POST",
            headers: Object.freeze({
              authorization: this.#apiKey,
              "content-type": "application/json",
            }),
            body,
            signal: controller.signal,
          });
          return {
            response: fetched,
            bodyText: fetched.ok ? await fetched.text() : undefined,
          };
        })(),
        stopped,
      ]));
    } catch (error) {
      if (error instanceof RequestStopped) return err(domainError(error.reason));
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
