/* global document */
(() => {
  "use strict";
  const panel = document.querySelector("[data-github-policy-panel]");
  const review = panel?.querySelector("[data-github-policy-review]");
  const confirmation = panel?.querySelector("[data-github-policy-confirm]");
  const apply = panel?.querySelector("[data-github-policy-apply]");
  const cancel = panel?.querySelector("[data-github-policy-cancel]");
  const status = panel?.querySelector("#github-policy-status");
  if (!panel || !review || !confirmation || !apply || !cancel || !status) return;

  const closeConfirmation = () => {
    confirmation.hidden = true;
    review.disabled = false;
    review.focus();
  };
  review.addEventListener("click", () => {
    confirmation.hidden = false;
    review.disabled = true;
    apply.focus();
  });
  cancel.addEventListener("click", closeConfirmation);
  confirmation.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeConfirmation();
  });
  apply.addEventListener("click", async () => {
    if (panel.dataset.submitting === "true") return;
    const csrf = sessionStorage.getItem("agent-team-csrf");
    if (!csrf) {
      status.textContent = "工作階段無法安全寫入，請重新啟動 UI。";
      return;
    }
    panel.dataset.submitting = "true";
    apply.disabled = true;
    cancel.disabled = true;
    status.textContent = "正在套用並 Read-back GitHub 設定…";
    try {
      const response = await fetch("/api/registration/github-policy", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({
          operation: "apply_github_policy",
          confirmationText: "套用 GitHub 合併保護",
          expectedRevision: panel.dataset.expectedRevision,
          confirmationToken: panel.dataset.confirmationToken,
        }),
      });
      if (!response.ok) {
        status.textContent =
          response.status === 409
            ? "GitHub 設定已改變，請重新載入後再確認。"
            : "尚未證明 GitHub Gate 完成；設定維持未完成。";
        delete panel.dataset.submitting;
        apply.disabled = false;
        cancel.disabled = false;
        return;
      }
      status.className = "alert alert-success";
      status.textContent = "GitHub 必要 Gate 已由 Read-back 確認。";
      confirmation.remove();
      review.remove();
      delete panel.dataset.confirmationToken;
    } catch {
      status.textContent = "無法完成 GitHub Read-back；設定維持未完成。";
      delete panel.dataset.submitting;
      apply.disabled = false;
      cancel.disabled = false;
    }
  });
})();
