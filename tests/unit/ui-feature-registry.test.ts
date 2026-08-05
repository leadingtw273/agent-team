import { describe, expect, it } from "vitest";

import {
  createUiApplication,
  type UiFeatureRegistration,
  type UiFeatureRoute,
} from "../../src/ui/index.js";
import * as publicUi from "../../src/ui/index.js";

function textRoute(path: string): UiFeatureRoute {
  return Object.freeze({
    contract: Object.freeze({
      path,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: Object.freeze(["GET"] as const),
      response: "standard",
    }),
    handler: () =>
      Object.freeze({
        statusCode: 200,
        headers: Object.freeze({ "content-type": "text/plain; charset=utf-8" }),
        body: "asset",
      }),
  });
}

function feature(overrides: Partial<UiFeatureRegistration> = {}): UiFeatureRegistration {
  return Object.freeze({
    id: "test-feature",
    slot: "quota",
    page: Object.freeze({
      path: "/quota",
      title: "額度",
      description: "額度頁",
      styles: Object.freeze(["/assets/quota.css"]),
      scripts: Object.freeze(["/assets/quota.js"]),
      render: () => "<section data-test-feature>feature content</section>",
    }),
    routes: Object.freeze([
      textRoute("/assets/quota.css"),
      textRoute("/assets/quota.js"),
      Object.freeze({
        contract: Object.freeze({
          path: "/api/quota",
          allowedQueryParameters: Object.freeze([]),
          allowedMethods: Object.freeze(["GET", "PUT"] as const),
          response: "standard" as const,
          mutationBody: "bounded-json" as const,
        }),
        handler: () => Object.freeze({ statusCode: 200, body: "{}" }),
      }),
    ]),
    ...overrides,
  });
}

describe("shared UI feature registry", () => {
  it("does not expose the unvalidated shell assembler or core route map", () => {
    expect(publicUi).not.toHaveProperty("createUiShellRequestHandler");
    expect(publicUi).not.toHaveProperty("uiShellCoreRouteContracts");
    expect(publicUi).toHaveProperty("createUiApplication");
    expect(publicUi).toHaveProperty("createUiShellHandler");
  });

  it("composes core, page, asset, and API contracts through one application factory", () => {
    const application = createUiApplication({ features: [feature()] });

    expect(application.routeContracts.map((route) => route.path)).toEqual([
      "/",
      "/projects",
      "/events",
      "/assets/icons.svg",
      "/assets/tabler-1.4.0.min.css",
      "/assets/ui-shell.css",
      "/quota",
      "/assets/quota.css",
      "/assets/quota.js",
      "/api/quota",
    ]);
    expect(application.handler).toEqual(expect.any(Function));
    expect(typeof application.securityPolicy.authorize).toBe("function");
  });

  it("keeps document chrome in the shell and escapes feature metadata", async () => {
    const application = createUiApplication({
      features: [
        feature({
          page: {
            ...feature().page,
            title: "額度<script>bad()</script>",
            description: '<img src=x onerror="bad()">',
          },
        }),
      ],
    });

    const result = await application.handler(
      {
        method: "GET",
        url: "/quota",
        headers: Object.freeze({}),
        auth: Object.freeze({ kind: "session" }),
      },
      {},
    );
    const body = String(result.body);

    expect(body.match(/<html\b/gu)).toHaveLength(1);
    expect(body.match(/class="ui-brand"/gu)).toHaveLength(1);
    expect(body.match(/href="#main-content"/gu)).toHaveLength(1);
    expect(body).toContain("額度&lt;script&gt;bad()&lt;/script&gt;");
    expect(body).toContain("&lt;img src=x onerror=&quot;bad()&quot;&gt;");
    expect(body).toContain("<section data-test-feature>feature content</section>");
  });

  it("snapshots declarations so handler and security contracts cannot drift later", async () => {
    const base = feature();
    const declaration: UiFeatureRegistration = {
      ...base,
      page: { ...base.page },
      routes: base.routes.map((route) => ({
        contract: { ...route.contract },
        handler: route.handler,
      })),
    };
    const application = createUiApplication({ features: [declaration] });
    const mutablePage = declaration.page as { path: string };
    const mutableContract = declaration.routes[0]?.contract as { path: string };

    mutablePage.path = "/changed-after-composition";
    mutableContract.path = "/assets/changed-after-composition.css";

    expect(application.routeContracts.map((route) => route.path)).toContain("/quota");
    expect(application.routeContracts.map((route) => route.path)).toContain("/assets/quota.css");
    const response = await application.handler(
      {
        method: "GET",
        url: "/quota",
        headers: Object.freeze({}),
        auth: Object.freeze({ kind: "session" }),
      },
      {},
    );
    expect(response.statusCode).toBe(200);
  });

  it("fails fast on duplicate slots", () => {
    expect(() =>
      createUiApplication({
        features: [
          feature(),
          feature({ id: "other", page: { ...feature().page, path: "/other" } }),
        ],
      }),
    ).toThrow(/duplicate UI feature slot/iu);
  });

  it("fails fast on duplicate page paths", () => {
    expect(() =>
      createUiApplication({
        features: [feature(), feature({ id: "other", slot: "security" })],
      }),
    ).toThrow(/duplicate UI page path/iu);
  });

  it("fails fast when a feature copies a core page or route", () => {
    expect(() =>
      createUiApplication({
        features: [feature({ page: { ...feature().page, path: "/projects" } })],
      }),
    ).toThrow(/core UI route/iu);

    expect(() =>
      createUiApplication({
        features: [feature({ routes: [textRoute("/assets/ui-shell.css")] })],
      }),
    ).toThrow(/core UI route/iu);
  });

  it("fails fast on duplicate feature route paths", () => {
    expect(() =>
      createUiApplication({
        features: [
          feature({
            routes: [textRoute("/assets/quota.css"), textRoute("/assets/quota.css")],
          }),
        ],
      }),
    ).toThrow(/duplicate UI route path/iu);
  });

  it.each([
    ["style", { styles: ["/assets/missing.css"], scripts: [] }],
    ["script", { styles: [], scripts: ["/assets/missing.js"] }],
  ] as const)("fails fast when a page %s lacks an owned GET route", (_kind, assets) => {
    expect(() =>
      createUiApplication({
        features: [feature({ page: { ...feature().page, ...assets } })],
      }),
    ).toThrow(/page asset.*GET route/iu);
  });

  it("fails fast instead of loading the same page asset twice", () => {
    expect(() =>
      createUiApplication({
        features: [
          feature({
            page: {
              ...feature().page,
              styles: ["/assets/quota.css", "/assets/quota.css"],
            },
          }),
        ],
      }),
    ).toThrow(/duplicate UI page asset/iu);
  });
});
