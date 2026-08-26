# LEA-136：Linear／GitHub 權威狀態與孤兒 PR 修正實作計畫

狀態：已核可，可進入實作（Claude Opus round 2：PASS；B1–B5 CLOSED）  
依據：`docs/spec-linear-github-authority.md`  
範圍：Agent Team Core；不修改 Tank Skirmish 程式碼，不執行 generic dispatch

## 1. 目標與完成定義

這次只解決一條核心問題：Job 終止、取消、取代或恢復時，Controller 必須先依 Linear 與 GitHub 的公開權威資訊收斂同一張工單的 PR 工作線，才可終結本機 Job 並釋放接單權。

完成時必須同時成立：

1. Linear 留言可重建目前 Job、PR、控制權 epoch 與重要生命週期結果；GitHub 可反查同一工單／Job 的 PR。
2. 同一張工單／PR 同一時間最多一個 Job 擁有自動 mutation／merge 權。
3. 舊 session、過期 Lease 或被 supersede 的 Job 醒來後，在任何外部 mutation 前必須被 fence 擋下。
4. `dispatch resolve` 不再先終止本機 Job；取消與可證明的 legacy／PR-create crash boundary 依封閉流程收斂，不安全的取代則公開衝突並停住。
5. 一次 read-back 加最多一次安全重試仍不能判定時，公開 `escalation_requested`、投影既有 `已阻塞＋整合異常` 並停止；本 Task 不新增自動 Team Lead 模型 pipeline。
6. 重跑命令、crash recovery 與 reconcile 不得重複 PR、留言、completion 或 release。

## 2. 非目標

- 不批次改寫歷史 Linear 工單或舊 PR。
- 不新增 Label／Label group，不建立 bot 簽章或防惡意偽造機制。
- 不建立跨 provider 通用交易框架。
- 不改 Tank Skirmish PR／程式碼，也不以新 Job 重做既有遊戲工單。
- 不因本次修正自動啟動 Team Lead 模型；只發布可供主管裁決的安全 evidence packet。
- 不在本次建立跨 Job 原子 PR handoff；缺少雙 Lease／successor checkpoint 時不得發布假的 handoff 或 superseded 成功。

## 3. 實作順序

### Task A：建立公開 lifecycle contract 與 PR 反查能力

目的：先讓 Controller 能從 Linear＋GitHub 重建「現在是誰、控制哪張 PR」，而不是只相信本機 progress。

變更：

- 新增 `agent-team-lifecycle:v1` closed schema、canonical serialization、parser 與穩定 event ID builder。
- 本 Task 支援事件：`job_started`、`pr_bound`、`job_cancelled`、`job_superseded`、`pr_handoff`、`job_completed`、`authority_conflict`、`escalation_requested`、`external_merge_observed`。
- 每則 Linear 留言由白話摘要加固定 `agent-team-lifecycle:v1` marker／hidden JSON 組成；讀取必須涵蓋完整分頁後才投影 owner。parser 忽略一般人類留言與無效／未知 structured payload，不能把它們當權威事件。
- 逐種 event 定義 canonical ID 欄位；同一邏輯事件重送時 event ID 必須相同。
- 新增 immutable `agent-team-pr:v1` PR body back-pointer，closed 欄位為 project、issue、建立該 PR 的 Job 與 branch identity；不得放 ownership epoch、本機路徑或 private diagnostics。handoff 不改寫 PR body，epoch 只存在 Linear lifecycle 與本機 fence。
- 將新 Job 的 deterministic branch identity 綁定 project＋issue＋job；已持久化的 legacy branch 繼續按原值讀取，不做歷史 rename。
- 在 `SourceControlPort` 增加新的窄版 open-PR-by-head lookup：只以 deterministic head ref 列候選，不得帶 base branch、title、draft 或 current default branch 作篩選；候選投影至少含 PR number/state，接著逐一以 `getChangeRequest` 完整 read-back 並核對 immutable back-pointer。不得沿用 `createDraftChangeRequest` 目前綁 base、title/body/draft 且截斷兩筆的 reuse 查詢。
- 反查候選 head ref 由 Linear `job_started`／`pr_bound`／handoff history 的 Job IDs 加上本機 journal 補集導出；任何 push／PR create 前，`job_started` 必須已發布並 read-back，確保本機 binding 遺失時仍有公開種子。
- Linear 端重用既有 `listComments`，不另造旁路資料源。

主要接點：

- `src/application/ports/source-control.ts`
- `src/application/ports/work-management.ts`（預期只重用，非必要不改 contract）
- `src/adapters/github/adapter.ts`
- `src/cli/dispatch/implementer-request.ts`
- 新增 lifecycle／PR identity domain 或 application 模組

驗收：

- 缺少 Linear／本機 `pr_bound` 但 GitHub 有符合 head ref／back-pointer 的 open PR：可找回且不得判定「無 PR」；PR 被 retarget 或 default branch 改變時結果不變。
- 找到 0、1、>1 張候選各有封閉結果；>1 或 identity 衝突只允許 `authority_conflict`／escalation，零 mutation。
- event canonicalization、未知 payload 忽略、重送去重、legacy branch read-back 均有單元／contract 測試。

### Task B：加入 control fence 與 durable mutation attempt budget

目的：把 Job／Lease 的排他控制權真正放到每次外部 mutation 前，而不是只在流程開頭檢查一次。

變更：

- 以 backwards-compatible optional 欄位擴充 `JobProgressRecord`：
  - `controlFence`：job、issue、lease ID、holder ID、monotonic lease epoch、ownership epoch。
  - `mutationAttempts`：以 `(job, mutation intent, identity digest)` 為 key 的 persist-before-send 計數與 read-back 結果。
  - lifecycle publication receipt／checkpoint，只保存公開事件 identity 與 provider receipt，不保存 raw output。
- 不強制遷移既有 Lease v1 檔；新的 monotonic epoch 由 progress CAS 維護。取得／恢復控制權時先 CAS 建立 fence，再允許 provider mutation。
- 在 composition root 唯一注入 fenced port decorators，內部共用 `assertCurrentMutationAuthority`；不得由各 call site 自行選擇是否檢查。封閉適用集合與 spec AC6 一致：
  - `GitPort.push`。
  - 所有 managed GitHub 寫入：PR create/update/ready/close、PR comment、commit/review status、auto-merge／merge。
  - 所有 managed Linear 寫入：lifecycle comment、work status、agent condition／clear，以及本流程需要的 audit comment。
  - terminal progress write、Lease／claim release 雖非 provider mutation，仍必須在同一 authority read-back 成功後才執行。
- 每個 mutation identity 最多兩次 provider call（初次＋一次安全重試）。每次 call 前先 CAS 增加 durable attempt；crash 後不得把計數歸零。
- CAS、Lease、ownership epoch、Linear workflow、PR/head 任一不符即 fail closed，零 provider call。

主要接點：

- `src/adapters/dispatch/job-progress-store.ts`
- 既有 Lease／issue admission repositories 與 composition
- 新增 control-fence／mutation-attempt coordinator

驗收：

- 舊 session 在 supersede／新 epoch 後醒來：逐類驗證 push、PR create/update/ready/close、PR comment、commit/review status、auto-merge/merge、Linear lifecycle/status/condition provider call count 皆為 0。
- attempt persist 後 crash：重啟只剩一次額度；第二次仍不明確後停止。
- CAS 衝突、過期 Lease、錯 holder、錯 issue/job/head/epoch 均為負向測試。
- 舊版 progress fixture 仍可讀，且沒有 fence 時不得偷偷取得 mutation 權。

### Task C：把 Job／PR ownership lifecycle 接入新接單、resume 與 completion

目的：讓公開權威歷史從 Job 建立到完成都連續，並阻止第二個 Job 在未收斂 PR 上開工。

變更：

- Job 成功取得 issue admission 與 Lease 後發布 `job_started`；寫入前、寫入後均 read-back identity。
- `job_started` 成功 read-back 是任何 push／PR create 的硬前置；未成功時不得只靠本機 Job 繼續。
- 建立／重用 draft PR 時寫入 PR back-pointer；完整 GitHub read-back 成功後再發布 `pr_bound`。
- bootstrap／resume／reconcile 先讀 Linear native state＋lifecycle comments，再讀 GitHub exact PR/head；本機 progress 只補執行 checkpoint，不能覆蓋公開事實。
- 若已有 active owner 或未收斂 PR，禁止建立第二 Job／第二 PR；改為恢復同一 Job、補完合法 handoff，或 authority conflict。明確定義「未收斂」包含：open PR 的最高 epoch owner 已 terminal、卻沒有更高 epoch handoff；此狀態不能被解讀成「目前無 owner，可直接接單」。
- 正常結束時先驗證 GitHub merge／Linear Done 與 audit comment，再發布 `job_completed`，最後才 release Lease／claim。
- `ownershipEpoch` 只可單調增加；同一 epoch 最多一個 active owner。

主要接點：

- `src/cli/dispatch/handlers.ts`
- `src/cli/dispatch/resume-existing.ts`
- `src/cli/dispatch/resume-composition.ts`
- `src/cli/reconcile/composition.ts`
- implementer PR creation composition

驗收：

- 同一工單已有 open PR／active owner 時再次 run：零新 Job、零新 PR。
- crash 在 `job_started`、PR create、`pr_bound`、merge、`job_completed`、release 任一邊界後，重跑均收斂且不重複公開事件。
- Happy Path 最終一致：GitHub merged、Linear Done＋既有 lifecycle audit、`job_completed`、Job completed、Lease／claim released。

### Task D：重寫 `dispatch resolve` 的取消／取代收斂順序

目的：直接修掉 orphan PR 的已知入口。

變更：

- 保留既有明確 stdin confirmation 與輸入驗證。
- resolve 先取得／heartbeat exact Job＋issue Lease，重建 Linear／GitHub authority，再決定 mutation；不得一進來就寫 terminal stage。
- 若 Linear 或 GitHub authority read-back 因憑證、網路或 provider failure 不可用，回傳封閉的 `authority_unavailable` blocked/rejected 結果：零 provider mutation、零 local terminal、零 Lease／claim release，並保留 confirmation 語意。操作者恢復憑證／連線後重跑同一命令；若只有寫入失敗但可安全 read-back，才適用下述 sent-unknown／escalation 流程。無法連 Linear 時不得假裝已發布 escalation。
- `cancelled`：
  1. 驗證 Linear 取消語意、owner epoch 與 exact unmerged PR/head。
  2. 經既有 `LifecyclePipeline` 關閉該 PR；若 GitHub 已合併則走 external merge provenance，不冒稱由 cancel 授權。
  3. 發布 `job_cancelled` 並 read-back。
  4. 最後 CAS terminal local progress，再 release Lease／claim。
- `superseded`：
  1. 若沒有 open PR，可依既有 terminal 路徑收斂。
  2. 若有 open PR，本次 MVP 不做跨 Job handoff：發布並 read-back `authority_conflict`，投影 `已阻塞＋整合異常`。
  3. PR 保持 open；不得發布 `pr_handoff`／`job_superseded`、不得 terminal 舊 Job、不得 release claim，也不得讓 successor mutation。
  4. 具備雙 Lease 與 successor durable checkpoint 後，另立 Task 實作完整 handoff 與所有 merge gate 重驗。
- 任一 provider `sent-unknown`：先 read-back；identity 完全相同時只允許一次安全重試。仍不明確則發布 `escalation_requested`、投影 `已阻塞＋整合異常`，Job 保持非 terminal、不得 release claim／Lease、不得 merge。
- 同一 resolve 命令重跑及 reconcile 共享 idempotency identity，不得各自再取得兩次額度。
- attempt budget 用罄後本 Task 不提供自動 reset 或新 recovery epoch；維持 blocked，等待 Team Lead 另行裁決。不得由 resume／reconcile 自行清零。

主要接點：

- `src/cli/dispatch/resolve-handlers.ts`
- `src/cli/dispatch/lifecycle-composition.ts`
- `src/application/pipelines/lifecycle.ts`（優先重用；只補必要 identity／receipt）
- resolve CLI composition 與 reconcile recovery seam

驗收：

- 取消 open PR：PR closed、Linear `job_cancelled`、local cancelled、Lease／claim released，順序可由測試 receipt 證明。
- 取消 open PR 且 Linear 缺 `pr_bound`：必須從 `job_started` 導出 head ref、反查 exact PR；先 conflict/escalate，不得直接 terminal/release。
- 取消時外部已合併：沿用 `already_merged_external` provenance，禁止 close/merge 冒名；既有 project auto-merge pause 行為不退化。
- supersede open PR：零 close、零 handoff、零 terminal、零 release；恰一則去重的 `authority_conflict`，Linear 顯示阻塞，重跑不得新增事件或 provider mutation。
- 新 Job 不存在／錯 issue／PR identity 漂移／多候選／CI 或 head read-back 不明確：零 terminal、零 release、零 merge。
- authority read-back unavailable：明確回傳 `authority_unavailable`，零 mutation／terminal／release；恢復 provider 後可重跑。
- close PR 成功但 `job_cancelled` 未發布、PR create 成功但 `pr_bound` 未發布等 crash boundary：resolve／resume 重跑只補可由 immutable identity 證明的缺步驟，不能重複 provider mutation。
- C035 取消後仍合併、direct-squash 前取消、BEHIND、CI 非綠、review status 不符等既有負向 invariants 全部保持。

### Task E：獨立驗收與文件收尾

目的：用規格條件驗證，而不是依實作者敘事判定完成。

測試層級：

1. 新增 domain/application unit tests：event parser/ID、owner projection、fence、attempt budget、resolve state machine。
2. GitHub／Linear contract tests：不含 base filter 的 PR reverse lookup、immutable body back-pointer、完整分頁、append/read-back 去重、sent-unknown。
3. CLI composition/integration tests：new run、resume、reconcile、cancel、unsafe supersede fail-closed、external merge、authority unavailable、legacy 與 PR-create crash boundaries；同一 Job 兩個 resolve 併發及 resolve/reconcile 併發必須共用 mutation identity，合計 provider call 不超過兩次且公開事件去重。
4. 回歸測試：現有 lifecycle、issue admission、AutoMergeGate、review status、work-status lifecycle 與 C035 負向案例。
5. 安全資料測試：合成 raw model output、secret、received value、unknown key 與 private path，斷言它們不出現在 lifecycle comment、PR body、CLI stdout/stderr、Job public receipt 或其他 public sink。
6. 靜態與完整驗證：`pnpm run lint`、`pnpm run typecheck`、`pnpm run build`、focused tests，最後 `pnpm test`。

fresh-context 限制：目前上位指令不允許新派 subagent；實作完成後至少另做一次只依本文件與 spec AC 的獨立驗證 pass，並明確揭露它不是 fresh-context subagent。若限制解除，再補 fresh-context 驗收。

## 4. 實作防發散規則

- 同一 blocker 最多沿著直接原因再追兩層；到第三層先做 scope review，非本 Task 不變式所必需者列 backlog，不當場擴張。
- 每個 Task 先寫會失敗的封閉測試，再做最小改動使其通過；不順手改寫相鄰 framework。
- 新增 public event 或 progress 欄位前，必須能指出它支援哪一條 AC；否則不加。
- 不新增 Label；詳細 identity、原因與歷史放 lifecycle comment，本機機械資訊放 private journal。
- 任何 identity 漂移都 fail closed；不 force、skip、bypass merge gate，也不自動 revert。

## 5. 建議提交切片

1. `feat(lifecycle): add public job-pr authority contracts`
2. `feat(dispatch): fence managed mutations and persist attempts`
3. `feat(dispatch): reconcile job-pr ownership on run and resume`
4. `fix(dispatch): converge resolve before terminal release`
5. `test(dispatch): cover authority recovery and orphan-pr invariants`

每一片都必須可 build、focused test 綠燈；最後才合併成 LEA-136 PR 供完整 review。若 Task B 或 C 發現需要跨所有 provider mutation 做通用交易層，立即停下升級裁決，不自行擴張。
