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
        `<li class="ui-list-item"><div><span class="ui-item-title">${escapeHtml(assignment.jobId)}</span><span class="ui-item-meta">${escapeHtml(assignment.candidate.provider)} / ${escapeHtml(assignment.candidate.model)} · 啟動時順位 ${String(assignment.candidateIndex + 1)}</span></div><span class="badge bg-secondary-lt text-secondary">維持原指派</span></li>`,
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
  return `<li class="ui-role-model-candidate" draggable="true" tabindex="0" data-candidate-key="${escapeHtml(key)}">
    <div class="ui-role-model-candidate-main"><span class="badge bg-blue-lt text-blue" data-candidate-order>${String(index + 1)}</span><div><strong>${escapeHtml(candidate.providerLabel)}</strong><code>${escapeHtml(candidate.model)}</code><div class="ui-item-meta"><span class="visually-hidden">可用能力：</span>${candidate.capabilities.map(escapeHtml).join("、")}</div></div></div>
    <div class="ui-role-model-actions" role="group" aria-label="${escapeHtml(name)} 排序操作"><button class="btn btn-sm btn-outline-secondary" type="button" data-role-model-move="up" aria-label="將 ${escapeHtml(name)} 上移"${index === 0 ? " disabled" : ""}>上移</button><button class="btn btn-sm btn-outline-secondary" type="button" data-role-model-move="down" aria-label="將 ${escapeHtml(name)} 下移"${index === count - 1 ? " disabled" : ""}>下移</button></div>
  </li>`;
}

function renderRoute(
  route: RoleModelRouteView,
  assignments: readonly ActiveModelAssignment[],
): string {
  const active = activeAssignmentsFor(assignments, route.role);
  return `<article class="card ui-panel ui-role-model-card" data-role="${route.role}" aria-labelledby="role-${route.role}-title">
    <div class="card-body">
      <div class="ui-section-heading"><div><h2 id="role-${route.role}-title">${escapeHtml(route.label)}</h2><p>${escapeHtml(route.description)}</p></div><span class="badge bg-azure-lt text-azure">新 Job 順序</span></div>
      <p class="ui-role-model-caption">拖曳候選項目或用「上移／下移」按鈕調整順位。每個候選都顯示 Provider、Model 與可用能力。</p>
      <ol class="ui-role-model-candidates" data-role-model-list="${route.role}" aria-label="${escapeHtml(route.label)} 的模型候選順序">${route.candidates
        .map((candidate, index) => renderCandidate(candidate, index, route.candidates.length))
        .join("")}</ol>
      <aside class="ui-role-model-active" aria-label="${escapeHtml(route.label)} 的執行中模型指派"><h3>執行中的指派</h3><p>執行中的工作不會因為這次儲存而切換模型。</p>${renderActiveAssignments(active)}</aside>
    </div>
  </article>`;
}

export function renderRoleModelPage(snapshot: RoleModelSettingsSnapshot): string {
  return `<aside class="ui-fixture-notice" aria-label="設定範圍說明"><span>設定只會套用到後續建立的 Job；角色定義與額度設定不會寫入這個頁面。</span></aside>
    <section class="ui-role-model-intro card ui-panel" aria-labelledby="role-model-intro-title"><div class="card-body"><h2 id="role-model-intro-title">模型候選順位</h2><p class="mb-0">Provider 不可用、Provider Slot 已滿或額度無法確認時，派工會依順序嘗試下一個候選。儲存前會驗證所有標準角色與候選，失敗時保留舊設定。</p></div></section>
    <div class="ui-role-model-grid">${snapshot.routes
      .map((route) => renderRoute(route, snapshot.activeAssignments))
      .join("")}</div>
    <section class="ui-role-model-save card ui-panel" aria-label="儲存模型順位"><div class="card-body"><div><h2>儲存設定</h2><p>排序完成後會以安全 Session、CSRF 與同源 Mutation 合約寫入，並立刻讀回確認。</p></div><button class="btn btn-primary" type="button" data-role-model-save disabled>安全傳輸接入後啟用</button><p class="visually-hidden" aria-live="polite" data-role-model-status></p></div></section>`;
}
