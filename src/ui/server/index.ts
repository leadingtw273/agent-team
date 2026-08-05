import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export const localhostUiHost = "127.0.0.1";
export const defaultUiIdleTimeoutMs = 15 * 60 * 1_000;

const minimumTokenBytes = 32;
const maximumTimerDelayMs = 2_147_483_647;
const base64UrlTokenPattern = /^[A-Za-z0-9_-]+$/u;

export interface UiServerClock {
  now(): number;
}

export interface UiRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<IncomingHttpHeaders>;
}

export interface UiResponse {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: string | Uint8Array;
}

export type UiRequestHandler = (request: UiRequest) => UiResponse | Promise<UiResponse>;

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
  readonly clock?: UiServerClock;
  readonly tokenSource?: () => Uint8Array;
  readonly handler?: UiRequestHandler;
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

function sanitizedHeaders(headers: IncomingHttpHeaders): Readonly<IncomingHttpHeaders> {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization" || value === undefined) continue;
    result[name] = Array.isArray(value) ? [...value] : value;
  }
  return Object.freeze(result);
}

function responseContainsToken(response: UiResponse, sessionToken: string): boolean {
  if (response.headers !== undefined) {
    for (const [name, value] of Object.entries(response.headers)) {
      if (name.includes(sessionToken)) return true;
      const values = typeof value === "string" ? [value] : value;
      if (values.some((entry) => entry.includes(sessionToken))) return true;
    }
  }
  if (typeof response.body === "string") return response.body.includes(sessionToken);
  if (response.body !== undefined) {
    return Buffer.from(response.body).includes(Buffer.from(sessionToken, "utf8"));
  }
  return false;
}

function send(response: ServerResponse, result: UiResponse): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = result.statusCode;
  if (result.headers !== undefined) {
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, typeof value === "string" ? value : [...value]);
    }
  }
  response.end(result.body);
}

function sendFixed(response: ServerResponse, statusCode: number, body: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  for (const name of response.getHeaderNames()) response.removeHeader(name);
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
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
  validateOptions(host, port, idleTimeoutMs);

  const clock = options.clock ?? systemClock;
  const tokenSource = options.tokenSource ?? (() => randomBytes(minimumTokenBytes));
  const handler = options.handler ?? defaultHandler;
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

  const lockIfExpired = (): void => {
    if (lifecycle !== "active") return;
    const now = clockMilliseconds(clock);
    if (now === undefined || !Number.isFinite(idleDeadlineMs) || now >= idleDeadlineMs) {
      lifecycle = "locked";
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
        sendFixed(response, 503, "Service Unavailable\n");
        return;
      }
      if (lifecycle === "locked") {
        sendFixed(response, 423, "Locked\n");
        return;
      }
      if (!authorized(request, expectedDigest)) {
        sendFixed(response, 401, "Unauthorized\n");
        return;
      }

      const now = clockMilliseconds(clock);
      if (now === undefined) {
        lifecycle = "locked";
        sendFixed(response, 423, "Locked\n");
        return;
      }
      idleDeadlineMs = now + idleTimeoutMs;
      if (!Number.isSafeInteger(idleDeadlineMs)) {
        lifecycle = "locked";
        sendFixed(response, 423, "Locked\n");
        return;
      }
      scheduleLock();

      try {
        const result = await handler(
          Object.freeze({
            method: request.method ?? "",
            url: request.url ?? "",
            headers: sanitizedHeaders(request.headers),
          }),
        );
        if (
          !Number.isInteger(result.statusCode) ||
          result.statusCode < 100 ||
          result.statusCode > 999 ||
          responseContainsToken(result, sessionToken)
        ) {
          sendFixed(response, 500, "Internal Server Error\n");
          return;
        }
        send(response, result);
      } catch {
        sendFixed(response, 500, "Internal Server Error\n");
      }
    };
    void handleRequest().catch(() => {
      sendFixed(response, 500, "Internal Server Error\n");
    });
  });

  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  try {
    await listen(server, host, port);
  } catch {
    lifecycle = "closed";
    throw new LocalUiServerError("Unable to start local UI server.");
  }
  server.on("error", () => {
    // Runtime server errors are intentionally contained and never rendered with request data.
  });

  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== localhostUiHost) {
    lifecycle = "closed";
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    throw new LocalUiServerError("Unable to start local UI server.");
  }
  const baseUrl = `http://${localhostUiHost}:${String(address.port)}`;
  scheduleLock();

  const status = (): UiServerStatus => {
    lockIfExpired();
    if (lifecycle === "active") return Object.freeze({ state: "active", idleDeadlineMs });
    return Object.freeze({ state: lifecycle });
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    lifecycle = "closed";
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
