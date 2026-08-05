import type { QuotaProviderId } from "./contracts.js";
import {
  quotaBucketLabel,
  type QuotaBucketReadModel,
  type QuotaDashboardReadModel,
  type QuotaReadModelReason,
} from "./read-model.js";

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

const reasonLabels: Readonly<Record<QuotaReadModelReason, string>> = Object.freeze({
  account_switched: "偵測到帳號切換，舊樣本已失效。",
  account_switch_invalidation_failed: "偵測到帳號切換，但舊樣本失效寫入未完成。",
  cli_version_changed: "CLI 版本已變更，先前樣本不再採用。",
  cli_version_unverified: "無法驗證目前 CLI 版本，因此不採用樣本。",
  identity_invalid: "目前帳號身分無法確認。",
  provider_record_ambiguous: "Provider 設定不唯一，無法安全選擇樣本。",
  provider_record_missing: "尚未取得此 Provider 的設定或樣本。",
  provider_signal_unknown: "Provider 沒有提供可驗證的額度訊號。",
  signal_confirmed: "樣本來源、帳號與時間已確認。",
  sample_duplicated: "同一額度 bucket 有多筆樣本，無法安全選擇。",
  sample_expired: "樣本已超過有效時間，需先刷新。",
  sample_identity_mismatch: "樣本帳號與目前登入帳號不一致。",
  sample_in_future: "樣本時間晚於目前時間，無法採用。",
  sample_invalid: "樣本格式或數值無法驗證。",
  sample_marked_stale: "此樣本已被標為失效，不採用其中數值。",
  sample_missing: "Provider 沒有提供此 bucket 的樣本。",
  sample_provider_mismatch: "樣本 Provider 與目前設定不一致。",
  snapshot_missing: "尚未取得可用樣本。",
});

function stateLabel(state: QuotaBucketReadModel["state"]): string {
  switch (state) {
    case "fresh":
      return "新鮮";
    case "stale":
      return "已過期";
    case "unknown":
      return "無法確認";
  }
}

function statusClass(state: QuotaBucketReadModel["state"]): string {
  switch (state) {
    case "fresh":
      return "success";
    case "stale":
      return "warning";
    case "unknown":
      return "error";
  }
}

function observedUsage(bucket: QuotaBucketReadModel): string {
  if (bucket.state !== "fresh") return "不顯示未確認或已過期數值。";
  if (bucket.available !== undefined)
    return bucket.available ? "Provider 回報可用。" : "Provider 回報目前不可用。";
  if (bucket.usedPercent === undefined || bucket.remainingPercent === undefined) {
    return "數值無法確認。";
  }
  const reset = bucket.resetsAt === undefined ? "" : `；預計重設：${escapeHtml(bucket.resetsAt)}`;
  return `${String(bucket.usedPercent)}% 已使用 · ${String(bucket.remainingPercent)}% 剩餘${reset}`;
}

function renderBucket(provider: QuotaProviderId, bucket: QuotaBucketReadModel): string {
  const label = quotaBucketLabel(provider, bucket.bucket);
  const state = stateLabel(bucket.state);
  return `<section class="ui-quota-bucket" aria-labelledby="quota-${provider}-${bucket.bucket}">
    <div class="ui-section-heading"><div><h3 id="quota-${provider}-${bucket.bucket}">${label}</h3><p>Provider 觀測結果</p></div><span class="badge ui-status-badge ui-status--${statusClass(bucket.state)}" data-quota-state="${bucket.state}">${state}</span></div>
    <dl class="ui-quota-details">
      <div><dt>觀測結果</dt><dd>${observedUsage(bucket)}</dd></div>
      <div><dt>樣本來源</dt><dd>${escapeHtml(bucket.source)}</dd></div>
      <div><dt>觀測時間</dt><dd>${escapeHtml(bucket.observedAt)}</dd></div>
      <div><dt>狀態原因</dt><dd>${reasonLabels[bucket.reason]}</dd></div>
    </dl>
  </section>`;
}

function renderWeeklyConfiguration(
  configuration: QuotaDashboardReadModel["providers"][number]["weeklyConfiguration"],
): string {
  switch (configuration.state) {
    case "configured":
      return `使用者設定週使用上限：<strong>${String(configuration.usageLimitPercent)}%</strong>`;
    case "unconfigured":
      return "尚未設定週使用上限。";
    case "not_applicable":
      return "Gemini 第一版沒有使用者設定的週額度牆。";
  }
}

function renderProvider(provider: QuotaDashboardReadModel["providers"][number]): string {
  const switchNotice =
    provider.accountSwitch.state === "invalidated"
      ? `<aside class="ui-fixture-notice" aria-label="帳號切換警示"><span>${reasonLabels[provider.accountSwitch.reason]}</span><span>先前帳號：${escapeHtml(provider.accountSwitch.previousIdentity)}</span></aside>`
      : "";
  return `<article class="card ui-panel ui-quota-provider" aria-labelledby="quota-${provider.provider}-title">
    <div class="card-body">
      <div class="ui-section-heading"><div><h2 id="quota-${provider.provider}-title">${provider.label}</h2><p>帳號：${escapeHtml(provider.activeIdentity)}</p></div></div>
      ${switchNotice}
      <p class="ui-quota-configuration">${renderWeeklyConfiguration(provider.weeklyConfiguration)}</p>
      <p class="ui-quota-no-five-hour-config">五小時額度沒有使用者設定；只顯示 Provider 已知訊號。</p>
      <div class="ui-quota-buckets">${provider.buckets
        .map((bucket) => renderBucket(provider.provider, bucket))
        .join("")}</div>
      <div class="ui-quota-actions" aria-label="${provider.label} 額度動作">
        <button class="btn btn-outline-primary" type="button" data-quota-action="refresh" data-quota-provider="${provider.provider}">刷新樣本</button>
        <button class="btn btn-primary" type="button" data-quota-action="resume" data-quota-provider="${provider.provider}">確認並恢復派工</button>
      </div>
      <p class="ui-item-meta" id="quota-${provider.provider}-action-status" aria-live="polite">刷新樣本與手動恢復派工是兩個獨立動作。</p>
    </div>
  </article>`;
}

/** Renders only the safe feature read model; no provider output, runtime port, or secret reaches HTML. */
export function renderQuotaDashboard(dashboard: QuotaDashboardReadModel): string {
  return `<section class="ui-fixture-notice" aria-label="額度頁資料說明"><span>僅顯示經過驗證的樣本摘要；不回顯原始 Provider 輸出、Token 或 Secret。</span></section>
    <section class="ui-quota-grid" aria-label="Provider 額度摘要">${dashboard.providers
      .map((provider) => renderProvider(provider))
      .join("")}</section>`;
}
