/* global document, HTMLElement, HTMLButtonElement, HTMLInputElement */
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

  for (const panel of section.querySelectorAll(".js-linear-manual")) {
    if (!(panel instanceof HTMLElement)) continue;
    const input = panel.querySelector(".js-linear-manual-id");
    const previewButton = panel.querySelector(".js-linear-manual-preview");
    const manualConfirmation = panel.querySelector(".js-linear-manual-confirmation");
    const manualConfirm = panel.querySelector(".js-linear-manual-confirm");
    const manualCancel = panel.querySelector(".js-linear-manual-cancel");
    const manualStatus = panel.querySelector(".js-linear-manual-status");
    if (
      !(input instanceof HTMLInputElement) ||
      !(previewButton instanceof HTMLButtonElement) ||
      !(manualConfirmation instanceof HTMLElement) ||
      !(manualConfirm instanceof HTMLButtonElement) ||
      !(manualCancel instanceof HTMLButtonElement) ||
      !(manualStatus instanceof HTMLElement)
    ) {
      continue;
    }

    const closeManual = () => {
      manualConfirmation.hidden = true;
      input.disabled = false;
      previewButton.disabled = false;
      delete panel.dataset.expectedRevision;
      delete panel.dataset.confirmationToken;
      manualStatus.textContent = "已取消；尚未保存 ID 綁定。";
      previewButton.focus();
    };

    previewButton.addEventListener("click", async () => {
      const csrf = sessionStorage.getItem("agent-team-csrf");
      const logicalKey = panel.dataset.logicalKey;
      const remoteId = input.value.trim();
      if (!csrf || !logicalKey || !remoteId) {
        manualStatus.textContent = "請輸入 Linear 物件 ID；安全工作階段失效時請重新開啟本機 UI。";
        return;
      }
      previewButton.disabled = true;
      manualStatus.textContent = "正在按 ID 做 authoritative read-back…";
      try {
        const response = await fetch("/api/registration/linear-provision", {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({ operation: "preview_manual_readback", logicalKey, remoteId }),
        });
        const body = await response.json();
        if (
          !response.ok ||
          body.state !== "manual_preview" ||
          typeof body.expectedRevision !== "string" ||
          typeof body.confirmationToken !== "string"
        ) {
          throw new Error("manual_preview_failed");
        }
        panel.dataset.expectedRevision = body.expectedRevision;
        panel.dataset.confirmationToken = body.confirmationToken;
        input.disabled = true;
        manualConfirmation.hidden = false;
        manualStatus.textContent = "ID 已核對；請做第二步確認。";
        manualConfirm.focus();
      } catch {
        previewButton.disabled = false;
        manualStatus.textContent = "ID 無法安全核對；未保存任何綁定。";
      }
    });

    manualCancel.addEventListener("click", closeManual);
    manualConfirmation.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeManual();
    });
    manualConfirm.addEventListener("click", async () => {
      const csrf = sessionStorage.getItem("agent-team-csrf");
      const logicalKey = panel.dataset.logicalKey;
      const expectedRevision = panel.dataset.expectedRevision;
      const confirmationToken = panel.dataset.confirmationToken;
      const remoteId = input.value.trim();
      if (!csrf || !logicalKey || !expectedRevision || !confirmationToken || !remoteId) {
        manualStatus.textContent = "確認內容已過期；請取消後重新預覽。";
        return;
      }
      manualConfirm.disabled = true;
      manualCancel.disabled = true;
      manualStatus.textContent = "正在保存已核對的 ID 綁定…";
      try {
        const response = await fetch("/api/registration/linear-provision", {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({
            operation: "confirm_manual_readback",
            logicalKey,
            remoteId,
            expectedRevision,
            confirmationToken,
            confirmationText: "確認 Linear ID read-back",
          }),
        });
        const body = await response.json();
        if (!response.ok || body.state !== "manual_applied") {
          throw new Error("manual_readback_failed");
        }
        manualConfirmation.hidden = true;
        manualStatus.textContent = "已保存 Linear ID read-back；本頁其他預覽已過期，請重新整理。";
      } catch {
        manualStatus.textContent = "未能安全保存；此 ID 不會被視為已綁定。請重新預覽。";
        manualConfirm.disabled = false;
        manualCancel.disabled = false;
      }
    });
  }

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
