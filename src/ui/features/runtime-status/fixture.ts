import {
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../../domain/foundation/index.js";
import type { Job, Lease } from "../../../domain/jobs/index.js";

import type {
  RuntimeCheckpointSummary,
  RuntimeQuotaWindow,
  RuntimeStatusItem,
  RuntimeStatusReadModel,
} from "./model.js";

function identifier<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(`Invalid ${scope} fixture identifier.`);
  return parsed.value;
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error("Invalid runtime status fixture timestamp.");
  return parsed.value;
}

function checkpoint(
  id: string,
  createdAt: string,
  reason: RuntimeCheckpointSummary["reason"],
  completedItemCount: number,
  remainingItemCount: number,
  nextStep: string,
): RuntimeCheckpointSummary {
  return Object.freeze({
    id: identifier("checkpoint", id),
    createdAt: instant(createdAt),
    reason,
    completedItemCount,
    remainingItemCount,
    testCounts: Object.freeze({ passed: 18, failed: 0, notRun: 1 }),
    nextStep,
  });
}

const crashJob = Object.freeze({
  schemaVersion: 1,
  id: identifier("job", "job_11111111-1111-5111-8111-111111111111"),
  projectId: identifier("project", "project_11111111-1111-5111-8111-111111111111"),
  issueId: identifier("issue", "issue_11111111-1111-5111-8111-111111111111"),
  createdAt: instant("2026-08-05T06:00:00.000Z"),
  startedAt: instant("2026-08-05T06:02:00.000Z"),
  watchdogExtensionGranted: false,
  attempts: Object.freeze({
    processRecoveries: 1,
    ciFixRounds: 0,
    reviewerFixRounds: 0,
    reviewRuns: 0,
  }),
} satisfies Job);

const quotaJob = Object.freeze({
  schemaVersion: 1,
  id: identifier("job", "job_22222222-2222-5222-8222-222222222222"),
  projectId: identifier("project", "project_22222222-2222-5222-8222-222222222222"),
  issueId: identifier("issue", "issue_22222222-2222-5222-8222-222222222222"),
  createdAt: instant("2026-08-05T05:00:00.000Z"),
  startedAt: instant("2026-08-05T05:02:00.000Z"),
  watchdogExtensionGranted: true,
  attempts: Object.freeze({
    processRecoveries: 0,
    ciFixRounds: 1,
    reviewerFixRounds: 0,
    reviewRuns: 1,
  }),
} satisfies Job);

const dangerJob = Object.freeze({
  schemaVersion: 1,
  id: identifier("job", "job_33333333-3333-5333-8333-333333333333"),
  projectId: identifier("project", "project_33333333-3333-5333-8333-333333333333"),
  issueId: identifier("issue", "issue_33333333-3333-5333-8333-333333333333"),
  createdAt: instant("2026-08-05T06:18:00.000Z"),
  startedAt: instant("2026-08-05T06:20:00.000Z"),
  watchdogExtensionGranted: false,
  attempts: Object.freeze({
    processRecoveries: 0,
    ciFixRounds: 0,
    reviewerFixRounds: 1,
    reviewRuns: 2,
  }),
} satisfies Job);

const unknownJob = Object.freeze({
  schemaVersion: 1,
  id: identifier("job", "job_44444444-4444-5444-8444-444444444444"),
  projectId: identifier("project", "project_44444444-4444-5444-8444-444444444444"),
  issueId: identifier("issue", "issue_44444444-4444-5444-8444-444444444444"),
  createdAt: instant("2026-08-05T05:12:00.000Z"),
  startedAt: instant("2026-08-05T05:14:00.000Z"),
  watchdogExtensionGranted: true,
  attempts: Object.freeze({
    processRecoveries: 0,
    ciFixRounds: 2,
    reviewerFixRounds: 2,
    reviewRuns: 3,
  }),
} satisfies Job);

const leases = Object.freeze({
  crash: Object.freeze({
    schemaVersion: 1,
    id: identifier("lease", "lease_11111111-1111-5111-8111-111111111111"),
    jobId: crashJob.id,
    issueId: crashJob.issueId,
    holderId: "controller-a",
    acquiredAt: instant("2026-08-05T06:02:00.000Z"),
    expiresAt: instant("2026-08-05T06:37:00.000Z"),
    releasedAt: instant("2026-08-05T06:18:00.000Z"),
  } satisfies Lease),
  quota: Object.freeze({
    schemaVersion: 1,
    id: identifier("lease", "lease_22222222-2222-5222-8222-222222222222"),
    jobId: quotaJob.id,
    issueId: quotaJob.issueId,
    holderId: "controller-a",
    acquiredAt: instant("2026-08-05T05:02:00.000Z"),
    expiresAt: instant("2026-08-05T06:17:00.000Z"),
    releasedAt: instant("2026-08-05T05:49:00.000Z"),
  } satisfies Lease),
  danger: Object.freeze({
    schemaVersion: 1,
    id: identifier("lease", "lease_33333333-3333-5333-8333-333333333333"),
    jobId: dangerJob.id,
    issueId: dangerJob.issueId,
    holderId: "controller-a",
    acquiredAt: instant("2026-08-05T06:20:00.000Z"),
    expiresAt: instant("2026-08-05T07:05:00.000Z"),
  } satisfies Lease),
  unknown: Object.freeze({
    schemaVersion: 1,
    id: identifier("lease", "lease_44444444-4444-5444-8444-444444444444"),
    jobId: unknownJob.id,
    issueId: unknownJob.issueId,
    holderId: "controller-a",
    acquiredAt: instant("2026-08-05T05:14:00.000Z"),
    expiresAt: instant("2026-08-05T06:14:00.000Z"),
    releasedAt: instant("2026-08-05T06:14:00.000Z"),
  } satisfies Lease),
});

const runtimeStatuses: readonly RuntimeStatusItem[] = Object.freeze([
  Object.freeze({
    state: "blocked",
    job: Object.freeze({
      id: crashJob.id,
      projectId: crashJob.projectId,
      issueId: crashJob.issueId,
      startedAt: crashJob.startedAt,
    }),
    roleModel: Object.freeze({ role: "實作者", provider: "Codex", model: "gpt-5.6-terra" }),
    lease: Object.freeze({
      id: leases.crash.id,
      state: "released",
      acquiredAt: leases.crash.acquiredAt,
      expiresAt: leases.crash.expiresAt,
    }),
    attempts: crashJob.attempts,
    lastEffectiveProgress: Object.freeze({
      kind: "checkpoint_created",
      occurredAt: instant("2026-08-05T06:17:00.000Z"),
      summary: "已保存可復航的本機 Checkpoint。",
    }),
    watchdog: Object.freeze({ elapsedMinutes: 16, decision: "continue", extensionGranted: false }),
    checkpoint: checkpoint(
      "checkpoint_11111111-1111-5111-8111-111111111111",
      "2026-08-05T06:17:00.000Z",
      "process_crash",
      3,
      2,
      "由 Reconcile 檢查一次安全復航；再次異常則維持阻塞。",
    ),
    block: Object.freeze({
      kind: "crash",
      reconcileReason: "recovery_limit_reached",
      processRecoveriesUsed: 1,
      processRecoveriesLimit: 1,
      summary: "子 Process 已異常結束，且唯一一次自動復航已用盡。",
      nextStep: "由團隊管理者檢視 Checkpoint 後，再決定新的安全復航。",
    }),
    nextStep: "檢視 Checkpoint 與測試摘要，再以新的 Job 接續。",
  }),
  Object.freeze({
    state: "checkpointed",
    job: Object.freeze({
      id: quotaJob.id,
      projectId: quotaJob.projectId,
      issueId: quotaJob.issueId,
      startedAt: quotaJob.startedAt,
    }),
    roleModel: Object.freeze({ role: "實作者", provider: "Claude", model: "claude-sonnet-5" }),
    lease: Object.freeze({
      id: leases.quota.id,
      state: "released",
      acquiredAt: leases.quota.acquiredAt,
      expiresAt: leases.quota.expiresAt,
    }),
    attempts: quotaJob.attempts,
    lastEffectiveProgress: Object.freeze({
      kind: "test_or_build_milestone",
      occurredAt: instant("2026-08-05T05:47:00.000Z"),
      summary: "型別檢查完成，已留下可驗證的測試里程碑。",
    }),
    watchdog: Object.freeze({
      elapsedMinutes: 47,
      decision: "checkpoint_and_replan",
      extensionGranted: true,
    }),
    checkpoint: checkpoint(
      "checkpoint_22222222-2222-5222-8222-222222222222",
      "2026-08-05T05:49:00.000Z",
      "quota_boundary",
      4,
      1,
      "等待可用 Provider 額度後，再從 Checkpoint 建立新的工作。",
    ),
    block: Object.freeze({
      kind: "quota",
      quotaWindows: Object.freeze<readonly RuntimeQuotaWindow[]>(["weekly", "five_hour"]),
      summary: "已在額度邊界安全停止，沒有把未知額度當成可用。",
      nextStep: "先確認額度狀態，再恢復派工；不可直接重試。",
    }),
    nextStep: "先確認週額度與 5 小時額度，再恢復派工。",
  }),
  Object.freeze({
    state: "blocked",
    job: Object.freeze({
      id: dangerJob.id,
      projectId: dangerJob.projectId,
      issueId: dangerJob.issueId,
      startedAt: dangerJob.startedAt,
    }),
    roleModel: Object.freeze({ role: "整合工程師", provider: "Codex", model: "gpt-5.6-sol" }),
    lease: Object.freeze({
      id: leases.danger.id,
      state: "active",
      acquiredAt: leases.danger.acquiredAt,
      expiresAt: leases.danger.expiresAt,
    }),
    attempts: dangerJob.attempts,
    lastEffectiveProgress: Object.freeze({
      kind: "controlled_git_diff",
      occurredAt: instant("2026-08-05T06:39:00.000Z"),
      summary: "已完成受控 Diff 檢查，尚未執行危險操作。",
    }),
    watchdog: Object.freeze({ elapsedMinutes: 43, decision: "continue", extensionGranted: false }),
    checkpoint: checkpoint(
      "checkpoint_33333333-3333-5333-8333-333333333333",
      "2026-08-05T06:40:00.000Z",
      "safety_pause",
      2,
      1,
      "保留 Checkpoint 並維持等待；安全核可功能尚未接入，現在不可操作。",
    ),
    block: Object.freeze({
      kind: "danger_approval",
      category: "git_destructive",
      summary: "危險操作已被攔截；安全核可功能尚未接入，本頁僅呈現等待狀態。",
      nextStep: "安全核可功能尚未接入，本頁僅呈現等待狀態，現在不可操作。",
    }),
    nextStep: "安全核可功能尚未接入，本頁僅呈現等待狀態，現在不可操作。",
  }),
  Object.freeze({
    state: "blocked",
    job: Object.freeze({
      id: unknownJob.id,
      projectId: unknownJob.projectId,
      issueId: unknownJob.issueId,
      startedAt: unknownJob.startedAt,
    }),
    roleModel: Object.freeze({ role: "審查者", provider: "Gemini", model: "gemini-2.5-pro" }),
    lease: Object.freeze({
      id: leases.unknown.id,
      state: "expired",
      acquiredAt: leases.unknown.acquiredAt,
      expiresAt: leases.unknown.expiresAt,
    }),
    attempts: unknownJob.attempts,
    lastEffectiveProgress: Object.freeze({
      kind: "narrowing_error_evidence",
      occurredAt: instant("2026-08-05T06:12:00.000Z"),
      summary: "已得到可縮小問題範圍的新錯誤證據。",
    }),
    watchdog: Object.freeze({
      elapsedMinutes: 60,
      decision: "checkpoint_hard_stop",
      extensionGranted: true,
    }),
    checkpoint: checkpoint(
      "checkpoint_44444444-4444-5444-8444-444444444444",
      "2026-08-05T06:14:00.000Z",
      "watchdog_boundary",
      1,
      3,
      "由團隊管理者診斷未知錯誤，再建立新的安全工作。",
    ),
    block: Object.freeze({
      kind: "unknown",
      reconcileReason: "source_unavailable",
      summary: "目前無法確認安全復航條件，已保守停止。",
      nextStep: "先完成四來源對帳，再決定是否可恢復。",
    }),
    nextStep: "完成 Job、Lease、Event 與外部來源的對帳。",
  }),
]);

export const fixtureRuntimeStatusReadModel: RuntimeStatusReadModel = Object.freeze({
  source: "fixture",
  listRuntimeStatuses: () => runtimeStatuses,
});
