import {
  createUiShellRequestHandler,
  fixtureUiShellReadModel,
  uiShellCoreRouteContracts,
  type UiShellReadModel,
} from "../shell/index.js";
import { createUiSecurityPolicy, type UiSecurityRouteContract } from "../security/index.js";
import type { UiRequestHandler, UiSecurityPolicy } from "../server/index.js";
import {
  isUiFeatureRegistrationProvider,
  type UiFeatureRegistration,
  type UiFeatureSource,
} from "./contracts.js";

export * from "./contracts.js";

export interface CreateUiApplicationOptions {
  readonly readModel?: UiShellReadModel;
  readonly features?: readonly UiFeatureSource[];
}

export interface UiApplication {
  readonly handler: UiRequestHandler;
  readonly securityPolicy: UiSecurityPolicy;
  readonly routeContracts: readonly UiSecurityRouteContract[];
}

const coreRoutePaths = new Set(uiShellCoreRouteContracts.map((route) => route.path));

function registration(source: UiFeatureSource): UiFeatureRegistration {
  const feature = isUiFeatureRegistrationProvider(source) ? source.uiFeatureRegistration() : source;
  return Object.freeze({
    id: feature.id,
    slot: feature.slot,
    page: Object.freeze({
      path: feature.page.path,
      title: feature.page.title,
      description: feature.page.description,
      ...(feature.page.styles === undefined
        ? {}
        : { styles: Object.freeze([...feature.page.styles]) }),
      ...(feature.page.scripts === undefined
        ? {}
        : { scripts: Object.freeze([...feature.page.scripts]) }),
      render: feature.page.render,
    }),
    routes: Object.freeze(
      feature.routes.map((route) =>
        Object.freeze({
          contract: Object.freeze({
            ...route.contract,
            allowedQueryParameters: Object.freeze([...route.contract.allowedQueryParameters]),
            ...(route.contract.allowedMethods === undefined
              ? {}
              : { allowedMethods: Object.freeze([...route.contract.allowedMethods]) }),
          }),
          handler: route.handler,
        }),
      ),
    ),
  });
}

function pageRoute(pagePath: string): UiSecurityRouteContract {
  return Object.freeze({
    path: pagePath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: Object.freeze(["GET"] as const),
    response: "standard",
  });
}

function validateFeatures(sources: readonly UiFeatureSource[]): readonly UiFeatureRegistration[] {
  const features = sources.map(registration);
  const ids = new Set<string>();
  const slots = new Set<string>();
  const pagePaths = new Set<string>();
  const routePaths = new Set<string>();

  for (const feature of features) {
    if (feature.id.length === 0 || ids.has(feature.id)) {
      throw new TypeError("Invalid or duplicate UI feature id.");
    }
    ids.add(feature.id);
    if (slots.has(feature.slot)) throw new TypeError("Duplicate UI feature slot.");
    slots.add(feature.slot);

    if (pagePaths.has(feature.page.path)) throw new TypeError("Duplicate UI page path.");
    pagePaths.add(feature.page.path);
    if (coreRoutePaths.has(feature.page.path)) {
      throw new TypeError("A feature cannot copy a core UI route.");
    }

    const ownedRoutes = new Map<string, UiSecurityRouteContract>();
    for (const route of feature.routes) {
      const path = route.contract.path;
      if (coreRoutePaths.has(path)) throw new TypeError("A feature cannot copy a core UI route.");
      if (path === feature.page.path || routePaths.has(path)) {
        throw new TypeError("Duplicate UI route path.");
      }
      routePaths.add(path);
      ownedRoutes.set(path, route.contract);
    }

    const assets = [...(feature.page.styles ?? []), ...(feature.page.scripts ?? [])];
    if (new Set(assets).size !== assets.length) throw new TypeError("Duplicate UI page asset.");
    for (const assetPath of assets) {
      const contract = ownedRoutes.get(assetPath);
      if (contract === undefined || contract.allowedMethods?.includes("GET") !== true) {
        throw new TypeError("Every UI page asset requires an owned GET route.");
      }
    }
  }

  for (const pagePath of pagePaths) {
    if (routePaths.has(pagePath)) throw new TypeError("Duplicate UI route path.");
  }
  return Object.freeze([...features]);
}

/** The only composition point for shell routes, feature routes, handlers, and security policy. */
export function createUiApplication(options: CreateUiApplicationOptions = {}): UiApplication {
  const features = validateFeatures(options.features ?? Object.freeze([]));
  const routeContracts = Object.freeze([
    ...uiShellCoreRouteContracts,
    ...features.flatMap((feature) => [
      pageRoute(feature.page.path),
      ...feature.routes.map((route) => route.contract),
    ]),
  ]);
  return Object.freeze({
    handler: createUiShellRequestHandler(options.readModel ?? fixtureUiShellReadModel, features),
    securityPolicy: createUiSecurityPolicy({ routes: routeContracts }),
    routeContracts,
  });
}

/** Compatibility adapter; new composition should retain the paired policy from createUiApplication. */
export function createUiShellHandler(
  readModel: UiShellReadModel = fixtureUiShellReadModel,
  feature?: UiFeatureSource,
): UiRequestHandler {
  return createUiApplication({
    readModel,
    ...(feature === undefined ? {} : { features: [feature] }),
  }).handler;
}
