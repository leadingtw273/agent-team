import { readFileSync } from "node:fs";

import type {
  UiFeatureRegistration,
  UiFeatureRoute,
  UiFeatureSlot,
} from "../registry/contracts.js";
import type {
  UiRequest,
  UiRequestHandler,
  UiResponse,
  UiTrustedRequestContext,
} from "../server/index.js";
import type { UiSecurityRouteContract } from "../security/index.js";

const tablerCoreVersion = "1.4.0";
const tablerCoreCdnUrl = "https://cdn.jsdelivr.net/npm/@tabler/core@1.4.0/dist/css/tabler.min.css";
const tablerCoreSri = "sha384-kz+I4+mczbNiZfLAJMxOlJaZmnbRYhARHNkR2k6tal4gz7OL33/0puDD3SvkiNX9";

export type UiDataSource = "fixture" | "runtime";
export type UiTeamState = "idle" | "running" | "attention";
export type UiProjectStatus = "active" | "ready" | "attention";
export type UiEventLevel = "info" | "warning" | "error";
export type UiRuntimeState = "completed" | "degraded" | "unavailable";

export interface UiOverviewSummary {
  readonly source: UiDataSource;
  readonly teamState: UiTeamState;
  readonly activeJobCount: number | null;
  readonly registeredProjectCount: number | null;
  readonly recentEventCount: number | null;
  /** Present only for the production, T05-backed shell. */
  readonly runtimeState?: UiRuntimeState;
  readonly projectCount?: number | null;
  readonly nonTerminalWorkCount?: number | null;
}

export interface UiProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly repository?: string;
  readonly status?: UiProjectStatus;
  readonly activeJobCount?: number | null;
  readonly updatedAt?: string;
  /** Present only for the production, T05-backed shell. */
  readonly registrationState?: "registered" | "configuration_incomplete" | "unknown";
  readonly registrationReason?: string;
  readonly nonTerminalCount?: number | null;
  readonly activeLeaseCount?: number | null;
}

export interface UiEventSummary {
  readonly id: string;
  readonly occurredAt: string;
  readonly level: UiEventLevel;
  readonly category: string;
  readonly summary: string;
}

/**
 * The UI can only ask for deliberately small, read-only DTOs. Implementations must never
 * return secrets, tokens, raw command output, or mutable runtime handles.
 */
export interface UiShellReadModel {
  /** Refreshes the small server-owned DTO cache before one HTML document is rendered. */
  readonly refresh?: () => Promise<void>;
  readonly readOverview: () => UiOverviewSummary;
  readonly listProjects: () => readonly UiProjectSummary[];
  readonly listEvents: () => readonly UiEventSummary[];
}

interface NavigationItem {
  readonly label: string;
  readonly href?: "/" | "/projects" | "/events";
  readonly slot?: UiFeatureSlot;
  readonly icon:
    "overview" | "projects" | "running" | "roles" | "quota" | "security" | "events" | "settings";
}

interface PageDefinition {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly render: (
    readModel: UiShellReadModel,
    trustedContext: UiTrustedRequestContext,
  ) => string | Promise<string>;
  readonly styles?: readonly string[];
  readonly scripts?: readonly string[];
}

interface StaticAsset {
  readonly content: string;
  readonly contentType:
    "image/svg+xml; charset=utf-8" | "text/css; charset=utf-8" | "text/javascript; charset=utf-8";
}

const navigation: readonly NavigationItem[] = Object.freeze([
  Object.freeze({ label: "總覽", href: "/", icon: "overview" }),
  Object.freeze({ label: "專案", href: "/projects", icon: "projects" }),
  Object.freeze({ label: "註冊精靈", slot: "registration", icon: "settings" }),
  Object.freeze({ label: "執行中", slot: "running", icon: "running" }),
  Object.freeze({ label: "角色與模型", slot: "role-models", icon: "roles" }),
  Object.freeze({ label: "額度", slot: "quota", icon: "quota" }),
  Object.freeze({ label: "安全", slot: "security", icon: "security" }),
  Object.freeze({ label: "事件", href: "/events", icon: "events" }),
  Object.freeze({ label: "設定", slot: "settings", icon: "settings" }),
]);

const productionNavigation: readonly NavigationItem[] = Object.freeze([
  Object.freeze({ label: "總覽", href: "/", icon: "overview" }),
  Object.freeze({ label: "專案", href: "/projects", icon: "projects" }),
  Object.freeze({ label: "事件", href: "/events", icon: "events" }),
]);

const assets: Readonly<
  Record<"/assets/icons.svg" | "/assets/tabler-1.4.0.min.css" | "/assets/ui-shell.css", StaticAsset>
> = Object.freeze({
  "/assets/icons.svg": Object.freeze({
    content: readFileSync(new URL("../assets/icons.svg", import.meta.url), "utf8"),
    contentType: "image/svg+xml; charset=utf-8",
  }),
  "/assets/tabler-1.4.0.min.css": Object.freeze({
    content: readFileSync(new URL("../assets/tabler-1.4.0.min.css", import.meta.url), "utf8"),
    contentType: "text/css; charset=utf-8",
  }),
  "/assets/ui-shell.css": Object.freeze({
    content: readFileSync(new URL("../assets/ui-shell.css", import.meta.url), "utf8"),
    contentType: "text/css; charset=utf-8",
  }),
});

const readMethods = Object.freeze(["GET"] as const);

export const uiShellCoreRouteContracts: readonly UiSecurityRouteContract[] = Object.freeze([
  ...["/", "/projects", "/events"].map((path) =>
    Object.freeze({
      path,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readMethods,
      response: "standard" as const,
    }),
  ),
  ...Object.keys(assets).map((path) =>
    Object.freeze({
      path,
      allowedQueryParameters: Object.freeze([]),
      allowedMethods: readMethods,
      response: "standard" as const,
    }),
  ),
]);

export const fixtureUiShellReadModel: UiShellReadModel = Object.freeze({
  readOverview: () =>
    Object.freeze({
      source: "fixture",
      teamState: "idle",
      activeJobCount: 0,
      registeredProjectCount: 2,
      recentEventCount: 2,
    }),
  listProjects: () =>
    Object.freeze([
      Object.freeze({
        id: "demo-project-alpha",
        name: "Alpha 產品探索",
        repository: "local/alpha-product",
        status: "active",
        activeJobCount: 1,
        updatedAt: "今天 10:24",
      }),
      Object.freeze({
        id: "demo-project-beta",
        name: "Beta 品質追蹤",
        repository: "local/beta-quality",
        status: "ready",
        activeJobCount: 0,
        updatedAt: "昨天 16:40",
      }),
    ]),
  listEvents: () =>
    Object.freeze([
      Object.freeze({
        id: "demo-event-001",
        occurredAt: "今天 10:24",
        level: "info",
        category: "UI Shell",
        summary: "已載入有限示範資料。",
      }),
      Object.freeze({
        id: "demo-event-002",
        occurredAt: "昨天 16:40",
        level: "info",
        category: "專案",
        summary: "等待 Runtime read model 在後續階段接入。",
      }),
    ]),
});

const pageDefinitions: readonly PageDefinition[] = Object.freeze([
  Object.freeze({
    path: "/",
    title: "總覽",
    description: "在同一處查看 Agent Team 的可讀狀態與下一步。",
    render: renderOverview,
  }),
  Object.freeze({
    path: "/projects",
    title: "專案",
    description: "僅讀取已註冊專案的摘要；此頁不會變更專案設定。",
    render: renderProjects,
  }),
  Object.freeze({
    path: "/events",
    title: "事件",
    description: "查看經過摘要化的近期事件，不顯示 Token、Secret 或完整命令輸出。",
    render: renderEvents,
  }),
]);

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return character;
    }
  });
}

function displayCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : "—";
}

function displayRuntimeCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : "未取得／—";
}

function icon(name: string, className = "ui-inline-icon"): string {
  return `<svg class="${className}" aria-hidden="true" focusable="false"><use href="/assets/icons.svg#icon-${name}"></use></svg>`;
}

function sourceNotice(source: UiDataSource): string {
  if (source !== "fixture") return "";
  return `<aside class="ui-fixture-notice" aria-label="資料來源說明">${icon("info")}<span>UI Shell 示範資料，尚未連接 Runtime。 </span></aside>`;
}

function statusBadge(
  variant: "active" | "attention" | "error" | "idle" | "info" | "success" | "warning",
  label: string,
): string {
  return `<span class="badge ui-status-badge ui-status--${variant}"><span class="ui-status-dot" aria-hidden="true"></span><span class="ui-status-label">${escapeHtml(label)}</span></span>`;
}

function teamStateBadge(state: UiTeamState): string {
  switch (state) {
    case "running":
      return statusBadge("active", "工作中");
    case "attention":
      return statusBadge("attention", "需要注意");
    case "idle":
      return statusBadge("idle", "待命中");
  }
}

function projectStatusBadge(status: UiProjectStatus): string {
  switch (status) {
    case "active":
      return statusBadge("active", "執行中");
    case "attention":
      return statusBadge("attention", "需要注意");
    case "ready":
      return statusBadge("success", "已就緒");
  }
}

function runtimeStateBadge(state: UiRuntimeState | undefined): string {
  switch (state) {
    case "completed":
      return statusBadge("success", "已完成（completed）");
    case "degraded":
      return statusBadge("attention", "降級（degraded）");
    case "unavailable":
    case undefined:
      return statusBadge("warning", "未取得");
  }
}

function registrationStateBadge(state: UiProjectSummary["registrationState"]): string {
  switch (state) {
    case "registered":
      return statusBadge("success", "已註冊");
    case "configuration_incomplete":
      return statusBadge("attention", "設定未完成");
    case "unknown":
    case undefined:
      return statusBadge("warning", "未取得");
  }
}

function registrationReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "trusted_config_verified":
      return "可信設定已驗證";
    case "registration_draft_conflict":
      return "註冊草稿衝突";
    case "trusted_config_missing":
      return "可信設定缺失";
    case "trusted_config_invalid":
      return "可信設定無效";
    case "trusted_config_mismatch":
      return "可信設定不一致";
    case "activation_missing":
      return "啟用紀錄缺失";
    case "activation_invalid":
      return "啟用紀錄無效";
    case "trusted_config_unavailable":
      return "可信設定未取得";
    case "activation_unavailable":
      return "啟用紀錄未取得";
    default:
      return "未取得";
  }
}

function eventLevelBadge(level: UiEventLevel): string {
  switch (level) {
    case "error":
      return statusBadge("error", "錯誤");
    case "warning":
      return statusBadge("warning", "提醒");
    case "info":
      return statusBadge("info", "資訊");
  }
}

function emptyState(title: string, description: string): string {
  return `<div class="ui-empty-state">${icon("empty")}<h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>`;
}

function renderRuntimeOverview(
  overview: UiOverviewSummary,
  projects: readonly UiProjectSummary[],
): string {
  const projectCount = displayRuntimeCount(overview.projectCount);
  const registeredCount = displayRuntimeCount(overview.registeredProjectCount);
  const nonTerminalWorkCount = displayRuntimeCount(overview.nonTerminalWorkCount);
  const previewProjects = projects.slice(0, 3);

  return `<section class="ui-stat-grid ui-stat-grid--production" aria-label="T05 專案總覽">
      <article class="card ui-stat-card"><div class="card-body"><div class="ui-stat-label">整體狀態</div><div class="mt-2">${runtimeStateBadge(overview.runtimeState)}</div></div></article>
      <article class="card ui-stat-card"><div class="card-body"><div class="ui-stat-label">專案數</div><div class="ui-stat-value">${projectCount}</div></div></article>
      <article class="card ui-stat-card"><div class="card-body"><div class="ui-stat-label">已註冊數</div><div class="ui-stat-value">${registeredCount}</div></div></article>
      <article class="card ui-stat-card"><div class="card-body"><div class="ui-stat-label">非終態工作數</div><div class="ui-stat-value">${nonTerminalWorkCount}</div></div></article>
    </section>
    <section class="card ui-panel" aria-labelledby="runtime-projects-title">
      <div class="card-body">
        <div class="ui-section-heading"><div><h2 id="runtime-projects-title">專案摘要</h2><p>資料直接來自 T05 唯讀專案投影。</p></div><a class="btn btn-outline-primary btn-sm" href="/projects">查看全部專案</a></div>
        ${
          previewProjects.length === 0
            ? emptyState(
                overview.projectCount === null ? "專案資料未取得" : "尚無可讀取專案",
                "此頁不會推測遺失資料，也不會變更任何設定。",
              )
            : `<ul class="ui-list">${previewProjects
                .map(
                  (project) =>
                    `<li class="ui-list-item"><div><div class="ui-item-title">${escapeHtml(project.name)}</div><div class="ui-item-meta">${escapeHtml(registrationReasonLabel(project.registrationReason))} · 非終態 ${displayRuntimeCount(project.nonTerminalCount)} · 活躍租約 ${displayRuntimeCount(project.activeLeaseCount)}</div></div>${registrationStateBadge(project.registrationState)}</li>`,
                )
                .join("")}</ul>`
        }
      </div>
    </section>`;
}

function renderRuntimeProjects(
  overview: UiOverviewSummary,
  projects: readonly UiProjectSummary[],
): string {
  return `<section class="card ui-panel" aria-labelledby="projects-table-title">
      <div class="card-body">
        <div class="ui-section-heading"><div><h2 id="projects-table-title">專案</h2><p>共 ${displayRuntimeCount(overview.projectCount)} 個唯讀摘要</p></div></div>
        ${
          projects.length === 0
            ? emptyState(
                overview.projectCount === null ? "專案資料未取得" : "尚無可讀取專案",
                "此頁不會推測遺失資料，也不會變更任何設定。",
              )
            : `<div class="ui-table-wrap" role="region" aria-labelledby="projects-table-title" tabindex="0"><table class="table table-vcenter ui-table ui-table--production-projects"><thead><tr><th scope="col">名稱</th><th scope="col">註冊狀態／原因</th><th scope="col">非終態工作</th><th scope="col">活躍租約</th></tr></thead><tbody>${projects
                .map(
                  (project) =>
                    `<tr><th scope="row"><span class="ui-mobile-cell-label" aria-hidden="true">名稱</span><div class="ui-mobile-cell-value"><span class="ui-item-title">${escapeHtml(project.name)}</span></div></th><td><span class="ui-mobile-cell-label" aria-hidden="true">註冊狀態／原因</span><div class="ui-mobile-cell-value">${registrationStateBadge(project.registrationState)}<div class="ui-item-meta">${escapeHtml(registrationReasonLabel(project.registrationReason))}</div></div></td><td><span class="ui-mobile-cell-label" aria-hidden="true">非終態工作</span><div class="ui-mobile-cell-value">${displayRuntimeCount(project.nonTerminalCount)}</div></td><td><span class="ui-mobile-cell-label" aria-hidden="true">活躍租約</span><div class="ui-mobile-cell-value">${displayRuntimeCount(project.activeLeaseCount)}</div></td></tr>`,
                )
                .join("")}</tbody></table></div>`
        }
      </div>
    </section>`;
}

function renderRuntimeEvents(): string {
  return `<section class="card ui-panel" aria-labelledby="events-unavailable-title">
      <div class="card-body">
        <div class="ui-section-heading"><div><h2 id="events-unavailable-title">事件</h2><p>事件資料尚未提供給 production UI。</p></div></div>
        ${emptyState("T06 尚未接入事件來源", "因此不會以 0 筆事件冒充目前狀態。")}
      </div>
    </section>`;
}

function renderOverview(readModel: UiShellReadModel): string {
  const overview = readModel.readOverview();
  if (overview.source === "runtime") {
    return renderRuntimeOverview(overview, readModel.listProjects());
  }
  const projects = readModel.listProjects();
  const events = readModel.listEvents();
  const previewProjects = projects.slice(0, 3);
  const previewEvents = events.slice(0, 3);
  const activeJobs = displayCount(overview.activeJobCount);

  return `${sourceNotice(overview.source)}
    <section class="ui-stat-grid" aria-label="目前摘要">
      <article class="card ui-stat-card"><div class="card-body"><div class="ui-stat-label">團隊狀態</div><div class="mt-2">${teamStateBadge(overview.teamState)}</div></div></article>
      <article class="card ui-stat-card"><div class="card-body"><div class="ui-stat-label">執行中的工作</div><div class="ui-stat-value">${activeJobs}</div></div></article>
      <article class="card ui-stat-card"><div class="card-body"><div class="ui-stat-label">已註冊專案</div><div class="ui-stat-value">${displayCount(overview.registeredProjectCount)}</div></div></article>
    </section>
    <section class="card ui-panel mb-3" aria-labelledby="overview-work-title">
      <div class="card-body">
        <div class="ui-section-heading"><div><h2 id="overview-work-title">執行中</h2><p>目前的工作摘要</p></div></div>
        ${
          activeJobs === "0"
            ? emptyState("目前沒有執行中的工作", "新的工作開始後，會在這裡顯示摘要。")
            : `<p class="mb-0">目前有 ${activeJobs} 項工作正在執行；完整工作列表將在後續階段提供。</p>`
        }
      </div>
    </section>
    <section class="card ui-panel mb-3" aria-labelledby="overview-projects-title">
      <div class="card-body">
        <div class="ui-section-heading"><div><h2 id="overview-projects-title">專案摘要</h2><p>有限資料預覽</p></div><a class="btn btn-outline-primary btn-sm" href="/projects">查看全部專案</a></div>
        ${
          previewProjects.length === 0
            ? emptyState("尚無已註冊專案", "完成註冊後，專案摘要會顯示在這裡。")
            : `<ul class="ui-list">${previewProjects
                .map(
                  (project) =>
                    `<li class="ui-list-item"><div><div class="ui-item-title">${escapeHtml(project.name)}</div><div class="ui-item-meta">${escapeHtml(project.repository ?? "—")} · ${displayCount(project.activeJobCount)} 項工作</div></div>${projectStatusBadge(project.status ?? "attention")}</li>`,
                )
                .join("")}</ul>`
        }
      </div>
    </section>
    <section class="card ui-panel" aria-labelledby="overview-events-title">
      <div class="card-body">
        <div class="ui-section-heading"><div><h2 id="overview-events-title">近期事件</h2><p>${displayCount(overview.recentEventCount)} 筆可讀取摘要</p></div><a class="btn btn-outline-primary btn-sm" href="/events">查看全部事件</a></div>
        ${
          previewEvents.length === 0
            ? emptyState("尚無事件紀錄", "新事件抵達後，這裡會顯示經摘要化的內容。")
            : `<ul class="ui-list">${previewEvents
                .map(
                  (event) =>
                    `<li class="ui-list-item"><div><div class="ui-item-title">${escapeHtml(event.summary)}</div><div class="ui-item-meta">${escapeHtml(event.occurredAt)} · ${escapeHtml(event.category)}</div></div>${eventLevelBadge(event.level)}</li>`,
                )
                .join("")}</ul>`
        }
      </div>
    </section>`;
}

function renderProjects(readModel: UiShellReadModel): string {
  const overview = readModel.readOverview();
  const projects = readModel.listProjects();
  if (overview.source === "runtime") return renderRuntimeProjects(overview, projects);

  return `${sourceNotice(overview.source)}
    <section class="card ui-panel" aria-labelledby="projects-table-title">
      <div class="card-body">
        <div class="ui-section-heading"><div><h2 id="projects-table-title">已註冊專案</h2><p>共 ${displayCount(overview.registeredProjectCount)} 個摘要</p></div></div>
        ${
          projects.length === 0
            ? emptyState("尚無已註冊專案", "此 Shell 保持唯讀；專案註冊流程會在後續階段加入。")
            : `<div class="ui-table-wrap"><table class="table table-vcenter ui-table ui-table--projects"><thead><tr><th scope="col">專案</th><th scope="col">儲存庫</th><th scope="col">狀態</th><th scope="col">工作</th><th scope="col">更新時間</th></tr></thead><tbody>${projects
                .map(
                  (project) =>
                    `<tr><th scope="row"><span class="ui-item-title">${escapeHtml(project.name)}</span></th><td>${escapeHtml(project.repository ?? "—")}</td><td>${projectStatusBadge(project.status ?? "attention")}</td><td>${displayCount(project.activeJobCount)}</td><td>${escapeHtml(project.updatedAt ?? "—")}</td></tr>`,
                )
                .join("")}</tbody></table></div>`
        }
      </div>
    </section>`;
}

function renderEvents(readModel: UiShellReadModel): string {
  const overview = readModel.readOverview();
  if (overview.source === "runtime") return renderRuntimeEvents();
  const events = readModel.listEvents();

  return `${sourceNotice(overview.source)}
    <section class="card ui-panel" aria-labelledby="events-table-title">
      <div class="card-body">
        <div class="ui-section-heading"><div><h2 id="events-table-title">近期事件</h2><p>共 ${displayCount(overview.recentEventCount)} 筆可讀取摘要</p></div></div>
        ${
          events.length === 0
            ? emptyState("尚無事件紀錄", "收到事件後，這裡只會顯示安全的摘要資訊。")
            : `<div class="ui-table-wrap"><table class="table table-vcenter ui-table ui-table--events"><thead><tr><th scope="col">時間</th><th scope="col">等級</th><th scope="col">類別</th><th scope="col">摘要</th></tr></thead><tbody>${events
                .map(
                  (event) =>
                    `<tr><td>${escapeHtml(event.occurredAt)}</td><td>${eventLevelBadge(event.level)}</td><td>${escapeHtml(event.category)}</td><td>${escapeHtml(event.summary)}</td></tr>`,
                )
                .join("")}</tbody></table></div>`
        }
      </div>
    </section>`;
}

function navigationHref(
  item: NavigationItem,
  slotPages: ReadonlyMap<UiFeatureSlot, string>,
): string | undefined {
  return item.slot === undefined ? item.href : slotPages.get(item.slot);
}

function renderNavigationItems(
  activePath: string,
  slotPages: ReadonlyMap<UiFeatureSlot, string>,
  items: readonly NavigationItem[],
): string {
  return items
    .map((item) => {
      const href = navigationHref(item, slotPages);
      const itemIcon = icon(item.icon, "ui-nav-icon");
      if (href === undefined) {
        return `<li class="nav-item"><span class="ui-nav-link ui-nav-link--future">${itemIcon}<span>${item.label}</span><span class="badge bg-secondary-lt text-secondary ms-auto">後續</span></span></li>`;
      }
      const current = href === activePath ? ' aria-current="page"' : "";
      return `<li class="nav-item"><a class="ui-nav-link" href="${href}"${current}>${itemIcon}<span>${item.label}</span></a></li>`;
    })
    .join("");
}

function renderNavigation(
  activePath: string,
  variant: "desktop" | "mobile",
  slotPages: ReadonlyMap<UiFeatureSlot, string>,
  items: readonly NavigationItem[],
): string {
  return `<nav class="ui-nav ui-nav--${variant}" aria-label="主要導覽"><p class="ui-nav-caption">管理介面</p><ul class="navbar-nav">${renderNavigationItems(activePath, slotPages, items)}</ul></nav>`;
}

function renderMobileNavigation(
  activePath: string,
  slotPages: ReadonlyMap<UiFeatureSlot, string>,
  items: readonly NavigationItem[],
): string {
  const activeItem = items.find((item) => navigationHref(item, slotPages) === activePath);
  if (activeItem === undefined) throw new Error("Active navigation item is missing.");
  return `<details class="ui-mobile-nav">
          <summary class="ui-mobile-nav-toggle">
            <span class="ui-mobile-current">${icon(activeItem.icon, "ui-nav-icon")}<span class="ui-mobile-current-label">目前頁面：<strong>${activeItem.label}</strong></span></span>
            <span class="ui-mobile-nav-action"><span class="ui-mobile-nav-open">開啟選單</span><span class="ui-mobile-nav-close">關閉選單</span><span class="ui-mobile-nav-chevron" aria-hidden="true"></span></span>
          </summary>
          ${renderNavigation(activePath, "mobile", slotPages, items)}
        </details>`;
}

async function renderPage(
  page: PageDefinition,
  readModel: UiShellReadModel,
  slotPages: ReadonlyMap<UiFeatureSlot, string>,
  trustedContext: UiTrustedRequestContext,
): Promise<string> {
  const overview = readModel.readOverview();
  const navigationItems = overview.source === "runtime" ? productionNavigation : navigation;
  const sidebarNote =
    overview.source === "runtime"
      ? "本機安全 UI · 唯讀狀態 · 無遠端 JavaScript"
      : slotPages.size > 0
        ? "本機安全 UI · 無遠端 JavaScript"
        : "唯讀 UI Shell · 無遠端 JavaScript";
  const pageAssets = [
    ...(page.styles ?? []).map((path) => `    <link rel="stylesheet" href="${escapeHtml(path)}">`),
    ...(page.scripts ?? []).map((path) => `    <script src="${escapeHtml(path)}" defer></script>`),
  ].join("\n");
  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(page.title)}｜Agent Team</title>
    <link rel="stylesheet" href="${tablerCoreCdnUrl}" integrity="${tablerCoreSri}" crossorigin="anonymous">
    <link rel="stylesheet" href="/assets/tabler-${tablerCoreVersion}.min.css">
    <link rel="stylesheet" href="/assets/ui-shell.css">
${pageAssets}
  </head>
  <body class="ui-shell">
    <a class="skip-link" href="#main-content">跳至主要內容</a>
    <div class="ui-app">
      <aside class="ui-sidebar" aria-label="Agent Team 導覽">
        <a class="ui-brand" href="/" aria-label="Agent Team 總覽">${icon("agent", "ui-inline-icon ui-brand-mark")}<span class="ui-brand-copy"><span class="ui-brand-title">Agent Team</span><span class="ui-brand-subtitle">Local control room</span></span></a>
        ${renderNavigation(page.path, "desktop", slotPages, navigationItems)}
        ${renderMobileNavigation(page.path, slotPages, navigationItems)}
        <div class="ui-sidebar-spacer"></div>
        <p class="ui-sidebar-note">${sidebarNote}<br>${overview.source === "runtime" ? "僅顯示已白名單的本機唯讀資料。" : "後續功能會依階段逐步啟用。"}</p>
      </aside>
      <main id="main-content" class="ui-content" tabindex="-1">
        <div class="ui-content-inner">
          <header class="ui-page-header"><div><p class="ui-page-eyebrow">LOCALHOST 管理介面</p><h1>${escapeHtml(page.title)}</h1><p class="ui-page-description">${escapeHtml(page.description)}</p></div></header>
          ${await page.render(readModel, trustedContext)}
        </div>
      </main>
    </div>
  </body>
</html>`;
}

function routePath(url: string): string | undefined {
  const withoutQueryOrFragment = url.split(/[?#]/u, 1)[0] ?? "";
  if (
    !withoutQueryOrFragment.startsWith("/") ||
    withoutQueryOrFragment.startsWith("//") ||
    withoutQueryOrFragment.includes("\\") ||
    withoutQueryOrFragment.includes("\u0000")
  ) {
    return undefined;
  }
  return withoutQueryOrFragment;
}

function textResponse(
  method: string,
  statusCode: number,
  body: string,
  allow?: string,
): UiResponse {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  };
  if (allow !== undefined) headers["allow"] = allow;
  if (method === "HEAD") return Object.freeze({ statusCode, headers: Object.freeze(headers) });
  return Object.freeze({ statusCode, headers: Object.freeze(headers), body });
}

function assetResponse(method: string, asset: StaticAsset): UiResponse {
  const headers = Object.freeze({ "cache-control": "no-store", "content-type": asset.contentType });
  if (method === "HEAD") return Object.freeze({ statusCode: 200, headers });
  return Object.freeze({ statusCode: 200, headers, body: asset.content });
}

function htmlResponse(method: string, html: string): UiResponse {
  const headers = Object.freeze({
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  if (method === "HEAD") return Object.freeze({ statusCode: 200, headers });
  return Object.freeze({ statusCode: 200, headers, body: html });
}

function findPage(
  path: string,
  definitions: readonly PageDefinition[],
): PageDefinition | undefined {
  return definitions.find((page) => page.path === path);
}

/** Creates the shell-owned document around validated registered feature content. */
export function createUiShellRequestHandler(
  readModel: UiShellReadModel = fixtureUiShellReadModel,
  features: readonly UiFeatureRegistration[] = Object.freeze([]),
): UiRequestHandler {
  const definitions: readonly PageDefinition[] = Object.freeze([
    ...pageDefinitions,
    ...features.map((feature) =>
      Object.freeze({
        path: feature.page.path,
        title: feature.page.title,
        description: feature.page.description,
        ...(feature.page.styles === undefined
          ? {}
          : { styles: Object.freeze([...feature.page.styles]) }),
        ...(feature.page.scripts === undefined
          ? {}
          : { scripts: Object.freeze([...feature.page.scripts]) }),
        render: (_readModel: UiShellReadModel, trustedContext: UiTrustedRequestContext) =>
          feature.page.render(trustedContext),
      }),
    ),
  ]);
  const slotPages = new Map<UiFeatureSlot, string>(
    features.map((feature) => [feature.slot, feature.page.path]),
  );
  const featureRoutes = new Map<string, UiFeatureRoute>(
    features.flatMap((feature) => feature.routes.map((route) => [route.contract.path, route])),
  );

  return async (
    request: UiRequest,
    trustedContext: UiTrustedRequestContext,
  ): Promise<UiResponse> => {
    const path = routePath(request.url);
    if (path === undefined) return textResponse(request.method, 404, "Not Found\n");

    const featureRoute = featureRoutes.get(path);
    if (featureRoute !== undefined) return await featureRoute.handler(request, trustedContext);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(request.method, 405, "Method Not Allowed\n", "GET, HEAD");
    }

    const asset = (assets as Readonly<Record<string, StaticAsset | undefined>>)[path];
    if (asset !== undefined) return assetResponse(request.method, asset);

    const page = findPage(path, definitions);
    if (page === undefined) return textResponse(request.method, 404, "Not Found\n");

    try {
      if (request.method === "GET" && readModel.refresh !== undefined) {
        await readModel.refresh();
      }
      return htmlResponse(
        request.method,
        await renderPage(page, readModel, slotPages, trustedContext),
      );
    } catch {
      return textResponse(request.method, 500, "Internal Server Error\n");
    }
  };
}
