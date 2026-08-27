# Reviewer-replay 負評修正 MVP

## 狀態

已採用。leadi 於 2026-08-27 裁決採最小實作，不為當機、併發或重複命令另建 recovery epoch／平行計數系統。

## 問題

一般 Reviewer 回傳 `changes_requested` 時，既有流程會交給 `ReviewerRecoveryPipeline` 修正；但
reviewer-replay 發布真實負評後只會停在 `requires_manual(review_not_approved)`，無法在同一 Job／PR
接回 fixer。LEA-139 即為此狀態。

## MVP 決策

1. 既有 `dispatch reviewer-replay` 新增 `--fix-rejected-review`，只接受 exact
   `requires_manual(review_not_approved)`。
2. 沿用同一 Job、PR、branch 與 worktree；不得另建 Job 或 PR。
3. 修正前只做必要 read-back：active claim、project kill switch、PR／Head、唯一
   `agent-team/review=failure` status，以及該 status 指向的 strict GitHub review evidence。
4. evidence 必須是相同 reviewer-replay identity 的 `changes_requested`，且至少有一個 blocking finding。
5. fixer 只呼叫既有 `ReviewerRecoveryPipeline`；沿用 Job 原本的 `reviewerFixRounds`，由 0 增為 1。
   只有此顯式模式可在舊 `reviewRuns` 已滿時執行 fixer；scope、tool、commit、push gate 不放寬。
6. 修正推送後，Job 回到既有 `ci_waiting`。新 Head 的 fresh review 使用既有 review pipeline，
   不增加／重設舊 `reviewRuns`。
7. fresh review 通過後沿用既有 ReviewStatus、`AutoMergeGate` 與 Lifecycle；不得 force／skip merge gate。
8. fresh review 再次未通過時回到 `requires_manual(review_not_approved)`，不得再派 fixer。
9. `--dry-run` 只做 read-back 與列出預計動作，零 Provider、零 mutation。

## 明確不做

- 不新增 recovery epoch、獨立 fixer/review token 或另一套 checkpoint 狀態機。
- 不為 provider sent-unknown、process crash、雙 Controller 競爭等邊界一次建完整補償系統。
- 不自動修 advisory、不泛化成所有 `requires_manual` 的 resume。
- 不重設既有 Job counter。

## 驗收

1. 錯 cause、claim、Head、status、comment 或 evidence identity：零 fixer、零 mutation。
2. dry-run 合法：列出一次 fixer、push、fresh review 與既有 merge/lifecycle。
3. Happy Path：同一 Job／PR 執行一次 fixer，`reviewerFixRounds` 變 1，新 Head fresh review 一次；通過後走既有 gate。
4. fresh review 再負評：維持需人工，零第二次 fixer、零 merge。
5. 一般 review、一般 reviewer-replay 與 final-review recovery 不回歸。

## Glossary

`Reviewer-replay rejection recovery`：對 exact reviewer-replay 真實負評，在同一 Job／PR 使用既有 fixer
修正一次，再交回既有 fresh review 與 merge lifecycle 的最小恢復流程。
