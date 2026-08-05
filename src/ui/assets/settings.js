/* global document */
(() => {
  "use strict";
  const form = document.getElementById("settings-form");
  const editor = document.getElementById("settings-raw-yaml");
  const editButton = document.getElementById("settings-edit");
  const cancelButton = document.getElementById("settings-cancel");
  const saveButton = document.getElementById("settings-save");
  const status = document.getElementById("settings-status");
  if (!form || !editor || !editButton || !cancelButton || !saveButton || !status) return;

  const setEditing = (editing) => {
    form.dataset.editing = editing ? "true" : "false";
    editor.readOnly = !editing;
    editButton.hidden = editing;
    cancelButton.hidden = !editing;
    saveButton.hidden = !editing;
    saveButton.disabled = !editing;
    if (editing) editor.focus();
  };
  const message = (text) => {
    status.textContent = text;
  };

  editButton.addEventListener("click", () => {
    message("受控編輯已啟用；儲存前會重新驗證完整設定。");
    setEditing(true);
  });
  cancelButton.addEventListener("click", () => {
    editor.value = form.dataset.persistedYaml || "";
    message("已取消編輯。");
    setEditing(false);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.editing !== "true") return;
    const csrf = sessionStorage.getItem("agent-team-csrf");
    if (!csrf) {
      message("工作階段無法安全寫入，請重新啟動 UI。");
      return;
    }
    saveButton.disabled = true;
    message("正在驗證並儲存…");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({
          expectedRevision: form.dataset.revision || null,
          rawYaml: editor.value,
        }),
      });
      const result = await response.json();
      if (!response.ok || result.state !== "ready") {
        message(
          response.status === 409
            ? "設定已被其他頁籤更新，請重新載入。"
            : "設定未儲存；內容未通過安全驗證。",
        );
        saveButton.disabled = false;
        return;
      }
      editor.value = result.rawYaml;
      form.dataset.persistedYaml = result.rawYaml;
      form.dataset.revision = result.revision || "";
      const values = {
        "settings-webhook-url": result.webhookRuntimeBaseUrl || "尚未設定",
        "settings-global-jobs": result.concurrency.globalModelJobs,
        "settings-project-jobs": result.concurrency.perProjectModelJobs,
        "settings-codex-jobs": result.concurrency.perProviderModelJobs.codex,
        "settings-claude-jobs": result.concurrency.perProviderModelJobs.claude,
        "settings-gemini-jobs": result.concurrency.perProviderModelJobs.gemini,
      };
      for (const [id, value] of Object.entries(values)) {
        const input = document.getElementById(id);
        if (input) input.value = String(value);
      }
      message("設定已安全儲存。");
      setEditing(false);
    } catch {
      message("設定未儲存；請確認本機服務仍在執行。");
      saveButton.disabled = false;
    }
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && form.dataset.editing === "true") {
      event.preventDefault();
      cancelButton.click();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (form.dataset.editing === "true") form.requestSubmit();
    }
  });
  setEditing(false);
})();
