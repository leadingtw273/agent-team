import type { ActiveModelAssignment } from "../../../application/routing/index.js";
import type { RoleModelRouteView, RoleModelSettingsSnapshot } from "./use-case.js";

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

function candidateName(candidate: RoleModelRouteView["candidates"][number]): string {
  return `${candidate.providerLabel} / ${candidate.model}`;
}

function renderMoveButton(name: string, direction: "up" | "down", isBoundary: boolean): string {
  const actionLabel = direction === "up" ? "上移" : "下移";
  const boundaryLabel = direction === "up" ? "已在最上" : "已在最下";
  const accessibleLabel = isBoundary ? `${name} ${boundaryLabel}` : `將 ${name} ${actionLabel}`;
  return `<button class="btn btn-sm btn-outline-secondary${isBoundary ? " ui-role-model-action--boundary" : ""}" type="button" data-role-model-move="${direction}" aria-label="${escapeHtml(accessibleLabel)}"${isBoundary ? " disabled" : ""}>${boundaryLabel}</button>`;
}

function activeAssignmentsFor(
  assignments: readonly ActiveModelAssignment[],
  role: RoleModelRouteView["role"],
): readonly ActiveModelAssignment[] {
  return assignments.filter((assignment) => assignment.role === role);
}

function renderActiveAssignments(assignments: readonly ActiveModelAssignment[]): string {
  if (assignments.length === 0) {
    return '<p class="mb-0 text-secondary">目前此角色沒有執行中的模型工作。</p>';
  }
  return `<ul class="ui-list ui-role-model-active-list">${assignments
    .map(
      (assignment) =>
        `<li class="ui-list-item" data-active-job-id="${escapeHtml(assignment.jobId)}" data-active-candidate="${escapeHtml(`${assignment.candidate.provider}:${assignment.candidate.model}`)}"><div><div class="ui-item-title">${escapeHtml(assignment.jobId)}</div><div class="ui-item-meta">${escapeHtml(assignment.candidate.provider)} / ${escapeHtml(assignment.candidate.model)} · 啟動時順位 ${String(assignment.candidateIndex + 1)}</div></div><span class="badge bg-secondary-lt text-secondary">維持原指派</span></li>`,
    )
    .join("")}</ul>`;
}

function renderCandidate(
  candidate: RoleModelRouteView["candidates"][number],
  index: number,
  count: number,
): string {
  const name = candidateName(candidate);
  const key = `${candidate.provider}:${candidate.model}`;
  return `<li class="ui-role-model-candidate" draggable="true" tabindex="0" data-candidate-key="${escapeHtml(key)}" data-candidate-name="${escapeHtml(name)}">
    <div class="ui-role-model-candidate-main"><span class="badge bg-blue-lt text-blue" data-candidate-order>${String(index + 1)}</span><div><strong>${escapeHtml(candidate.providerLabel)}</strong><code>${escapeHtml(candidate.model)}</code><div class="ui-item-meta"><span class="visually-hidden">可用能力：</span>${candidate.capabilities.map(escapeHtml).join("、")}</div></div></div>
    <div class="ui-role-model-actions" role="group" aria-label="${escapeHtml(name)} 排序操作">${renderMoveButton(name, "up", index === 0)}${renderMoveButton(name, "down", index === count - 1)}</div>
  </li>`;
}

function renderRoute(
  route: RoleModelRouteView,
  assignments: readonly ActiveModelAssignment[],
): string {
  const active = activeAssignmentsFor(assignments, route.role);
  const orderNoteId = `role-${route.role}-order-note`;
  return `<article class="card ui-panel ui-role-model-card" data-role="${route.role}" aria-labelledby="role-${route.role}-title">
    <div class="card-body">
      <div class="ui-section-heading"><div><h2 id="role-${route.role}-title">${escapeHtml(route.label)}</h2><p>${escapeHtml(route.description)}</p></div></div>
      <div class="ui-role-model-order-note" id="${orderNoteId}"><span class="badge bg-azure-lt text-azure">新 Job 順序</span><p class="ui-role-model-caption">拖曳候選項目或用「上移／下移」按鈕調整順位。此順序僅套用到新 Job；每個候選都顯示 Provider、Model 與可用能力。</p></div>
      <ol class="ui-role-model-candidates" data-role-model-list="${route.role}" aria-label="${escapeHtml(route.label)} 的模型候選順序" aria-describedby="${orderNoteId}">${route.candidates
        .map((candidate, index) => renderCandidate(candidate, index, route.candidates.length))
        .join("")}</ol>
      <aside class="ui-role-model-active" aria-label="${escapeHtml(route.label)} 的執行中模型指派"><h3>執行中的指派</h3><p>執行中的工作不會因為這次儲存而切換模型。</p>${renderActiveAssignments(active)}</aside>
    </div>
  </article>`;
}

function renderSaveAction(): string {
  return `<section class="ui-role-model-save card ui-panel" data-role-model-action-bar aria-label="儲存模型順位"><div class="card-body"><div class="ui-role-model-save-summary"><h2>儲存設定</h2><p>排序完成後會以安全 Session、CSRF 與同源 Mutation 合約寫入，並立刻讀回確認。</p></div><button class="btn btn-primary" type="button" data-role-model-save disabled>儲存模型順序</button><p class="ui-role-model-status" aria-live="polite" data-role-model-status>正在確認安全工作階段…</p></div></section>`;
}

export function renderRoleModelPage(snapshot: RoleModelSettingsSnapshot): string {
  return `<aside class="ui-fixture-notice" aria-label="設定範圍說明"><span>設定只會套用到後續建立的 Job；角色定義與額度設定不會寫入這個頁面。</span></aside>
    <section class="ui-role-model-intro card ui-panel" aria-labelledby="role-model-intro-title"><div class="card-body"><h2 id="role-model-intro-title">模型候選順位</h2><p class="mb-0">Provider 不可用、Provider Slot 已滿或額度無法確認時，派工會依順序嘗試下一個候選。儲存前會驗證所有標準角色與候選，失敗時保留舊設定。</p></div></section>
    ${renderSaveAction()}
    <div class="ui-role-model-grid">${snapshot.routes
      .map((route) => renderRoute(route, snapshot.activeAssignments))
      .join("")}</div>`;
}
