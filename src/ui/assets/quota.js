(() => {
  "use strict";
  const endpoints = Object.freeze({
    refresh: "/api/quota/refresh",
    resume: "/api/quota/resume",
  });
  const successMessages = Object.freeze({
    refresh_sample: "刷新樣本已完成 read-back。",
    resume_dispatch: "手動覆核已記錄；恢復派工狀態已 read-back。",
  });

  async function csrfToken() {
    const stored = sessionStorage.getItem("agent-team-csrf");
    if (stored) return stored;
    const response = await fetch("/__session/csrf", {
      method: "GET",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("csrf-unavailable");
    const token = response.headers.get("x-csrf-token");
    if (!token) throw new Error("csrf-unavailable");
    sessionStorage.setItem("agent-team-csrf", token);
    return token;
  }

  document.addEventListener("click", async (event) => {
    const source = event.target;
    if (!(source instanceof Element)) return;
    const button = source.closest("button[data-quota-action][data-quota-provider]");
    if (!(button instanceof HTMLButtonElement)) return;
    const action = button.dataset.quotaAction;
    const provider = button.dataset.quotaProvider;
    const endpoint = action ? endpoints[action] : undefined;
    if (!endpoint || !provider) return;
    const status = document.getElementById(`quota-${provider}-action-status`);
    button.disabled = true;
    if (status) status.textContent = "處理中…";
    try {
      const csrf = await csrfToken();
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ provider }),
      });
      const result = await response.json();
      const message =
        result && typeof result.action === "string" ? successMessages[result.action] : undefined;
      if (!response.ok || !message) throw new Error("action-rejected");
      if (status) {
        status.textContent = message;
        status.dataset.state = "accepted";
      }
    } catch {
      if (status) {
        status.textContent = "動作未完成；額度狀態沒有被假定為可用。";
        status.dataset.state = "rejected";
      }
    } finally {
      button.disabled = false;
    }
  });
})();
