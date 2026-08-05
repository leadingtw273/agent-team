/* global document, HTMLElement, HTMLButtonElement */
(() => {
  "use strict";

  const section = document.getElementById("linear-provision-section");
  if (!(section instanceof HTMLElement)) return;
  const reviewButton = section.querySelector(".js-linear-review");
  const confirmation = section.querySelector(".js-linear-confirmation");
  const confirmButton = section.querySelector(".js-linear-confirm");
  const cancelButton = section.querySelector(".js-linear-cancel");
  const status = section.querySelector(".js-linear-status");
  if (
    !(reviewButton instanceof HTMLButtonElement) ||
    !(confirmation instanceof HTMLElement) ||
    !(confirmButton instanceof HTMLButtonElement) ||
    !(cancelButton instanceof HTMLButtonElement) ||
    !(status instanceof HTMLElement)
  ) {
    return;
  }

  const closeConfirmation = () => {
    confirmation.hidden = true;
    reviewButton.disabled = false;
    reviewButton.focus();
  };

  reviewButton.addEventListener("click", () => {
    confirmation.hidden = false;
    reviewButton.disabled = true;
    status.textContent = "請再次確認；此步驟才會送出建立操作。";
    confirmButton.focus();
  });
  cancelButton.addEventListener("click", closeConfirmation);
  confirmation.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeConfirmation();
  });

  confirmButton.addEventListener("click", async () => {
    const expectedRevision = section.dataset.expectedRevision;
    const confirmationToken = section.dataset.confirmationToken;
    const csrf = sessionStorage.getItem("agent-team-csrf");
    if (!expectedRevision || !confirmationToken || !csrf) {
      status.textContent = "安全工作階段已失效，請重新開啟本機 UI。";
      return;
    }
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    status.textContent = "正在套用並逐項 read-back…";
    try {
      const response = await fetch("/api/registration/linear-provision", {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({
          operation: "provision",
          expectedRevision,
          confirmationToken,
          confirmationText: "套用 Linear 設定",
        }),
      });
      const body = await response.json();
      if (!response.ok || body.state !== "applied") throw new Error("provision_failed");
      const createdCount = Number.isSafeInteger(body.createdCount) ? body.createdCount : 0;
      status.textContent = `已建立並 read-back ${String(createdCount)} 項；本頁預覽已過期，請重新整理；人工項目仍保持未完成。`;
      confirmation.hidden = true;
    } catch {
      status.textContent = "未能安全套用；沒有任何項目會因失敗回應而被視為完成。請重新預覽。";
      confirmButton.disabled = false;
      cancelButton.disabled = false;
    }
  });
})();
