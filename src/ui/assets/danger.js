/* global document */
(() => {
  "use strict";
  const status = document.getElementById("danger-status");
  const list = document.getElementById("danger-list");
  if (!status || !list) return;
  list.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-decision]");
    if (!button || button.disabled) return;
    const csrf = sessionStorage.getItem("agent-team-csrf");
    if (!csrf) {
      status.textContent = "工作階段無法安全寫入，請重新啟動 UI。";
      return;
    }
    const card = button.closest("[data-request-id]");
    if (!card) return;
    button.disabled = true;
    status.textContent = "正在記錄安全決策…";
    try {
      const response = await fetch("/api/danger", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({
          requestId: card.dataset.requestId,
          projectId: card.dataset.projectId,
          category: card.dataset.category,
          expectedRevision: card.dataset.revision,
          decision: button.dataset.decision,
        }),
      });
      if (!response.ok) {
        status.textContent =
          response.status === 409 ? "項目已更新，請重新載入。" : "安全決策未儲存。";
        button.disabled = false;
        return;
      }
      card.remove();
      status.textContent = "安全決策與稽核摘要已記錄。";
      if (!list.querySelector("[data-request-id]"))
        list.querySelector("[data-empty]")?.removeAttribute("hidden");
    } catch {
      status.textContent = "安全決策未儲存；請確認本機服務仍在執行。";
      button.disabled = false;
    }
  });
})();
