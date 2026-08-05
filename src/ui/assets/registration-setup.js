/* global document, HTMLElement, HTMLButtonElement, HTMLInputElement */
(() => {
  "use strict";

  const section = document.querySelector("#registration-setup-section");
  if (!(section instanceof HTMLElement)) return;
  const status = section.querySelector(".js-registration-setup-status");
  const setupSessionId = section.dataset.setupSessionId;
  const previewDigest = section.dataset.previewDigest;
  const operationId = () => `setup-ui-${crypto.randomUUID()}`;
  let previewTokenId;

  const send = async (body) => {
    const csrf = sessionStorage.getItem("agent-team-csrf");
    if (!csrf) throw new Error("missing_csrf");
    const response = await fetch("/api/registration/setup", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(String(result.state ?? "setup_failed"));
    return result;
  };

  const setStatus = (message) => {
    if (status instanceof HTMLElement) status.textContent = message;
  };

  const confirmation = section.querySelector(".js-registration-setup-confirmation");
  const confirmButton = section.querySelector(".js-registration-setup-confirm");
  const startButton = section.querySelector(".js-registration-setup-start");
  if (
    confirmation instanceof HTMLInputElement &&
    confirmButton instanceof HTMLButtonElement &&
    startButton instanceof HTMLButtonElement &&
    setupSessionId &&
    previewDigest
  ) {
    confirmButton.addEventListener("click", async () => {
      if (confirmation.value !== "CREATE SETUP DRAFT PR") {
        setStatus("確認文字不符；未簽發 token，也不會建立 Draft PR。");
        return;
      }
      confirmButton.disabled = true;
      try {
        const result = await send({
          action: "confirm_preview",
          setupSessionId,
          previewDigest,
          confirmation: confirmation.value,
          operationId: operationId(),
        });
        if (result.state !== "preview_confirmation_issued") throw new Error("not_issued");
        previewTokenId = result.tokenId;
        startButton.disabled = false;
        setStatus("一次性 Preview 確認已簽發；第二步才會建立 Draft PR。");
      } catch {
        setStatus("無法安全簽發 Preview 確認；未建立 Draft PR。");
        confirmButton.disabled = false;
      }
    });
    startButton.addEventListener("click", async () => {
      if (!previewTokenId) return;
      startButton.disabled = true;
      try {
        const result = await send({
          action: "start",
          setupSessionId,
          previewDigest,
          tokenId: previewTokenId,
          operationId: operationId(),
        });
        setStatus(
          result.state === "ci_waiting"
            ? "Setup Draft PR 已建立；等待 CI 與 Fresh Review。"
            : "Setup start 尚未完成；請重新整理 authoritative state。",
        );
      } catch {
        setStatus("Setup start 失敗；token 不會被當成合併核可，請重新整理。 ");
      }
    });
  }

  const refreshButton = section.querySelector(".js-registration-setup-refresh");
  if (refreshButton instanceof HTMLButtonElement && setupSessionId) {
    refreshButton.addEventListener("click", async () => {
      refreshButton.disabled = true;
      try {
        const result = await send({
          action: "refresh",
          setupSessionId,
          operationId: operationId(),
        });
        setStatus(`已 read-back Setup gate：${String(result.state)}。請重新整理頁面取得完整證據。`);
      } catch {
        setStatus("無法 read-back CI／Fresh Review；舊證據不會被當成通過。");
        refreshButton.disabled = false;
      }
    });
  }

  const approvalInput = section.querySelector(".js-registration-setup-approval");
  const approvalButton = section.querySelector(".js-registration-setup-approval-intent");
  const expectedSetupRevision = Number(section.dataset.setupRevision);
  if (
    approvalInput instanceof HTMLInputElement &&
    approvalButton instanceof HTMLButtonElement &&
    setupSessionId &&
    Number.isSafeInteger(expectedSetupRevision)
  ) {
    approvalButton.addEventListener("click", async () => {
      if (approvalInput.value !== "APPROVE SETUP MERGE") {
        setStatus("核可文字不符；未簽發 local-UI approval intent。");
        return;
      }
      approvalButton.disabled = true;
      try {
        const result = await send({
          action: "issue_approval_intent",
          setupSessionId,
          expectedSetupRevision,
          confirmation: approvalInput.value,
          operationId: operationId(),
        });
        if (result.state !== "approval_intent_issued") throw new Error("not_issued");
        setStatus("本機核可 intent 已保存；W3A 仍不會合併、寫稽核或啟用設定。");
      } catch {
        setStatus("核可 intent 未簽發；merge 仍保持 configuration_incomplete。");
        approvalButton.disabled = false;
      }
    });
  }
})();
