import {
  linearProvisionDesiredObjects,
  type LinearProvisionAction,
  type LinearProvisionPreview,
  type RegistrationScanGate,
} from "../../../application/registration/index.js";
import type { DomainError, Result } from "../../../domain/foundation/index.js";

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

const fixedLinearNames = new Map(
  linearProvisionDesiredObjects.map((desired) => [desired.key, desired.name]),
);

function linearActionLabel(state: LinearProvisionAction["state"]): string {
  switch (state) {
    case "unchanged":
      return "已 read-back";
    case "create":
      return "待確認建立";
    case "manual_create":
      return "需人工建立";
    case "manual_readback":
      return "需人工綁定 ID";
    case "conflict":
      return "衝突，已停止";
  }
}

function linearKindLabel(kind: LinearProvisionAction["kind"]): string {
  switch (kind) {
    case "workflow_state":
      return "工作狀態";
    case "label_group":
      return "Label Group";
    case "label":
      return "子 Label";
    case "form_template":
      return "Form Template";
  }
}

function renderLinearAction(action: LinearProvisionAction): string {
  const fixedName = fixedLinearNames.get(action.key);
  const name = fixedName === action.name ? fixedName : "已隱藏不安全的原始內容";
  return `<li class="ui-linear-action ui-linear-action--${action.state}">
    <div><span class="ui-linear-kind">${linearKindLabel(action.kind)}</span><strong>${escapeHtml(name)}</strong></div>
    <span class="ui-linear-action-state">${linearActionLabel(action.state)}</span>
    ${
      action.instruction === undefined
        ? ""
        : `<p>${escapeHtml(safeRegistrationText(action.instruction))}</p>`
    }
  </li>`;
}

function renderLinearProvision(result: Result<LinearProvisionPreview, DomainError>): string {
  if (!result.ok) {
    return `<section class="card ui-linear-provision" id="linear-provision-section" aria-labelledby="linear-provision-title">
      <div class="card-body">
        <p class="ui-registration-card-eyebrow">O003 · Linear</p>
        <h2 id="linear-provision-title">Linear 設定預覽</h2>
        <aside class="ui-linear-error" role="status">無法安全讀取 Linear 設定差異；未送出任何 mutation，也不會把目前狀態視為完成。</aside>
      </div>
    </section>`;
  }
  const preview = result.value;
  const canProvision = preview.summary.create > 0;
  return `<section class="card ui-linear-provision" id="linear-provision-section" aria-labelledby="linear-provision-title" data-expected-revision="${preview.expectedRevision}" data-confirmation-token="${preview.confirmationToken}">
    <div class="card-body">
      <header class="ui-linear-heading">
        <div><p class="ui-registration-card-eyebrow">O003 · Linear</p><h2 id="linear-provision-title">Linear 設定預覽</h2></div>
        <span class="ui-linear-readiness">${preview.state === "ready" ? "設定已完成" : "設定未完成"}</span>
      </header>
      <aside class="ui-linear-fixture-notice" aria-label="Linear 預覽資料來源">這是注入式合成 Linear port；不含真實憑證，也不會呼叫外部服務。</aside>
      <p class="ui-linear-intro">先比較中文工作狀態、Agent 角色／審查需求／Agent 狀態／阻塞原因 Label Group 與子 Label，以及中文 Form Template。既有物件只按已保存 ID 對帳，不刪除、不改名，也不從 Linear 留言取得核可。</p>
      <dl class="ui-linear-summary" aria-label="Linear 差異摘要">
        <div><dt>已 read-back</dt><dd>${String(preview.summary.unchanged)}</dd></div>
        <div><dt>可自動建立</dt><dd>${String(preview.summary.create)}</dd></div>
        <div><dt>人工步驟</dt><dd>${String(preview.summary.manual)}</dd></div>
        <div><dt>衝突</dt><dd>${String(preview.summary.conflict)}</dd></div>
      </dl>
      <ul class="ui-linear-actions" aria-label="Linear 逐項差異">${preview.actions.map(renderLinearAction).join("")}</ul>
      <div class="ui-linear-controls">
        <button class="btn btn-primary js-linear-review" type="button"${canProvision ? "" : " disabled"}>檢視套用確認</button>
        <p class="js-linear-status" role="status" aria-live="polite">${
          canProvision
            ? "尚未送出任何變更。"
            : "目前沒有可自動建立項目；請先完成人工步驟並 read-back。"
        }</p>
      </div>
      <section class="ui-linear-confirmation js-linear-confirmation" aria-labelledby="linear-confirmation-title" hidden>
        <h3 id="linear-confirmation-title">第二步確認</h3>
        <p>只建立預覽中標示「待確認建立」的項目；每項都會按回傳 ID read-back。人工或衝突項目仍維持設定未完成。</p>
        <div><button class="btn btn-primary js-linear-confirm" type="button">確認套用 Linear 設定</button><button class="btn btn-outline-secondary js-linear-cancel" type="button">取消</button></div>
      </section>
    </div>
  </section>`;
}

/** Renders a content fragment only; the shared Shell owns document, session, and navigation. */
export function renderRegistrationWizard(
  readModel: RegistrationWizardReadModel,
  linearPreview?: Result<LinearProvisionPreview, DomainError>,
): string {
  const gateCounts = counts(readModel);
  const sourceNotice =
    readModel.source === "fixture"
      ? `<aside class="ui-registration-fixture-notice" aria-label="資料來源說明">這是合成示範資料，不代表已掃描任何本機或外部服務。</aside>`
      : "";
  return `${sourceNotice}
    <aside class="ui-registration-safety-notice" aria-label="操作範圍">
      O002 掃描仍只讀且不建立 PR、不變更 GitHub／Linear／CI／Webhook。O003 只會在下方差異預覽後，經本機第二步明確確認才建立可支援的 Linear 項目。
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
    </section>
    ${linearPreview === undefined ? "" : renderLinearProvision(linearPreview)}`;
}
