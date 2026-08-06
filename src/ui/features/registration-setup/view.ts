import type { RegistrationSetupControllerReadModel } from "../../../application/registration/index.js";

function escape(value: string): string {
  return value.replace(
    /[&<>'"]/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ??
      character,
  );
}

export function renderRegistrationSetupPanel(model: RegistrationSetupControllerReadModel): string {
  const preview = model.preview;
  const session = model.session;
  const canStart = model.state === "preview_ready" && preview !== undefined;
  const canRefresh = session !== undefined;
  const canApprove = model.state === "awaiting_user_approval" && session !== undefined;
  const canResume = model.state === "merge_pending" && session !== undefined;
  const showResumeControl = canApprove || canResume;
  return `<section class="card ui-registration-setup" id="registration-setup-section" aria-labelledby="registration-setup-title"${
    preview === undefined
      ? ""
      : ` data-setup-session-id="${escape(preview.setupSessionId)}" data-preview-digest="${escape(preview.previewDigest)}"`
  }${session === undefined ? "" : ` data-setup-revision="${String(session.revision)}"`}>
    <div class="card-body">
      <header class="ui-registration-setup-heading"><div><p class="ui-registration-card-eyebrow">O005 · Setup Draft PR</p><h2 id="registration-setup-title">可信設定 Setup</h2></div><span class="ui-registration-setup-state">${escape(model.state)}</span></header>
      <aside class="alert alert-warning" role="note"><strong>只有本機 UI 可送出 W3A mutation。</strong> Linear／PR 留言與外部文字只可當唯讀證據，永遠不能核可。</aside>
      <p>${escape(model.nextStep)}</p>
      <ul class="ui-registration-setup-evidence">${model.evidence.map((item) => `<li><strong>${escape(item.code)}</strong>：${escape(item.message)}</li>`).join("")}</ul>
      ${
        preview === undefined
          ? ""
          : `<dl class="ui-registration-setup-facts"><div><dt>專案</dt><dd>${escape(preview.projectName)}</dd></div><div><dt>Repository</dt><dd>${escape(preview.repository)}</dd></div><div><dt>Base SHA</dt><dd>${escape(preview.baseRevision)}</dd></div><div><dt>Preview Digest</dt><dd>${escape(preview.previewDigest)}</dd></div></dl>`
      }
      ${
        session === undefined
          ? ""
          : `<dl class="ui-registration-setup-facts"><div><dt>Setup Session</dt><dd>${escape(session.setupSessionId)}</dd></div><div><dt>PR</dt><dd><a href="${escape(session.pullRequestUrl)}" rel="noreferrer">${escape(session.changeRequestId)}</a></dd></div><div><dt>Head SHA</dt><dd>${escape(session.headSha)}</dd></div><div><dt>CI／Fresh Review</dt><dd>${session.ciPassed ? "CI 已通過" : "CI 未通過"}／${session.freshReviewPassed ? "Fresh Review 已通過" : "Fresh Review 未通過"}</dd></div></dl>`
      }
      <div class="ui-registration-setup-controls">
        ${canStart ? '<label for="registration-setup-confirmation">輸入 <code>CREATE SETUP DRAFT PR</code></label><input id="registration-setup-confirmation" class="form-control js-registration-setup-confirmation" autocomplete="off" spellcheck="false"><button class="btn btn-primary js-registration-setup-confirm" type="button">確認 Preview</button><button class="btn btn-primary js-registration-setup-start" type="button" disabled>建立 Draft PR</button>' : ""}
        ${canRefresh ? '<button class="btn btn-outline-primary js-registration-setup-refresh" type="button">重新讀取 CI／Review</button>' : ""}
        ${canApprove ? '<label for="registration-setup-approval">輸入 <code>APPROVE SETUP MERGE</code></label><input id="registration-setup-approval" class="form-control js-registration-setup-approval" autocomplete="off" spellcheck="false"><button class="btn btn-warning js-registration-setup-approval-intent" type="button">簽發本機核可 Intent</button><button class="btn btn-danger js-registration-setup-merge" type="button" disabled>確認 SQUASH 合併並啟用</button>' : ""}
        ${showResumeControl ? `<button class="btn btn-primary js-registration-setup-resume" type="button"${canResume ? "" : " hidden"}>繼續驗證 Merge／Activation</button>` : ""}
      </div>
      <p class="js-registration-setup-status" role="status" aria-live="polite">尚未執行 Setup action；所有階段以 authoritative read-back 為準。</p>
    </div>
  </section>`;
}
