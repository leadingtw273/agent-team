import {
  safeRuntimeLabel,
  safeRuntimeSummary,
  type RuntimeBlock,
  type RuntimeCheckpointSummary,
  type RuntimeEffectiveProgress,
  type RuntimeStatusItem,
  type RuntimeStatusReadModel,
  type RuntimeWatchdogSummary,
} from "./model.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return character;
    }
  });
}

function text(value: string): string {
  return escapeHtml(safeRuntimeSummary(value));
}

function label(value: string): string {
  return escapeHtml(safeRuntimeLabel(value));
}

function statusLabel(state: RuntimeStatusItem["state"]): string {
  switch (state) {
    case "running":
      return "執行中";
    case "checkpointed":
      return "Checkpoint 已建立";
    case "blocked":
      return "已阻塞";
  }
}

function statusVariant(state: RuntimeStatusItem["state"]): "active" | "warning" | "error" {
  switch (state) {
    case "running":
      return "active";
    case "checkpointed":
      return "warning";
    case "blocked":
      return "error";
  }
}

function progressKindLabel(kind: RuntimeEffectiveProgress["kind"]): string {
  switch (kind) {
    case "controlled_git_diff":
      return "受控 Git Diff";
    case "test_or_build_milestone":
      return "測試／Build 里程碑";
    case "checkpoint_created":
      return "Checkpoint 已建立";
    case "narrowing_error_evidence":
      return "縮小問題範圍的新證據";
    case "distinct_solution_experiment":
      return "不同解法實驗";
  }
}

function watchdogDecisionLabel(decision: RuntimeWatchdogSummary["decision"]): string {
  switch (decision) {
    case "continue":
      return "持續監看";
    case "inspection_required":
      return "需要有效進度檢查";
    case "continue_once_extended":
      return "已允許一次 15 分鐘延長";
    case "checkpoint_and_replan":
      return "已 Checkpoint 並重新規劃";
    case "checkpoint_hard_stop":
      return "已到 60 分鐘硬邊界並停止";
  }
}

function checkpointReasonLabel(reason: RuntimeCheckpointSummary["reason"]): string {
  switch (reason) {
    case "quota_boundary":
      return "額度邊界";
    case "safety_pause":
      return "安全暫停";
    case "process_crash":
      return "Process 異常";
    case "human_handoff":
      return "真人接手";
    case "requirements_changed":
      return "需求已變更";
    case "watchdog_boundary":
      return "Watchdog 邊界";
    case "retry_exhausted":
      return "重試已用盡";
    case "manual":
      return "手動建立";
  }
}

function blockTitle(block: RuntimeBlock): string {
  switch (block.kind) {
    case "crash":
      return "Process 異常結束";
    case "quota":
      return "額度限制";
    case "danger_approval":
      return "等待危險操作核可";
    case "unknown":
      return "未知錯誤";
  }
}

function dangerCategoryLabel(
  category: Extract<RuntimeBlock, { kind: "danger_approval" }>["category"],
): string {
  switch (category) {
    case "project_destructive":
      return "專案破壞性操作";
    case "git_destructive":
      return "Git 破壞性操作";
    case "local_environment":
      return "本機環境變更";
    case "deployment":
      return "部署";
    case "external_write":
      return "外部寫入";
    case "secret_access":
      return "Secret 存取";
    case "paid_action":
      return "付費操作";
  }
}

function renderBlockDetails(block: RuntimeBlock): string {
  switch (block.kind) {
    case "crash":
      return `<p class="ui-runtime-detail">自動復航：${String(block.processRecoveriesUsed)} / ${String(block.processRecoveriesLimit)} 次</p>`;
    case "quota": {
      const quotaLabels = block.quotaWindows
        .map((window) => (window === "weekly" ? "週額度不足" : "5 小時額度限制"))
        .join(" · ");
      return `<p class="ui-runtime-detail">額度類型：${quotaLabels}</p>`;
    }
    case "danger_approval":
      return `<p class="ui-runtime-detail">危險操作類別：${dangerCategoryLabel(block.category)}</p>`;
    case "unknown":
      return `<p class="ui-runtime-detail">狀態：來源尚未可安全對帳，未顯示原始診斷內容。</p>`;
  }
}

function renderCheckpoint(checkpoint: RuntimeCheckpointSummary | undefined): string {
  if (checkpoint === undefined) {
    return `<section class="ui-runtime-section" aria-label="Checkpoint"><h3>Checkpoint</h3><p class="ui-runtime-empty">尚未建立 Checkpoint。</p></section>`;
  }

  return `<section class="ui-runtime-section" aria-label="Checkpoint">
    <h3>Checkpoint</h3>
    <dl class="ui-runtime-facts ui-runtime-facts--compact">
      <div><dt>ID</dt><dd><code>${escapeHtml(checkpoint.id)}</code></dd></div>
      <div><dt>原因</dt><dd>${checkpointReasonLabel(checkpoint.reason)}</dd></div>
      <div><dt>建立時間</dt><dd>${escapeHtml(checkpoint.createdAt)}</dd></div>
      <div><dt>完成／剩餘</dt><dd>${String(checkpoint.completedItemCount)} ／ ${String(checkpoint.remainingItemCount)} 項</dd></div>
      <div><dt>測試摘要</dt><dd>通過 ${String(checkpoint.testCounts.passed)} · 失敗 ${String(checkpoint.testCounts.failed)} · 未執行 ${String(checkpoint.testCounts.notRun)}</dd></div>
    </dl>
    <p class="ui-runtime-next"><span>Checkpoint 下一步</span>${text(checkpoint.nextStep)}</p>
  </section>`;
}

function renderProgress(progress: RuntimeEffectiveProgress | undefined): string {
  if (progress === undefined) {
    return `<section class="ui-runtime-section" aria-label="最後有效進度"><h3>最後有效進度</h3><p class="ui-runtime-empty">尚無可驗證的有效進度；心跳、模型輸出與命令執行不算進度。</p></section>`;
  }

  return `<section class="ui-runtime-section" aria-label="最後有效進度">
    <h3>最後有效進度</h3>
    <p class="ui-runtime-progress-kind">${progressKindLabel(progress.kind)} · ${escapeHtml(progress.occurredAt)}</p>
    <p class="ui-runtime-summary">${text(progress.summary)}</p>
  </section>`;
}

function renderWatchdog(watchdog: RuntimeWatchdogSummary): string {
  const elapsed = Number.isFinite(watchdog.elapsedMinutes)
    ? Math.max(0, Math.floor(watchdog.elapsedMinutes))
    : 0;
  const inspectionStatus =
    elapsed < 45 ? "尚未到達" : watchdog.decision === "inspection_required" ? "等待評估" : "已評估";
  const hardStopStatus =
    elapsed < 60 ? `尚餘 ${String(60 - elapsed)} 分鐘` : "已到達；必須 Checkpoint 並停止";

  return `<section class="ui-runtime-section" aria-label="Watchdog 時間界線">
    <h3>Watchdog</h3>
    <dl class="ui-runtime-facts ui-runtime-facts--compact">
      <div><dt>已執行</dt><dd>${String(elapsed)} 分鐘</dd></div>
      <div><dt>45 分鐘檢查</dt><dd>${inspectionStatus}</dd></div>
      <div><dt>60 分鐘硬邊界</dt><dd>${hardStopStatus}</dd></div>
      <div><dt>目前決策</dt><dd>${watchdogDecisionLabel(watchdog.decision)}</dd></div>
      <div><dt>一次延長</dt><dd>${watchdog.extensionGranted ? "已使用／有效" : "尚未使用"}</dd></div>
    </dl>
  </section>`;
}

function renderBlock(block: RuntimeBlock | undefined): string {
  if (block === undefined) {
    return `<section class="ui-runtime-section" aria-label="阻塞原因"><h3>阻塞原因</h3><p class="ui-runtime-empty">目前沒有已知阻塞原因。</p></section>`;
  }

  return `<section class="ui-runtime-section ui-runtime-block ui-runtime-block--${block.kind}" aria-label="阻塞原因">
    <h3>阻塞原因</h3>
    <p class="ui-runtime-block-title">${blockTitle(block)}</p>
    <p class="ui-runtime-summary">${text(block.summary)}</p>
    ${renderBlockDetails(block)}
    <p class="ui-runtime-next"><span>建議處置</span>${text(block.nextStep)}</p>
  </section>`;
}

function renderRuntimeStatus(item: RuntimeStatusItem, index: number): string {
  const headingId = `runtime-status-${String(index + 1)}`;
  return `<article class="card ui-runtime-card" aria-labelledby="${headingId}">
    <div class="card-body">
      <div class="ui-runtime-card-header">
        <div>
          <p class="ui-runtime-card-eyebrow">${label(item.roleModel.role)} · ${label(item.roleModel.provider)} / ${label(item.roleModel.model)}</p>
          <h2 id="${headingId}">${escapeHtml(item.job.issueId)}</h2>
        </div>
        <span class="badge ui-status-badge ui-status--${statusVariant(item.state)}"><span class="ui-status-dot" aria-hidden="true"></span>${statusLabel(item.state)}</span>
      </div>
      <dl class="ui-runtime-facts">
        <div><dt>工作 ID</dt><dd><code>${escapeHtml(item.job.id)}</code></dd></div>
        <div><dt>專案</dt><dd><code>${escapeHtml(item.job.projectId)}</code></dd></div>
        <div><dt>開始時間</dt><dd>${escapeHtml(item.job.startedAt)}</dd></div>
        <div><dt>租約</dt><dd><code>${escapeHtml(item.lease.id)}</code> · ${item.lease.state === "active" ? "有效" : item.lease.state === "expired" ? "已過期" : "已釋放"}</dd></div>
        <div><dt>租約到期</dt><dd>${escapeHtml(item.lease.expiresAt)}</dd></div>
      </dl>
      <section class="ui-runtime-section" aria-label="嘗試次數">
        <h3>嘗試次數</h3>
        <ul class="ui-runtime-attempts">
          <li>Crash 復航 ${String(item.attempts.processRecoveries)} / 1</li>
          <li>CI 修正 ${String(item.attempts.ciFixRounds)} / 2</li>
          <li>Reviewer 修正 ${String(item.attempts.reviewerFixRounds)} / 2</li>
          <li>完整審查 ${String(item.attempts.reviewRuns)} / 3</li>
        </ul>
      </section>
      ${renderProgress(item.lastEffectiveProgress)}
      ${renderWatchdog(item.watchdog)}
      ${renderCheckpoint(item.checkpoint)}
      ${renderBlock(item.block)}
      <section class="ui-runtime-section ui-runtime-next-step" aria-label="下一步">
        <h3>下一步</h3><p>${text(item.nextStep)}</p>
      </section>
    </div>
  </article>`;
}

/** Renders U007's standalone, read-only Runtime Status content inside the common shell. */
export function renderRuntimeStatusPage(readModel: RuntimeStatusReadModel): string {
  const statuses = readModel.listRuntimeStatuses();
  const sourceNotice =
    readModel.source === "fixture"
      ? `<aside class="ui-fixture-notice" aria-label="資料來源說明"><span>Runtime Status 示範資料，尚未連接 Runtime。</span></aside>`
      : "";

  return `${sourceNotice}
    <aside class="ui-runtime-safety-notice" aria-label="顯示範圍說明">本頁僅顯示經摘要化的 Job、Lease、Checkpoint 與阻塞資訊；不顯示完整命令、Secret 或模型隱藏推理。</aside>
    <section class="ui-runtime-overview" aria-labelledby="runtime-status-summary-title">
      <div><h2 id="runtime-status-summary-title">執行中、Checkpoint 與阻塞</h2><p>依 C012 Watchdog 與 C013 Reconcile 的唯讀安全摘要，供恢復與診斷時判讀。</p></div>
      <p class="ui-runtime-count" aria-label="工作數量">${String(statuses.length)} 項工作</p>
    </section>
    <div class="ui-runtime-grid" aria-label="Runtime 工作狀態">
      ${
        statuses.length === 0
          ? `<section class="card ui-panel"><div class="card-body"><p class="ui-runtime-empty">目前沒有可顯示的執行中、Checkpoint 或阻塞工作。</p></div></section>`
          : statuses.map(renderRuntimeStatus).join("")
      }
    </div>`;
}
