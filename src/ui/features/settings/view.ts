import { containsSensitiveValue } from "../../../infrastructure/redaction/index.js";
import { userSettingsSchema } from "./schema.js";
import type { SettingsReadModel } from "./use-case.js";
import { parseUserSettingsYaml, serializeUserSettingsYaml } from "./yaml.js";

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

function readyContent(model: Extract<SettingsReadModel, { state: "ready" }>): string {
  const runtimeUrl = model.webhookRuntimeBaseUrl ?? "尚未設定";
  const providerLimits = model.concurrency.perProviderModelJobs;
  return `<section class="card ui-panel mb-3" aria-labelledby="settings-form-title"><div class="card-body">
    <div class="ui-section-heading"><div><h2 id="settings-form-title">營運設定</h2><p>這些值只影響後續建立的工作。</p></div><span class="badge bg-secondary-lt text-secondary">${model.source === "defaults" ? "內建預設" : "已儲存"}</span></div>
    <div class="mb-3"><label class="form-label" for="settings-webhook-url">Webhook Runtime URL</label><input id="settings-webhook-url" class="form-control" type="url" value="${escapeHtml(runtimeUrl)}" readonly aria-describedby="settings-webhook-help"><p id="settings-webhook-help" class="form-hint">僅接受不含帳密、Query 或 Fragment 的 HTTPS URL。</p></div>
    <div class="row g-3" aria-label="併行限制">
      <div class="col-12 col-md-6"><label class="form-label" for="settings-global-jobs">全域模型工作</label><input id="settings-global-jobs" class="form-control" type="number" value="${String(model.concurrency.globalModelJobs)}" readonly></div>
      <div class="col-12 col-md-6"><label class="form-label" for="settings-project-jobs">每專案模型工作</label><input id="settings-project-jobs" class="form-control" type="number" value="${String(model.concurrency.perProjectModelJobs)}" readonly></div>
      <div class="col-12 col-md-4"><label class="form-label" for="settings-codex-jobs">Codex</label><input id="settings-codex-jobs" class="form-control" type="number" value="${String(providerLimits.codex)}" readonly></div>
      <div class="col-12 col-md-4"><label class="form-label" for="settings-claude-jobs">Claude</label><input id="settings-claude-jobs" class="form-control" type="number" value="${String(providerLimits.claude)}" readonly></div>
      <div class="col-12 col-md-4"><label class="form-label" for="settings-gemini-jobs">Gemini</label><input id="settings-gemini-jobs" class="form-control" type="number" value="${String(providerLimits.gemini)}" readonly></div>
    </div>
  </div></section>
  <section class="card ui-panel" aria-labelledby="settings-yaml-title"><div class="card-body">
    <div class="ui-section-heading"><div><h2 id="settings-yaml-title">進階 Raw YAML（唯讀）</h2><p>只顯示通過受控 schema 的 canonical 內容。</p></div></div>
    <label class="visually-hidden" for="settings-raw-yaml">進階 Raw YAML</label><textarea id="settings-raw-yaml" class="form-control font-monospace" rows="12" readonly spellcheck="false">${escapeHtml(model.rawYaml)}</textarea>
    <div class="d-flex flex-wrap gap-2 align-items-center mt-3"><button class="btn btn-primary" type="button" disabled>儲存設定</button><span class="text-muted">儲存功能將在安全 mutation transport 整合後啟用。</span></div>
  </div></section>`;
}

function renderContent(model: SettingsReadModel): string {
  const parsedSettings =
    model.state === "ready"
      ? userSettingsSchema.safeParse({
          schemaVersion: 1,
          webhook: { runtimeBaseUrl: model.webhookRuntimeBaseUrl },
          concurrency: model.concurrency,
        })
      : undefined;
  const parsedYaml = model.state === "ready" ? parseUserSettingsYaml(model.rawYaml) : undefined;
  const readyIsSafe =
    model.state === "ready" &&
    parsedSettings?.success === true &&
    parsedYaml?.ok === true &&
    serializeUserSettingsYaml(parsedSettings.data) ===
      serializeUserSettingsYaml(parsedYaml.value) &&
    !containsSensitiveValue(model.rawYaml) &&
    (model.webhookRuntimeBaseUrl === null || !containsSensitiveValue(model.webhookRuntimeBaseUrl));
  return model.state === "ready" && readyIsSafe
    ? readyContent(model)
    : `<section class="card ui-panel"><div class="card-body"><h2>設定無法載入</h2><p>${escapeHtml("設定目前無法安全讀取。")}</p></div></section>`;
}

export function renderSettingsPage(model: SettingsReadModel): string {
  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>設定｜Agent Team</title>
    <link rel="stylesheet" href="/assets/tabler-1.4.0.min.css">
    <link rel="stylesheet" href="/assets/ui-shell.css">
  </head>
  <body class="ui-shell"><main id="main-content" class="ui-content"><div class="ui-content-inner">
    <header class="ui-page-header"><div><p class="ui-page-eyebrow">LOCALHOST 管理介面</p><h1>設定</h1><p class="ui-page-description">管理 Webhook Runtime 與既定併行限制；此頁不接受行內 CLI 參數或 Secret。</p></div></header>
    ${renderContent(model)}
  </div></main></body>
</html>`;
}
