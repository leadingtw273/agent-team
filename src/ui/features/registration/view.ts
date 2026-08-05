import type { RegistrationScanGate } from "../../../application/registration/index.js";

import { safeRegistrationText, type RegistrationWizardReadModel } from "./model.js";

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

function normalizedState(value: unknown): RegistrationScanGate["state"] {
  return value === "passed" || value === "failed" || value === "unknown" ? value : "unknown";
}

function stateLabel(state: unknown): string {
  switch (state) {
    case "passed":
      return "已通過";
    case "failed":
      return "需要修復";
    case "unknown":
      return "尚未確認";
    default:
      return "尚未確認";
  }
}

function scopeLabel(scope: unknown): string {
  switch (scope) {
    case "O002 Read-only scan":
      return "O002 Read-only scan";
    case "後續 Gate":
      return "後續 Gate";
    default:
      return "未確認範圍";
  }
}

function provenanceLabel(provenance: unknown): string {
  switch (provenance) {
    case "local_git":
      return "本機 Git 唯讀檢查";
    case "node_runtime":
      return "本機 Node.js Runtime";
    case "compiled_cli":
      return "編譯後 CLI --version";
    case "github_read_only":
      return "GitHub read-only query";
    case "linear_read_only":
      return "Linear read-only query";
    case "ci_read_only":
      return "GitHub Actions read-only query";
    case "webhook_configuration":
      return "Webhook Runtime 設定讀取";
    case "not_scanned":
      return "O002 未掃描";
    default:
      return "來源未經安全確認";
  }
}

function errorLabel(error: unknown): string | undefined {
  switch (error) {
    case "invalid_evidence":
      return "證據無法安全顯示";
    case "interrupted":
      return "掃描已中斷";
    case "not_found":
      return "找不到必要目標";
    case "not_scanned":
      return "留待後續 Gate";
    case "permission_denied":
      return "權限不足";
    case "rate_limited":
      return "服務暫時限制";
    case "timeout":
      return "掃描逾時";
    case "unavailable":
      return "Read-only adapter 不可用";
    case "unknown":
      return "無法安全確認";
    case undefined:
      return undefined;
    default:
      return "無法安全確認";
  }
}

function renderEvidence(gate: RegistrationScanGate, label: string): string {
  const evidence =
    Array.isArray(gate.evidence) && gate.evidence.length > 0
      ? gate.evidence
      : ["尚未提供可安全顯示的證據。"];
  return `<section class="ui-registration-detail" aria-label="${escapeHtml(`${label} 證據`)}">
    <h3>證據</h3>
    <ul class="ui-registration-evidence">${evidence
      .map((item) => `<li>${escapeHtml(safeRegistrationText(item))}</li>`)
      .join("")}</ul>
  </section>`;
}

function renderGate(gate: RegistrationScanGate, index: number): string {
  const state = normalizedState(gate.state);
  const label = safeRegistrationText(gate.label);
  const scope = scopeLabel(gate.scope);
  const error = errorLabel(gate.error);
  const headingId = `registration-gate-${String(index + 1)}`;
  return `<article class="card ui-registration-card ui-registration-card--${state}" aria-labelledby="${headingId}">
    <div class="card-body">
      <header class="ui-registration-card-header">
        <div>
          <p class="ui-registration-card-eyebrow">${escapeHtml(scope)}</p>
          <h2 id="${headingId}">${escapeHtml(label)}</h2>
        </div>
        <span class="ui-registration-state ui-registration-state--${state}">${stateLabel(state)}</span>
      </header>
      ${renderEvidence(gate, label)}
      <section class="ui-registration-detail" aria-label="${escapeHtml(`${label} 修復建議`)}">
        <h3>修復建議</h3>
        <p>${escapeHtml(safeRegistrationText(gate.repair))}</p>
      </section>
      <dl class="ui-registration-facts">
        <div><dt>來源</dt><dd>${escapeHtml(provenanceLabel(gate.provenance))}</dd></div>
        ${
          gate.observedAt === undefined
            ? ""
            : `<div><dt>觀測時間</dt><dd>${escapeHtml(safeRegistrationText(gate.observedAt))}</dd></div>`
        }
        ${error === undefined ? "" : `<div><dt>確認結果</dt><dd>${escapeHtml(error)}</dd></div>`}
      </dl>
    </div>
  </article>`;
}

function counts(
  readModel: RegistrationWizardReadModel,
): Readonly<Record<RegistrationScanGate["state"], number>> {
  const total: Record<RegistrationScanGate["state"], number> = { passed: 0, failed: 0, unknown: 0 };
  for (const gate of readModel.gates) total[normalizedState(gate.state)] += 1;
  return total;
}

/** Renders a content fragment only; the shared Shell owns document, session, and navigation. */
export function renderRegistrationWizard(readModel: RegistrationWizardReadModel): string {
  const gateCounts = counts(readModel);
  const sourceNotice =
    readModel.source === "fixture"
      ? `<aside class="ui-registration-fixture-notice" aria-label="資料來源說明">這是合成示範資料，不代表已掃描任何本機或外部服務。</aside>`
      : "";
  return `${sourceNotice}
    <aside class="ui-registration-safety-notice" aria-label="操作範圍">
      本頁只讀取經摘要化的掃描結果；不建立 PR、不變更 GitHub／Linear／CI／Webhook，也不讀取認證資料。
    </aside>
    <section class="ui-registration-summary" aria-labelledby="registration-summary-title">
      <div>
        <p class="ui-registration-eyebrow">目前狀態</p>
        <h2 id="registration-summary-title">${escapeHtml(safeRegistrationText(readModel.stateLabel))}</h2>
        <p>O002 只執行 7 項 read-only scan；其餘 Gate 會保留未確認，絕不因本頁而註冊專案。</p>
      </div>
      <dl aria-label="掃描摘要">
        <div><dt>已通過</dt><dd>${String(gateCounts.passed)}</dd></div>
        <div><dt>需要修復</dt><dd>${String(gateCounts.failed)}</dd></div>
        <div><dt>尚未確認</dt><dd>${String(gateCounts.unknown)}</dd></div>
      </dl>
    </section>
    <section class="ui-registration-gates" aria-label="註冊 Gate 掃描結果">
      ${readModel.gates.map((gate, index) => renderGate(gate, index)).join("")}
    </section>`;
}
