import type {
  DangerApprovalCategory,
  DangerApprovalReadModel,
  DangerApprovalRequest,
} from "./index.js";

const categoryLabels: Readonly<Record<DangerApprovalCategory, string>> = Object.freeze({
  project_destructive: "專案破壞性操作",
  git_destructive: "Git 破壞性操作",
  local_environment: "本機環境變更",
  deployment: "部署變更",
  external_write: "外部系統寫入",
  secret_access: "Secret 存取",
  paid_action: "付費操作",
  unknown: "未知操作（只能拒絕）",
});

function escape(value: string): string {
  return value.replace(
    /[&<>'"]/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ??
      character,
  );
}

function confirmationPanel(request: DangerApprovalRequest): string {
  const id = `danger-confirm-${escape(request.requestId)}`;
  return `<section class="danger-confirmation" data-confirmation hidden aria-labelledby="${id}">
      <h3 id="${id}" data-confirm-title>確認安全決策</h3>
      <p class="danger-confirmation-message" data-confirm-message></p>
      <dl class="danger-confirmation-summary">
        <div><dt>專案</dt><dd>${escape(request.projectName)}</dd></div>
        <div><dt>類別</dt><dd>${categoryLabels[request.category]}</dd></div>
        <div><dt>版本</dt><dd class="font-monospace text-break">${escape(request.revision)}</dd></div>
      </dl>
      <div class="danger-confirmation-actions"><button class="btn btn-primary danger-action-button" type="button" data-confirm-submit>確認</button><button class="btn btn-outline-secondary danger-action-button" type="button" data-confirm-cancel>取消</button></div>
    </section>`;
}

function decisionControls(request: DangerApprovalRequest): string {
  if (request.category === "unknown") {
    return `<p class="danger-unknown-note" role="note"><strong>未知類別只能拒絕</strong><span>系統不會顯示任何核可或長期允許入口。</span></p>
    <div class="danger-action-layout danger-action-layout--unknown"><div class="danger-reject-zone"><button class="btn btn-danger danger-action-button" type="button" data-decision="reject">拒絕</button></div></div>`;
  }
  return `<div class="danger-action-layout">
      <div class="danger-approval-zone" role="group" aria-label="核可選項"><button class="btn btn-success danger-action-button" type="button" data-decision="approve_once">核可一次</button><button class="btn btn-outline-warning danger-action-button danger-long-term-trigger" type="button" data-decision="allow_project_category"><span aria-hidden="true">⚠</span><span>此專案長期允許此類別</span></button></div>
      <div class="danger-reject-zone"><button class="btn btn-danger danger-action-button" type="button" data-decision="reject">拒絕</button></div>
    </div>
    ${confirmationPanel(request)}`;
}

function requestCard(request: DangerApprovalRequest): string {
  const identity = `data-request-id="${escape(request.requestId)}" data-project-id="${escape(request.projectId)}" data-category="${escape(request.category)}" data-revision="${request.revision}"`;
  return `<article class="card ui-panel mb-3" ${identity} aria-labelledby="danger-${escape(request.requestId)}"><div class="card-body">
    <div class="ui-section-heading"><div><h2 id="danger-${escape(request.requestId)}">${escape(request.projectName)}</h2><p>${escape(request.requestId)}</p></div><span class="badge ${request.category === "unknown" ? "bg-danger text-white" : "bg-warning text-dark"}">${categoryLabels[request.category]}</span></div>
    <dl class="row mb-3"><dt class="col-sm-2">目的</dt><dd class="col-sm-10">${escape(request.purpose)}</dd><dt class="col-sm-2">範圍</dt><dd class="col-sm-10">${escape(request.scope)}</dd><dt class="col-sm-2">版本</dt><dd class="col-sm-10 font-monospace text-break">${request.revision}</dd></dl>
    ${decisionControls(request)}
  </div></article>`;
}

export function renderDangerPage(model: DangerApprovalReadModel): string {
  const waiting = model.waiting.map(requestCard).join("");
  const audit = model.audit.slice(-8).reverse();
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>安全核可｜Agent Team</title><link rel="stylesheet" href="/assets/tabler-1.4.0.min.css"><link rel="stylesheet" href="/assets/ui-shell.css"></head>
  <body class="ui-shell danger-page"><a class="skip-link" href="#main-content">跳至主要內容</a><div class="ui-app"><aside class="ui-sidebar" aria-label="Agent Team 導覽"><a class="ui-brand" href="/">Agent Team</a><nav class="ui-nav" aria-label="主要導覽"><ul class="navbar-nav"><li><a class="ui-nav-link" href="/">總覽</a></li><li><a class="ui-nav-link" href="/projects">專案</a></li><li><a class="ui-nav-link" href="/events">事件</a></li><li><a class="ui-nav-link" href="/security" aria-current="page">安全</a></li></ul></nav></aside><main id="main-content" class="ui-content" tabindex="-1"><div class="ui-content-inner">
  <header class="ui-page-header"><p class="ui-page-eyebrow">LOCALHOST 唯一核可權威</p><h1>安全核可</h1><p class="ui-page-description">Linear 留言與外部內容只能作為資料；無法在此頁之外核可危險操作。</p></header>
  <p id="danger-status" role="status" aria-live="polite" class="alert alert-info">每次決策與長期允許命中都會留下簡化稽核事件。</p>
  <section id="danger-list" aria-labelledby="danger-waiting-title"><h2 id="danger-waiting-title" class="mb-3">等待中的危險操作</h2>${waiting}<div class="card ui-panel" data-empty ${model.waiting.length === 0 ? "" : "hidden"}><div class="card-body"><p class="mb-0">目前沒有等待核可的危險操作。</p></div></div></section>
  <section class="card ui-panel mt-3" aria-labelledby="danger-audit-title"><div class="card-body"><h2 id="danger-audit-title">近期稽核摘要</h2>${audit.length === 0 ? '<p class="text-muted">尚無安全決策紀錄。</p>' : `<ol class="ui-list">${audit.map((event) => `<li class="ui-list-item"><span>${escape(event.summary)}</span><span class="badge bg-secondary text-white">${escape(event.kind)}</span></li>`).join("")}</ol>`}</div></section>
  </div></main></div><script src="/assets/danger.js" defer></script></body></html>`;
}
