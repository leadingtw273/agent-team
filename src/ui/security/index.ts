import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type {
  UiHandlerResponseContract,
  UiResponse,
  UiSecurityDecision,
  UiSecurityPolicy,
  UiSecurityRequest,
} from "../server/index.js";
import { responseLeaksCredentials, untrustedInputIsUnsafe } from "./canonical.js";
import { isSecretSafeJsonResponse } from "./secret.js";

export { createSecretSafeJsonResponse, projectSecretSafeMetadata } from "./secret.js";
export type { SecretSafeJsonResponse, SecretSafeMetadata } from "./secret.js";

const sessionCookieName = "agent_team_session";
const csrfHeaderName = "x-csrf-token";
const tokenBytes = 32;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const forbiddenQueryKeyPattern = /^(?:authorization|csrf|secret|session|token)$/iu;
const readMethods = new Set(["GET", "HEAD"]);
const routeMethodOrder = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
const routeMethods = new Set<string>(routeMethodOrder);

export type UiSecurityRouteMethod = (typeof routeMethodOrder)[number];

export interface UiSecurityRouteContract {
  readonly path: string;
  readonly allowedQueryParameters: readonly string[];
  /**
   * Exact methods accepted by this route. GET implicitly enables HEAD, while HEAD may be declared
   * independently; the policy emits methods in canonical Allow order. Omission preserves the
   * legacy six-method U001-U003 contract. New bounded mutation routes should always declare it.
   */
  readonly allowedMethods?: readonly UiSecurityRouteMethod[];
  readonly response: UiHandlerResponseContract;
  readonly mutationBody?: "bounded-json";
}

export interface CreateUiSecurityPolicyOptions {
  readonly routes?: readonly UiSecurityRouteContract[];
}

interface ParsedRequestTarget {
  readonly path: string;
  readonly handlerUrl: string;
  readonly route?: ValidatedUiSecurityRouteContract;
}

type ValidatedUiSecurityRouteContract = Readonly<
  Omit<UiSecurityRouteContract, "allowedMethods"> & {
    readonly allowedMethods: readonly UiSecurityRouteMethod[];
  }
>;

const defaultRoutes: readonly UiSecurityRouteContract[] = Object.freeze([
  Object.freeze({
    path: "/api/projects",
    allowedQueryParameters: Object.freeze([]),
    response: "standard" as const,
  }),
  Object.freeze({
    path: "/api/settings",
    allowedQueryParameters: Object.freeze([]),
    response: "secret-safe" as const,
  }),
]);

export const uiContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://cdn.jsdelivr.net",
].join("; ");

const securityHeaders: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": uiContentSecurityPolicy,
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

const bootstrapShell = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Team</title></head>
<body><main id="app" aria-live="polite">正在建立本機安全工作階段…</main><script src="/__bootstrap.js" defer></script></body>
</html>
`;

const bootstrapScript = `(() => {
  "use strict";
  const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  history.replaceState(null, "", window.location.pathname + window.location.search);
  const exchange = fragment.length > 0
    ? fetch("/__session/exchange", {
        method: "POST",
        credentials: "same-origin",
        headers: { authorization: "Bearer " + fragment },
      })
    : fetch("/__session/csrf", { method: "GET", credentials: "same-origin" });
  exchange.then((response) => {
    if (!response.ok) throw new Error("locked");
    const csrf = response.headers.get("x-csrf-token");
    if (csrf) sessionStorage.setItem("agent-team-csrf", csrf);
    window.dispatchEvent(new Event("agent-team-session-ready"));
  }).catch(() => {
    sessionStorage.removeItem("agent-team-csrf");
    const app = document.getElementById("app");
    if (app) app.textContent = "工作階段已鎖定，請重新啟動 Agent Team UI。";
  });
})();
`;

interface ActiveSession {
  readonly sessionToken: string;
  readonly sessionDigest: Buffer;
  readonly csrfToken: string;
  readonly csrfDigest: Buffer;
}

function response(statusCode: number, body: string): UiResponse {
  return Object.freeze({ statusCode, body });
}

function responseWithHeaders(
  statusCode: number,
  headers: Readonly<Record<string, string>>,
  body?: string,
): UiResponse {
  return body === undefined
    ? Object.freeze({ statusCode, headers })
    : Object.freeze({ statusCode, headers, body });
}

function respond(result: UiResponse, refreshIdle = false): UiSecurityDecision {
  return Object.freeze({ kind: "respond", response: result, refreshIdle });
}

function allowSession(
  handlerUrl: string,
  responseContract: UiHandlerResponseContract,
  mutationBody: "bounded-json" | undefined,
): UiSecurityDecision {
  return Object.freeze({
    kind: "allow",
    authKind: "session",
    handlerUrl,
    responseContract,
    mutationBody: mutationBody ?? "none",
    refreshIdle: true,
  });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secureEqual(candidate: string, expectedDigest: Buffer): boolean {
  const candidateDigest = digest(candidate);
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function singleHeader(headers: Readonly<IncomingHttpHeaders>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function cookieValue(headers: Readonly<IncomingHttpHeaders>): string | undefined {
  const header = singleHeader(headers, "cookie");
  if (header === undefined) return undefined;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${sessionCookieName}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0]?.slice(sessionCookieName.length + 1);
  return value !== undefined && tokenPattern.test(value) ? value : undefined;
}

function validatedRoutes(
  configured: readonly UiSecurityRouteContract[] | undefined,
): ReadonlyMap<string, ValidatedUiSecurityRouteContract> {
  const result = new Map<string, ValidatedUiSecurityRouteContract>();
  for (const route of configured ?? defaultRoutes) {
    const configuredMutationBody: unknown = route.mutationBody;
    const configuredAllowedMethods: unknown = route.allowedMethods;
    if (
      !route.path.startsWith("/") ||
      route.path.startsWith("//") ||
      route.path.includes("?") ||
      route.path.includes("#") ||
      route.path.includes("\\") ||
      decodeURI(route.path) !== route.path ||
      result.has(route.path) ||
      (configuredMutationBody !== undefined && configuredMutationBody !== "bounded-json") ||
      (configuredAllowedMethods !== undefined &&
        (!Array.isArray(configuredAllowedMethods) || configuredAllowedMethods.length === 0))
    ) {
      throw new TypeError("Invalid UI security route contract.");
    }
    const declaredMethods = new Set<UiSecurityRouteMethod>();
    for (const method of configuredAllowedMethods ?? routeMethodOrder) {
      if (
        typeof method !== "string" ||
        !routeMethods.has(method) ||
        declaredMethods.has(method as UiSecurityRouteMethod)
      ) {
        throw new TypeError("Invalid UI security route contract.");
      }
      declaredMethods.add(method as UiSecurityRouteMethod);
    }
    if (declaredMethods.has("GET")) declaredMethods.add("HEAD");
    const allowedMethods = Object.freeze(
      routeMethodOrder.filter((method) => declaredMethods.has(method)),
    );
    const allowed = new Set<string>();
    for (const parameter of route.allowedQueryParameters) {
      if (
        !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(parameter) ||
        forbiddenQueryKeyPattern.test(parameter) ||
        allowed.has(parameter)
      ) {
        throw new TypeError("Invalid UI security query contract.");
      }
      allowed.add(parameter);
    }
    result.set(
      route.path,
      Object.freeze({
        path: route.path,
        allowedQueryParameters: Object.freeze([...route.allowedQueryParameters]),
        allowedMethods,
        response: route.response,
        ...(route.mutationBody === undefined ? {} : { mutationBody: route.mutationBody }),
      }),
    );
  }
  return result;
}

function parseRequestTarget(
  target: string,
  routes: ReadonlyMap<string, ValidatedUiSecurityRouteContract>,
): ParsedRequestTarget | undefined {
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#") ||
    target.includes("\\")
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(target, "http://127.0.0.1");
    if (parsed.origin !== "http://127.0.0.1" || decodeURI(parsed.pathname) !== parsed.pathname) {
      return undefined;
    }
    const route = routes.get(parsed.pathname);
    if (route === undefined) {
      return Object.freeze({ path: parsed.pathname, handlerUrl: parsed.pathname });
    }
    const rawQuery = target.includes("?") ? target.slice(target.indexOf("?") + 1) : "";
    if (rawQuery.length > 0) decodeURIComponent(rawQuery.replaceAll("+", " "));
    const values = new Map<string, string>();
    for (const [key, value] of parsed.searchParams) {
      if (
        key.includes("%") ||
        value.includes("%") ||
        forbiddenQueryKeyPattern.test(key) ||
        !route.allowedQueryParameters.includes(key) ||
        values.has(key)
      ) {
        return undefined;
      }
      values.set(key, value);
    }
    const canonical = new URLSearchParams();
    for (const key of route.allowedQueryParameters) {
      const value = values.get(key);
      if (value !== undefined) canonical.set(key, value);
    }
    const query = canonical.toString();
    return Object.freeze({
      path: parsed.pathname,
      handlerUrl: query.length === 0 ? parsed.pathname : `${parsed.pathname}?${query}`,
      route,
    });
  } catch {
    return undefined;
  }
}

function hasSession(request: UiSecurityRequest, session: ActiveSession | undefined): boolean {
  const candidate = cookieValue(request.headers);
  return candidate !== undefined && session !== undefined
    ? secureEqual(candidate, session.sessionDigest)
    : false;
}

export function createUiSecurityPolicy(
  options: CreateUiSecurityPolicyOptions = {},
): UiSecurityPolicy {
  const routes = validatedRoutes(options.routes);
  let bearerConsumed = false;
  let activeSession: ActiveSession | undefined;
  const trustedIssuanceResponses = new WeakSet<object>();
  const trustedSecuredResponses = new WeakSet<object>();

  const issuanceResponse = (headers: Readonly<Record<string, string>>): UiResponse => {
    const result = responseWithHeaders(204, headers);
    trustedIssuanceResponses.add(result);
    return result;
  };

  const authenticateSession = (request: UiSecurityRequest): UiSecurityDecision | undefined => {
    if (!hasSession(request, activeSession)) {
      return respond(response(401, "Unauthorized\n"));
    }
    return undefined;
  };

  const authorize = (request: UiSecurityRequest): UiSecurityDecision => {
    if (
      activeSession !== undefined &&
      (untrustedInputIsUnsafe(request.url, [activeSession.sessionToken]) ||
        untrustedInputIsUnsafe(request.url, [activeSession.csrfToken]))
    ) {
      return respond(response(400, "Bad Request\n"));
    }
    const target = parseRequestTarget(request.url, routes);
    if (target === undefined) return respond(response(400, "Bad Request\n"));
    const { path } = target;

    if (
      path === "/" &&
      request.url === path &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return respond(
        responseWithHeaders(200, { "content-type": "text/html; charset=utf-8" }, bootstrapShell),
      );
    }
    if (
      path === "/__bootstrap.js" &&
      (request.method === "GET" || request.method === "HEAD") &&
      request.url === path
    ) {
      return respond(
        responseWithHeaders(
          200,
          { "content-type": "text/javascript; charset=utf-8" },
          bootstrapScript,
        ),
      );
    }

    if (path === "/__session/exchange") {
      if (request.url !== path) return respond(response(400, "Bad Request\n"));
      if (request.method !== "POST") return respond(response(405, "Method Not Allowed\n"));
      if (!request.bearerAuthenticated || bearerConsumed) {
        return respond(response(401, "Unauthorized\n"));
      }
      bearerConsumed = true;
      try {
        const sessionToken = randomBytes(tokenBytes).toString("base64url");
        const csrfToken = randomBytes(tokenBytes).toString("base64url");
        if (sessionToken === csrfToken) throw new Error("non-independent tokens");
        activeSession = Object.freeze({
          sessionToken,
          sessionDigest: digest(sessionToken),
          csrfToken,
          csrfDigest: digest(csrfToken),
        });
        return respond(
          issuanceResponse({
            "set-cookie": `${sessionCookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
            [csrfHeaderName]: csrfToken,
          }),
          true,
        );
      } catch {
        activeSession = undefined;
        return respond(response(500, "Internal Server Error\n"));
      }
    }

    if (path === "/__session/csrf") {
      if (request.url !== path) return respond(response(400, "Bad Request\n"));
      if (!readMethods.has(request.method)) return respond(response(405, "Method Not Allowed\n"));
      const denied = authenticateSession(request);
      if (denied !== undefined) return denied;
      const session = activeSession;
      if (session === undefined) return respond(response(401, "Unauthorized\n"));
      return respond(issuanceResponse({ [csrfHeaderName]: session.csrfToken }), true);
    }

    if (readMethods.has(request.method)) {
      const denied = authenticateSession(request);
      if (denied !== undefined) return denied;
      if (target.route === undefined) return respond(response(404, "Not Found\n"));
      if (!target.route.allowedMethods.includes(request.method as UiSecurityRouteMethod)) {
        return respond(
          responseWithHeaders(
            405,
            { allow: target.route.allowedMethods.join(", ") },
            "Method Not Allowed\n",
          ),
        );
      }
      return allowSession(target.handlerUrl, target.route.response, undefined);
    }
    const denied = authenticateSession(request);
    if (denied !== undefined) return denied;
    if (target.route === undefined) return respond(response(404, "Not Found\n"));
    if (!target.route.allowedMethods.includes(request.method as UiSecurityRouteMethod)) {
      return respond(
        responseWithHeaders(
          405,
          { allow: target.route.allowedMethods.join(", ") },
          "Method Not Allowed\n",
        ),
      );
    }

    if (singleHeader(request.headers, "origin") !== request.serverOrigin) {
      return respond(response(403, "Forbidden\n"));
    }
    const csrfCandidate = singleHeader(request.headers, csrfHeaderName);
    if (
      csrfCandidate === undefined ||
      activeSession === undefined ||
      !secureEqual(csrfCandidate, activeSession.csrfDigest)
    ) {
      return respond(response(403, "Forbidden\n"));
    }
    return allowSession(target.handlerUrl, target.route.response, target.route.mutationBody);
  };

  const secureResponse = (source: UiResponse): UiResponse => {
    const trustedIssuance = trustedIssuanceResponses.has(source);
    const applicationHeaders = Object.fromEntries(
      Object.entries(source.headers ?? {}).filter(
        ([name]) =>
          trustedIssuance ||
          (name.toLowerCase() !== "set-cookie" && name.toLowerCase() !== csrfHeaderName),
      ),
    );
    const secured = Object.freeze({
      statusCode: source.statusCode,
      headers: Object.freeze({ ...applicationHeaders, ...securityHeaders }),
      ...(source.body === undefined ? {} : { body: source.body }),
    });
    if (trustedIssuance) trustedSecuredResponses.add(secured);
    return secured;
  };

  const responseContainsSensitiveData = (source: UiResponse): boolean => {
    if (activeSession === undefined) return false;
    const trustedIssuance = trustedSecuredResponses.has(source);
    const expectedCookie = `${sessionCookieName}=${activeSession.sessionToken}; HttpOnly; SameSite=Strict; Path=/`;
    const filteredHeaders = Object.fromEntries(
      Object.entries(source.headers ?? {}).filter(([name, value]) => {
        if (trustedIssuance && name === "set-cookie" && value === expectedCookie) {
          return false;
        }
        if (trustedIssuance && name === csrfHeaderName && value === activeSession?.csrfToken) {
          return false;
        }
        return true;
      }),
    );
    const filtered = Object.freeze({
      statusCode: source.statusCode,
      headers: filteredHeaders,
      ...(source.body === undefined ? {} : { body: source.body }),
    });
    return responseLeaksCredentials(filtered, [
      activeSession.sessionToken,
      activeSession.csrfToken,
    ]);
  };

  const handlerResponseIsAllowed = (
    contract: UiHandlerResponseContract,
    source: UiResponse,
  ): boolean => contract === "standard" || isSecretSafeJsonResponse(source);

  const invalidate = (): void => {
    bearerConsumed = true;
    activeSession = undefined;
  };

  return Object.freeze({
    authorize,
    secureResponse,
    handlerResponseIsAllowed,
    responseContainsSensitiveData,
    invalidate,
  });
}
