/* global document */
(() => {
  "use strict";
  const status = document.getElementById("danger-status");
  const list = document.getElementById("danger-list");
  if (!status || !list) return;

  const confirmationTriggers = new WeakMap();

  const setButtonsDisabled = (card, disabled) => {
    for (const button of card.querySelectorAll("button")) button.disabled = disabled;
  };

  const closeConfirmation = (card, restoreFocus) => {
    const panel = card.querySelector("[data-confirmation]");
    if (!panel) return;
    panel.hidden = true;
    delete panel.dataset.pendingDecision;
    if (restoreFocus) confirmationTriggers.get(card)?.focus();
  };

  const openConfirmation = (card, trigger, decision) => {
    const panel = card.querySelector("[data-confirmation]");
    const title = panel?.querySelector("[data-confirm-title]");
    const message = panel?.querySelector("[data-confirm-message]");
    const confirm = panel?.querySelector("[data-confirm-submit]");
    if (!panel || !title || !message || !confirm || !panel.hidden) return;
    confirmationTriggers.set(card, trigger);
    panel.dataset.pendingDecision = decision;
    if (decision === "approve_once") {
      title.textContent = "確認核可一次";
      message.textContent = "這項核可只適用於目前顯示的專案、類別與版本。";
      confirm.textContent = "確認核可一次";
    } else {
      title.textContent = "確認此專案長期允許此類別";
      message.textContent =
        "⚠ 長期允許後，之後相同專案與類別的請求會直接命中允許；請核對下列摘要。";
      confirm.textContent = "確認長期允許";
    }
    panel.hidden = false;
    confirm.focus();
  };

  const submitDecision = async (card, decision) => {
    if (card.dataset.submitting === "true") return;
    const csrf = sessionStorage.getItem("agent-team-csrf");
    if (!csrf) {
      status.textContent = "工作階段無法安全寫入，請重新啟動 UI。";
      return;
    }
    card.dataset.submitting = "true";
    setButtonsDisabled(card, true);
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
          decision,
        }),
      });
      if (!response.ok) {
        status.textContent =
          response.status === 409 ? "項目已更新，請重新載入。" : "安全決策未儲存。";
        delete card.dataset.submitting;
        setButtonsDisabled(card, false);
        closeConfirmation(card, decision !== "reject");
        return;
      }
      card.remove();
      status.textContent = "安全決策與稽核摘要已記錄。";
      if (!list.querySelector("[data-request-id]"))
        list.querySelector("[data-empty]")?.removeAttribute("hidden");
    } catch {
      status.textContent = "安全決策未儲存；請確認本機服務仍在執行。";
      delete card.dataset.submitting;
      setButtonsDisabled(card, false);
      closeConfirmation(card, decision !== "reject");
    }
  };

  list.addEventListener("click", (event) => {
    const target = event.target;
    const card = target.closest?.("[data-request-id]");
    if (!card || card.dataset.submitting === "true") return;

    const cancel = target.closest?.("button[data-confirm-cancel]");
    if (cancel && !cancel.disabled) {
      closeConfirmation(card, true);
      return;
    }

    const confirm = target.closest?.("button[data-confirm-submit]");
    if (confirm && !confirm.disabled) {
      const decision = confirm.closest("[data-confirmation]")?.dataset.pendingDecision;
      if (decision === "approve_once" || decision === "allow_project_category") {
        void submitDecision(card, decision);
      }
      return;
    }

    const button = target.closest?.("button[data-decision]");
    if (!button || button.disabled) return;
    const decision = button.dataset.decision;
    if (decision === "reject") {
      void submitDecision(card, decision);
      return;
    }
    if (decision === "approve_once" || decision === "allow_project_category") {
      openConfirmation(card, button, decision);
    }
  });

  list.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const card = event.target.closest?.("[data-request-id]");
    const panel = card?.querySelector("[data-confirmation]");
    if (!card || !panel || panel.hidden || card.dataset.submitting === "true") return;
    event.preventDefault();
    closeConfirmation(card, true);
  });
})();
