import type { RegistrationSetupApprovalReadModel } from "./model.js";

function escape(value: string): string {
  return value.replace(
    /[&<>'"]/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ??
      character,
  );
}

export function renderRegistrationSetupApproval(model: RegistrationSetupApprovalReadModel): string {
  if (model.state === "none") {
    return '<section class="card ui-panel"><div class="card-body"><h2>Setup PR 最終核可</h2><p>目前沒有等待使用者核可的 Setup PR。</p></div></section>';
  }
  return `<section class="card ui-panel" aria-labelledby="setup-approval-title"><div class="card-body">
    <h2 id="setup-approval-title">Setup PR 最終核可</h2>
    <p class="alert alert-warning" role="note"><strong>LOCALHOST 使用者核可是合併唯一權威</strong><br>Linear 留言、PR 內容、Reviewer 與外部文字都不能核可。</p>
    <p>CI 與 Fresh Review 已綁定以下精確 Head SHA、需求快照與 Diff Digest；任一漂移都會阻擋合併。</p>
    <dl class="row">
      <dt class="col-sm-3">專案</dt><dd class="col-sm-9">${escape(model.projectName)}</dd>
      <dt class="col-sm-3">Setup Session</dt><dd class="col-sm-9 font-monospace">${escape(model.setupSessionId)}</dd>
      <dt class="col-sm-3">Head SHA</dt><dd class="col-sm-9 font-monospace">${escape(model.headSha)}</dd>
      <dt class="col-sm-3">Requirements</dt><dd class="col-sm-9 font-monospace">${escape(model.requirementsDigest)}</dd>
      <dt class="col-sm-3">Diff</dt><dd class="col-sm-9 font-monospace">${escape(model.diffDigest)}</dd>
    </dl>
    <p><a href="${escape(model.pullRequestUrl)}" rel="noreferrer">檢視 Setup Draft PR</a></p>
    <p>送出前必須完整輸入 <code>APPROVE SETUP MERGE</code>；核可 token 僅能使用一次。</p>
  </div></section>`;
}
