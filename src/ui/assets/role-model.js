(() => {
  "use strict";

  const saveButton = document.querySelector("[data-role-model-save]");
  const status = document.querySelector("[data-role-model-status]");
  const lists = Array.from(document.querySelectorAll("[data-role-model-list]"));
  let draggedCandidate = null;

  const setStatus = (message, state = "") => {
    if (!(status instanceof HTMLElement)) return;
    status.textContent = message;
    if (state === "") status.removeAttribute("data-state");
    else status.dataset.state = state;
  };

  const candidates = (list) => Array.from(list.querySelectorAll(":scope > [data-candidate-key]"));
  const validationErrors = new Set([
    "invalid_input",
    "unknown_candidate",
    "candidate_not_available_for_role",
  ]);

  const responseError = async (response) => {
    try {
      const payload = await response.json();
      return typeof payload === "object" && payload !== null && typeof payload.error === "string"
        ? payload.error
        : undefined;
    } catch {
      return undefined;
    }
  };

  const updateMoveButton = (button, name, direction, isBoundary) => {
    if (!(button instanceof HTMLButtonElement)) return;
    const actionLabel = direction === "up" ? "上移" : "下移";
    const boundaryLabel = direction === "up" ? "已在最上" : "已在最下";
    button.disabled = isBoundary;
    button.classList.toggle("ui-role-model-action--boundary", isBoundary);
    button.textContent = isBoundary ? boundaryLabel : actionLabel;
    button.setAttribute(
      "aria-label",
      isBoundary ? `${name} ${boundaryLabel}` : `將 ${name} ${actionLabel}`,
    );
  };

  const updateControls = (list) => {
    const items = candidates(list);
    items.forEach((item, index) => {
      const order = item.querySelector("[data-candidate-order]");
      if (order !== null) order.textContent = String(index + 1);
      const up = item.querySelector('[data-role-model-move="up"]');
      const down = item.querySelector('[data-role-model-move="down"]');
      const name = item.getAttribute("data-candidate-name") ?? "候選模型";
      updateMoveButton(up, name, "up", index === 0);
      updateMoveButton(down, name, "down", index === items.length - 1);
    });
  };

  const markChanged = () => setStatus("順序已變更；尚未儲存。");

  const moveCandidate = (item, direction) => {
    const list = item.parentElement;
    if (!(list instanceof HTMLOListElement)) return;
    if (direction === "up" && item.previousElementSibling !== null) {
      list.insertBefore(item, item.previousElementSibling);
    } else if (direction === "down" && item.nextElementSibling !== null) {
      list.insertBefore(item.nextElementSibling, item);
    } else {
      return;
    }
    updateControls(list);
    item.focus();
    markChanged();
  };

  const splitCandidateKey = (value) => {
    const separator = value.indexOf(":");
    if (separator < 1 || separator === value.length - 1) throw new Error("invalid candidate");
    return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
  };

  const currentConfig = () => ({
    schemaVersion: 1,
    routes: lists.map((list) => ({
      role: list.getAttribute("data-role-model-list"),
      candidates: candidates(list).map((item) =>
        splitCandidateKey(item.getAttribute("data-candidate-key") ?? ""),
      ),
    })),
  });

  const applyReadBack = (snapshot) => {
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      !Array.isArray(snapshot.config?.routes)
    ) {
      throw new Error("invalid read-back");
    }
    for (const route of snapshot.config.routes) {
      const list = lists.find(
        (candidateList) => candidateList.getAttribute("data-role-model-list") === route.role,
      );
      if (!(list instanceof HTMLOListElement) || !Array.isArray(route.candidates)) {
        throw new Error("invalid read-back route");
      }
      const byKey = new Map(
        candidates(list).map((item) => [item.getAttribute("data-candidate-key"), item]),
      );
      for (const candidate of route.candidates) {
        const item = byKey.get(`${candidate.provider}:${candidate.model}`);
        if (!(item instanceof HTMLElement)) throw new Error("unknown read-back candidate");
        list.append(item);
      }
      updateControls(list);
    }
  };

  for (const list of lists) {
    updateControls(list);
    list.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest("[data-role-model-move]");
      const item = button?.closest("[data-candidate-key]");
      if (!(button instanceof HTMLButtonElement) || !(item instanceof HTMLElement)) return;
      moveCandidate(item, button.dataset.roleModelMove);
    });
    list.addEventListener("dragstart", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches("[data-candidate-key]")) return;
      draggedCandidate = target;
      target.classList.add("is-dragging");
      event.dataTransfer?.setData("text/plain", target.dataset.candidateKey ?? "");
      if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
    });
    list.addEventListener("dragover", (event) => {
      if (draggedCandidate === null || draggedCandidate.parentElement !== list) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
    });
    list.addEventListener("drop", (event) => {
      event.preventDefault();
      const target = event.target;
      const destination = target instanceof Element ? target.closest("[data-candidate-key]") : null;
      if (
        !(draggedCandidate instanceof HTMLElement) ||
        !(destination instanceof HTMLElement) ||
        destination === draggedCandidate ||
        destination.parentElement !== list
      ) {
        return;
      }
      const items = candidates(list);
      const draggedIndex = items.indexOf(draggedCandidate);
      const destinationIndex = items.indexOf(destination);
      if (draggedIndex < 0 || destinationIndex < 0) return;
      const insertionPoint =
        draggedIndex < destinationIndex ? destination.nextSibling : destination;
      list.insertBefore(draggedCandidate, insertionPoint);
      updateControls(list);
      draggedCandidate.focus();
      markChanged();
    });
    list.addEventListener("dragend", () => {
      if (draggedCandidate instanceof HTMLElement) draggedCandidate.classList.remove("is-dragging");
      draggedCandidate = null;
    });
  }

  if (!(saveButton instanceof HTMLButtonElement)) return;
  const csrf = sessionStorage.getItem("agent-team-csrf");
  if (csrf === null) {
    setStatus("安全工作階段已鎖定，請重新開啟本機 UI。", "error");
    return;
  }

  saveButton.disabled = false;
  setStatus("可調整順位；設定只會套用到新 Job。");
  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    setStatus("儲存並讀回確認中…");
    try {
      const saved = await fetch("/api/role-models", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(currentConfig()),
      });
      if (!saved.ok) {
        const error = await responseError(saved);
        if (error === "read_back_mismatch") {
          setStatus("儲存結果無法確認，請重新載入核對。", "uncertain");
        } else if (saved.status === 422 && validationErrors.has(error)) {
          setStatus("輸入驗證失敗；原設定未被覆寫。請修正後再試。", "error");
        } else {
          setStatus("儲存失敗；無法確認目前設定，請重新載入核對。", "uncertain");
        }
        return;
      }
      const readBack = await fetch("/api/role-models", {
        method: "GET",
        credentials: "same-origin",
      });
      if (!readBack.ok) {
        setStatus("儲存已送出，但讀回失敗；請重新載入核對。", "uncertain");
        return;
      }
      applyReadBack(await readBack.json());
      setStatus("已儲存並讀回目前設定。", "success");
    } catch {
      setStatus("儲存結果無法確認，請重新載入核對。", "uncertain");
    } finally {
      saveButton.disabled = false;
    }
  });
})();
