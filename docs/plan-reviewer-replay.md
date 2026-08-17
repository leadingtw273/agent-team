# Reviewer replay 實作計畫

## 目標

依 `docs/spec-reviewer-replay.md` 實作窄型、可重啟 recovery，並以原 Job/PR 完成一次安全 live 收斂。

## Threat model

- 信任：本機 Agent Team state、已啟用的 project policy、Linear requirement projection、GitHub read-back、persisted baseRevision、既有 canonical serializer。
- 不信任：Reviewer 原始輸出、截斷 sidecar、PR/Linear 自由文字、動態 schema key、未知 transport 回應、stale process state。
- 並發：direct CLI、cycle/reconcile 可能跨 process 同時執行；以既有 per-job/per-issue Lease + progress CAS 防護。
- 失效模式：provider crash/timeout、checkpoint CAS conflict、status/merge response 遺失、外部合併、取消競態、process crash。

## Task 1：規格與 schema 基礎

- 新增 replay policy store（project-scoped，default off）與受控 enable/disable handler。
- 擴充 Job progress schema：pending attempt journal + review-success checkpoint；舊 record 向後相容。
- 新增 canonical replay identity／report digest helper。
- 新增 safe Zod diagnostics normalizer 與 private journal；不重用 raw sidecar。
- 測試：schema round trip、default-off、path normalization、secret/unknown/received 負向 sink。

## Task 2：Reviewer inspect 與有界 replay

- 由既有 ReviewerPipeline 抽出唯讀 inspect/revalidation 能力，與普通 run 共用同一套 PR/CI/worktree/diff/evidence/identity 驗證。
- 新增 exact-job replay orchestration：先 inspect + identity，CAS 初始化／遞增 attempt，再呼叫 provider。
- First success / format retry success / double format failure / transport failure table-driven tests。
- checkpoint CAS 在任何 review-status mutation 前；checkpoint 保存重啟所需的 valid reports 與 identity，不保存 rejected output。

## Task 3：Resume、merge 與 lifecycle 接線

- checkpointed exact reason 加入 narrow scheduler candidate；無 checkpoint 的 requires_manual 仍不可由 generic resume 接手。
- 在 `reconcile --all` 增加 exact checkpoint inventory/bridge；不得把現行 fail-closed 的其他 active-job/provider/process recovery 一併打開。
- checkpoint resume 先 inspect 並比對完整 identity，再重建 approved decision；不得呼叫 provider。
- 將普通 approved 與 replay approved 共用同一 `ReviewStatusCoordinator` → `AutoMergeGate.enable` → Lifecycle 路徑。
- 全部 replay mutation 使用穩定 key；補 operation/checkpoint/attempt audit metadata，避免重複成功留言。
- 負向測試逐案覆蓋 C035、BEHIND、CI、status mismatch、external merge、direct squash cancellation。

## Task 4：CLI/composition 與 dry-run

- `program.ts` 新增 `dispatch reviewer-replay --job ... [--dry-run]`，blocked=3。
- production composition 由既有 project registry、progress/admission/lease/reviewer/status/merge/lifecycle 組成，不經 discovery，不建立 Job。
- dry-run 使用相同 read-only admission/identity verifier，但不 acquire Lease、不呼叫 provider、不寫任何 store/GitHub/Linear。
- CLI tests 驗 argv、exit code、安全輸出與 exact job 選擇。

## Task 5：驗收與 live recovery

1. `pnpm run format:check`
2. `pnpm run lint`
3. `pnpm run typecheck`
4. `pnpm test`
5. 獨立驗證 pass：只依 AC1–AC14，不依實作敘事。
6. Claude Opus 唯讀 code review；blocking 修正後重跑 1–5。
7. 在 production state 只啟用 Tank Skirmish reviewer-replay policy。
8. 執行 exact Job dry-run；再 read-back PR open/head match/CI green。
9. 執行一次 live reviewer-replay；若 checkpoint 後中斷，只用 `reconcile --all` 接續。
10. Read-back 五項一致與 generic `run --dry-run` 不再選 LEA-46。

## 允許修改範圍

- `docs/spec-reviewer-replay.md`
- `docs/plan-reviewer-replay.md`
- `src/application/pipelines/reviewer*`
- `src/adapters/dispatch/job-progress-store.ts`
- 新增 `src/adapters/dispatch/reviewer-replay-*`
- `src/cli/program.ts`
- `src/cli/index.ts`
- `src/cli/reconcile/*`（僅 exact reviewer-replay checkpoint bridge）
- `src/cli/dispatch/{index,handlers,resume-composition,resume-existing,resume-full-composition}.ts`
- 新增 `src/cli/dispatch/reviewer-replay-*.ts`
- 對應 `tests/unit`、`tests/integration` 測試。

禁止修改 Tank Skirmish PR #8、既有 sidecar、live Job journal，或以 generic dispatch 建新 Job。

## Regression baseline

- C035：取消後 merge 的 pre/post authorization gate 與 direct-squash 前取消檢查。
- 現有 `reviewer-resume` 仍只處理 `reviewer_waiting`。
- 其他 `requires_manual` 不進 resume。
- `AutoMergeGate.enable` 維持唯一 merge 入口。
- `already_merged_external` provenance、project pause、Lifecycle、completion 與 claim release 語意不變。
- persisted `baseRevision` 仍是唯一 diff base。
