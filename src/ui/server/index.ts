import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  validateHeaderName,
  validateHeaderValue,
} from "node:http";

import { responseLeaksCredentials, untrustedInputIsUnsafe } from "../security/canonical.js";
import { readBoundedJsonMutation, type UiJsonObject } from "./json.js";

export type { UiJsonArray, UiJsonObject, UiJsonPrimitive, UiJsonValue } from "./json.js";

export const localhostUiHost = "127.0.0.1";
export const defaultUiIdleTimeoutMs = 15 * 60 * 1_000;

const minimumTokenBytes = 32;
const maximumTimerDelayMs = 2_147_483_647;
const base64UrlTokenPattern = /^[A-Za-z0-9_-]+$/u;
const handlerHeaders: Readonly<IncomingHttpHeaders> = Object.freeze({});

export interface UiServerClock {
  now(): number;
}

export interface UiRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<IncomingHttpHeaders>;
  readonly auth: Readonly<{ kind: UiAuthKind }>;
  readonly body?: UiJsonObject;
}

export interface UiResponse {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: string | Uint8Array;
}

export type UiRequestHandler = (request: UiRequest) => UiResponse | Promise<UiResponse>;

export type UiAuthKind = "public" | "bearer" | "session";

export type UiHandlerResponseContract = "standard" | "secret-safe";

export interface UiSecurityRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<IncomingHttpHeaders>;
  readonly bearerAuthenticated: boolean;
  readonly serverOrigin: string;
}

export type UiSecurityDecision =
  | Readonly<{
      kind: "allow";
      authKind: UiAuthKind;
      handlerUrl: string;
      responseContract: UiHandlerResponseContract;
      mutationBody: "none" | "bounded-json";
      refreshIdle: boolean;
    }>
  | Readonly<{ kind: "respond"; response: UiResponse; refreshIdle: boolean }>;

export interface UiSecurityPolicy {
  readonly authorize: (request: UiSecurityRequest) => UiSecurityDecision;
  readonly secureResponse: (response: UiResponse) => UiResponse;
  readonly handlerResponseIsAllowed: (
    contract: UiHandlerResponseContract,
    response: UiResponse,
  ) => boolean;
  readonly responseContainsSensitiveData: (response: UiResponse) => boolean;
  readonly invalidate: () => void;
}

export type UiServerStatus = Readonly<
  { state: "active"; idleDeadlineMs: number } | { state: "locked" } | { state: "closed" }
>;

export interface LocalUiServerHandle {
  readonly baseUrl: string;
  readonly sessionToken: string;
  readonly close: () => Promise<void>;
  readonly status: () => UiServerStatus;
}

export interface StartLocalUiServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly idleTimeoutMs?: number;
  readonly maxJsonMutationBodyBytes?: number;
  readonly clock?: UiServerClock;
  readonly tokenSource?: () => Uint8Array;
  readonly handler?: UiRequestHandler;
  readonly securityPolicy?: UiSecurityPolicy;
}

export class LocalUiServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalUiServerError";
  }
}

const systemClock: UiServerClock = Object.freeze({ now: () => Date.now() });

function fixedResponse(statusCode: number, body: string): UiResponse {
  return Object.freeze({ statusCode, body });
}

const defaultHandler: UiRequestHandler = () => fixedResponse(404, "Not Found\n");

type OutboundResponseGuard = (response: UiResponse) => boolean;

function validateOptions(host: string, port: number, idleTimeoutMs: number): void {
  if (host !== localhostUiHost) {
    throw new LocalUiServerError("Local UI server must bind to 127.0.0.1.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new LocalUiServerError("Local UI server port is invalid.");
  }
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new LocalUiServerError("Local UI server idle timeout is invalid.");
  }
}

function createSessionToken(tokenSource: () => Uint8Array): string {
  try {
    const bytes = Uint8Array.from(tokenSource());
    if (bytes.byteLength < minimumTokenBytes) {
      throw new LocalUiServerError("Local UI session token source is too short.");
    }
    return Buffer.from(bytes).toString("base64url");
  } catch {
    throw new LocalUiServerError("Unable to initialize local UI session.");
  }
}

function clockMilliseconds(clock: UiServerClock): number | undefined {
  try {
    const value = clock.now();
    return Number.isSafeInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function authorized(request: IncomingMessage, expectedDigest: Uint8Array): boolean {
  const values = request.headersDistinct["authorization"];
  if (values?.length !== 1) return false;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(values[0] ?? "");
  if (match === null) return false;
  const candidate = match[1];
  if (candidate === undefined || !base64UrlTokenPattern.test(candidate)) return false;
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function sanitizedHeaders(
  headers: Readonly<IncomingHttpHeaders>,
  sensitiveNames: ReadonlySet<string>,
): Readonly<IncomingHttpHeaders> {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (sensitiveNames.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = Array.isArray(value) ? [...value] : value;
  }
  return Object.freeze(result);
}

function distinctHeaders(request: IncomingMessage): Readonly<IncomingHttpHeaders> {
  const result: IncomingHttpHeaders = {};
  for (const [name, values] of Object.entries(request.headersDistinct)) {
    if (values === undefined) continue;
    result[name] = values.length === 1 ? values[0] : [...values];
  }
  return Object.freeze(result);
}

function responseHeadersAreValid(response: UiResponse): boolean {
  if (response.headers === undefined) return true;
  try {
    for (const [name, value] of Object.entries(response.headers)) {
      validateHeaderName(name);
      const values = typeof value === "string" ? [value] : value;
      for (const entry of values) validateHeaderValue(name, entry);
    }
    return true;
  } catch {
    return false;
  }
}

function send(
  response: ServerResponse,
  result: UiResponse,
  outboundResponseIsAllowed: OutboundResponseGuard,
): void {
  if (response.destroyed || response.writableEnded) return;
  if (!outboundResponseIsAllowed(result)) {
    response.destroy();
    return;
  }
  response.statusCode = result.statusCode;
  if (result.headers !== undefined) {
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, typeof value === "string" ? value : [...value]);
    }
  }
  response.end(result.body);
}

function sendFixed(
  response: ServerResponse,
  statusCode: number,
  body: string,
  outboundResponseIsAllowed: OutboundResponseGuard,
  securityPolicy?: UiSecurityPolicy,
  closeConnection = false,
): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  for (const name of response.getHeaderNames()) response.removeHeader(name);
  const secured = securityPolicy?.secureResponse({ statusCode, body }) ?? { statusCode, body };
  const result: UiResponse = Object.freeze({
    statusCode: secured.statusCode,
    headers: Object.freeze({
      ...secured.headers,
      ...(Object.keys(secured.headers ?? {}).some((name) => name.toLowerCase() === "content-type")
        ? {}
        : { "content-type": "text/plain; charset=utf-8" }),
      ...(closeConnection ? { connection: "close" } : {}),
    }),
    ...(secured.body === undefined ? {} : { body: secured.body }),
  });
  send(response, result, outboundResponseIsAllowed);
}

function rawSocketResponse(
  source: UiResponse,
  outboundResponseIsAllowed: OutboundResponseGuard,
  securityPolicy?: UiSecurityPolicy,
): string | undefined {
  const secured = securityPolicy?.secureResponse(source) ?? source;
  if (secured.statusCode !== 400 && secured.statusCode !== 405) return undefined;
  const result: UiResponse = Object.freeze({
    statusCode: secured.statusCode,
    headers: Object.freeze({
      ...secured.headers,
      connection: "close",
      "content-length": "0",
    }),
  });
  if (!outboundResponseIsAllowed(result)) return undefined;
  const reason = secured.statusCode === 400 ? "Bad Request" : "Method Not Allowed";
  const lines = [`HTTP/1.1 ${String(secured.statusCode)} ${reason}`];
  if (result.headers !== undefined) {
    for (const [name, value] of Object.entries(result.headers)) {
      const values = typeof value === "string" ? [value] : value;
      for (const entry of values) lines.push(`${name}: ${entry}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function endRawSocket(
  socket: NodeJS.WritableStream & Readonly<{ writable: boolean }>,
  source: UiResponse,
  outboundResponseIsAllowed: OutboundResponseGuard,
  securityPolicy?: UiSecurityPolicy,
): void {
  if (!socket.writable) return;
  const result = rawSocketResponse(source, outboundResponseIsAllowed, securityPolicy);
  if (result === undefined) {
    socket.end();
    return;
  }
  socket.end(result);
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failed = (): void => {
      server.off("listening", listening);
      reject(new LocalUiServerError("Unable to start local UI server."));
    };
    const listening = (): void => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    try {
      server.listen({ host, port, exclusive: true });
    } catch {
      server.off("error", failed);
      server.off("listening", listening);
      reject(new LocalUiServerError("Unable to start local UI server."));
    }
  });
}

export async function startLocalUiServer(
  options: StartLocalUiServerOptions = {},
): Promise<LocalUiServerHandle> {
  const host = options.host ?? localhostUiHost;
  const port = options.port ?? 0;
  const idleTimeoutMs = options.idleTimeoutMs ?? defaultUiIdleTimeoutMs;
  const maxJsonMutationBodyBytes = options.maxJsonMutationBodyBytes ?? 16_384;
  validateOptions(host, port, idleTimeoutMs);
  if (!Number.isSafeInteger(maxJsonMutationBodyBytes) || maxJsonMutationBodyBytes <= 0) {
    throw new LocalUiServerError("Local UI JSON mutation body limit is invalid.");
  }

  const clock = options.clock ?? systemClock;
  const tokenSource = options.tokenSource ?? (() => randomBytes(minimumTokenBytes));
  const handler = options.handler ?? defaultHandler;
  const securityPolicy = options.securityPolicy;
  const initialNow = clockMilliseconds(clock);
  if (initialNow === undefined) {
    throw new LocalUiServerError("Unable to initialize local UI session.");
  }
  const sessionToken = createSessionToken(tokenSource);
  const expectedDigest = createHash("sha256").update(sessionToken, "utf8").digest();

  let lifecycle: "active" | "locked" | "closed" = "active";
  let idleDeadlineMs = initialNow + idleTimeoutMs;
  if (!Number.isSafeInteger(idleDeadlineMs)) {
    throw new LocalUiServerError("Unable to initialize local UI session.");
  }
  let idleTimer: NodeJS.Timeout | undefined;
  let closePromise: Promise<void> | undefined;
  let serverOrigin = "";
  const currentLifecycle = (): "active" | "locked" | "closed" => lifecycle;

  const outboundResponseIsAllowed: OutboundResponseGuard = (result) =>
    Number.isInteger(result.statusCode) &&
    result.statusCode >= 100 &&
    result.statusCode <= 999 &&
    responseHeadersAreValid(result) &&
    !responseLeaksCredentials(result, [sessionToken]) &&
    securityPolicy?.responseContainsSensitiveData(result) !== true;

  const authorizeRequest = (request: IncomingMessage): UiSecurityDecision => {
    const bearerAuthenticated = authorized(request, expectedDigest);
    const incomingHeaders = distinctHeaders(request);
    const policyHeaders = sanitizedHeaders(incomingHeaders, new Set(["authorization"]));
    const rawUrl = request.url ?? "";
    return untrustedInputIsUnsafe(rawUrl, [sessionToken])
      ? Object.freeze({
          kind: "respond",
          response: fixedResponse(400, "Bad Request\n"),
          refreshIdle: false,
        })
      : (securityPolicy?.authorize(
          Object.freeze({
            method: request.method ?? "",
            url: rawUrl,
            headers: policyHeaders,
            bearerAuthenticated,
            serverOrigin,
          }),
        ) ??
          (bearerAuthenticated
            ? Object.freeze({
                kind: "allow",
                authKind: "bearer",
                handlerUrl: rawUrl,
                responseContract: "standard",
                mutationBody: "none",
                refreshIdle: true,
              })
            : Object.freeze({
                kind: "respond",
                response: fixedResponse(401, "Unauthorized\n"),
                refreshIdle: false,
              })));
  };

  const lockIfExpired = (): void => {
    if (lifecycle !== "active") return;
    const now = clockMilliseconds(clock);
    if (now === undefined || !Number.isFinite(idleDeadlineMs) || now >= idleDeadlineMs) {
      lifecycle = "locked";
      securityPolicy?.invalidate();
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const scheduleLock = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (lifecycle !== "active") return;
    const now = clockMilliseconds(clock);
    if (now === undefined || now >= idleDeadlineMs) {
      lockIfExpired();
      return;
    }
    idleTimer = setTimeout(
      () => {
        idleTimer = undefined;
        lockIfExpired();
        if (lifecycle === "active") scheduleLock();
      },
      Math.min(maximumTimerDelayMs, Math.max(1, idleDeadlineMs - now)),
    );
    idleTimer.unref();
  };

  const server = createServer((request, response) => {
    const handleRequest = async (): Promise<void> => {
      lockIfExpired();
      if (lifecycle === "closed") {
        sendFixed(
          response,
          503,
          "Service Unavailable\n",
          outboundResponseIsAllowed,
          securityPolicy,
        );
        return;
      }
      if (lifecycle === "locked") {
        sendFixed(response, 423, "Locked\n", outboundResponseIsAllowed, securityPolicy);
        return;
      }

      const decision = authorizeRequest(request);

      const refreshIdle = (): boolean => {
        const now = clockMilliseconds(clock);
        if (now === undefined) {
          lifecycle = "locked";
          securityPolicy?.invalidate();
          sendFixed(response, 423, "Locked\n", outboundResponseIsAllowed, securityPolicy);
          return false;
        }
        idleDeadlineMs = now + idleTimeoutMs;
        if (!Number.isSafeInteger(idleDeadlineMs)) {
          lifecycle = "locked";
          securityPolicy?.invalidate();
          sendFixed(response, 423, "Locked\n", outboundResponseIsAllowed, securityPolicy);
          return false;
        }
        scheduleLock();
        return true;
      };

      try {
        let mutationBody: UiJsonObject | undefined;
        if (
          decision.kind === "allow" &&
          decision.mutationBody === "bounded-json" &&
          request.method !== "GET" &&
          request.method !== "HEAD"
        ) {
          const parsed = await readBoundedJsonMutation(request, maxJsonMutationBodyBytes);
          lockIfExpired();
          const postReadLifecycle = currentLifecycle();
          if (postReadLifecycle === "closed") {
            sendFixed(
              response,
              503,
              "Service Unavailable\n",
              outboundResponseIsAllowed,
              securityPolicy,
              true,
            );
            return;
          }
          if (postReadLifecycle === "locked") {
            sendFixed(response, 423, "Locked\n", outboundResponseIsAllowed, securityPolicy, true);
            return;
          }
          if (!parsed.ok) {
            const rejected = securityPolicy?.secureResponse({
              statusCode: parsed.statusCode,
              headers: Object.freeze({
                connection: "close",
                "content-type": "text/plain; charset=utf-8",
              }),
              body: parsed.responseBody,
            }) ?? {
              statusCode: parsed.statusCode,
              headers: Object.freeze({
                connection: "close",
                "content-type": "text/plain; charset=utf-8",
              }),
              body: parsed.responseBody,
            };
            send(response, rejected, outboundResponseIsAllowed);
            return;
          }
          mutationBody = parsed.body;
        }
        const handlerResult =
          decision.kind === "respond"
            ? decision.response
            : await handler(
                Object.freeze({
                  method: request.method ?? "",
                  url: decision.handlerUrl,
                  headers: handlerHeaders,
                  auth: Object.freeze({ kind: decision.authKind }),
                  ...(mutationBody === undefined ? {} : { body: mutationBody }),
                }),
              );
        if (
          decision.kind === "allow" &&
          securityPolicy?.handlerResponseIsAllowed(decision.responseContract, handlerResult) ===
            false
        ) {
          sendFixed(
            response,
            500,
            "Internal Server Error\n",
            outboundResponseIsAllowed,
            securityPolicy,
          );
          return;
        }
        const securedResult = securityPolicy?.secureResponse(handlerResult) ?? handlerResult;
        if (!outboundResponseIsAllowed(securedResult)) {
          sendFixed(
            response,
            500,
            "Internal Server Error\n",
            outboundResponseIsAllowed,
            securityPolicy,
          );
          return;
        }
        if (
          decision.refreshIdle &&
          securedResult.statusCode >= 200 &&
          securedResult.statusCode < 400 &&
          !refreshIdle()
        ) {
          return;
        }
        send(response, securedResult, outboundResponseIsAllowed);
      } catch {
        sendFixed(
          response,
          500,
          "Internal Server Error\n",
          outboundResponseIsAllowed,
          securityPolicy,
        );
      }
    };
    void handleRequest().catch(() => {
      sendFixed(
        response,
        500,
        "Internal Server Error\n",
        outboundResponseIsAllowed,
        securityPolicy,
      );
    });
  });

  server.on("clientError", (_error, socket) => {
    endRawSocket(
      socket,
      fixedResponse(400, "Bad Request\n"),
      outboundResponseIsAllowed,
      securityPolicy,
    );
  });
  server.on("connect", (request, socket) => {
    let rejected = fixedResponse(405, "Method Not Allowed\n");
    try {
      lockIfExpired();
      if (currentLifecycle() === "active") {
        const decision = authorizeRequest(request);
        if (decision.kind === "respond" && decision.response.statusCode === 405) {
          rejected = decision.response;
        }
      }
    } catch {
      // A CONNECT request never bypasses the fixed denial if policy evaluation fails.
    }
    endRawSocket(socket, rejected, outboundResponseIsAllowed, securityPolicy);
  });
  server.on("upgrade", (_request, socket) => {
    endRawSocket(
      socket,
      fixedResponse(405, "Method Not Allowed\n"),
      outboundResponseIsAllowed,
      securityPolicy,
    );
  });

  try {
    await listen(server, host, port);
  } catch {
    lifecycle = "closed";
    securityPolicy?.invalidate();
    throw new LocalUiServerError("Unable to start local UI server.");
  }
  server.on("error", () => {
    // Runtime server errors are intentionally contained and never rendered with request data.
  });

  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== localhostUiHost) {
    lifecycle = "closed";
    securityPolicy?.invalidate();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    throw new LocalUiServerError("Unable to start local UI server.");
  }
  const baseUrl = `http://${localhostUiHost}:${String(address.port)}`;
  serverOrigin = baseUrl;
  scheduleLock();

  const status = (): UiServerStatus => {
    lockIfExpired();
    if (lifecycle === "active") return Object.freeze({ state: "active", idleDeadlineMs });
    return Object.freeze({ state: lifecycle });
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    lifecycle = "closed";
    securityPolicy?.invalidate();
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    closePromise = new Promise<void>((resolve) => {
      try {
        server.close(() => {
          resolve();
        });
      } catch {
        resolve();
      }
    });
    return closePromise;
  };

  return Object.freeze({ baseUrl, sessionToken, close, status });
}
