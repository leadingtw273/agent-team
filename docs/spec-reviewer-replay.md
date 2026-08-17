# Reviewer report recovery（reviewer-replay）規格

## 狀態與鎖定前提

- 狀態：已由 leadi 裁決；實作前規格基線。
- 目標使用者：leadi、長期自動運作的 Agent Team，以及事後維運／稽核者。
- 系統定位：沿用既有 resume／reconcile、Reviewer、AutoMergeGate 與 Lifecycle；不是第二套 dispatch 或 merge 流程。
- 動機：救回已完成實作、但因 strict Reviewer report 格式失敗而停在 `requires_manual` 的既有 Job。

## 現場案例

- Project：Tank Skirmish，`project_4bfd2640-d8a9-452f-b925-3bf9f00118cd`。
- Linear：LEA-46，仍在待執行。
- Job：`job_cc883c05-8c27-4691-b702-7f37e1ab039c`。
- PR：#8，persisted base `13d7998e12a0bc5c3e9c1d661ab180a0667b44c5`，persisted/live head `ca3e00ed3ea92b8b28d68b1bc3d11805013f36b0`。
- Job 狀態：`requires_manual`，`cause.stage=review`，`reasonCode=review_report_contract`，歷史格式失敗兩次。
- 舊 sidecar 已截斷，且 `missing_field` 是粗分類；不得以其內容猜測缺欄或重建 identity。

## 名詞

- **Replay admission**：只允許既有、精確符合 `requires_manual(review_report_contract)` 的 Job 進入本 recovery。
- **Review identity**：既有 `ReviewIdentity`，逐欄為 `requirementsDigest`、`headSha`、`diffDigest`，以及只在視覺證據／發布收據存在時納入的 `evidenceDigest?`、`publicationDigest?`。
- **Replay identity**：`jobId`、`projectId`、`issueId`、`externalIssueId`、`changeRequestId`、persisted `baseRevision` 與完整 Review identity 的 canonical object；以既有 `canonicalSerialize` 後 SHA-256 得到 identity digest。
- **Report identity**：每份通過 strict schema 的完整 report（包含 role、verdict、identity 欄、AC 結果、quality checks、findings 與 summary）之 canonical digest；多角色時依 role 排序後形成 report digest 清單。任何 report 內容改變都必須改變 digest。
- **Review-success checkpoint**：以 Job progress CAS 持久化的成功邊界，包含 replay identity、identity digest、通過 schema 的 reports、report digests、attempt total/outcome 與完成時間；stage 仍保留原 `requires_manual(review_report_contract)`，避免把 checkpoint 誤當一般可恢復 stage。
- **Persisted baseRevision**：原 dispatch 寫入的唯一 diff base。不得以 live default-branch tip 覆寫，也不要求兩者相等；BEHIND／base branch／CI 仍由既有 gate 判斷。
- **格式失敗**：provider 完成但最終輸出無法通過 JSON／strict schema／context contract。
- **Transport failure**：provider 未正常開始或完成，例如 timeout、明確 rate limit、network/5xx；不得冒充格式失敗。

## 範圍內

1. 新增 `agent-team dispatch reviewer-replay --job <jobId> [--dry-run]`。
2. 新增 host-local、project-scoped reviewer-replay kill switch；預設關閉，並提供受控 enable/disable 操作。本次只啟用 Tank Skirmish。
3. 新增 replay admission、identity 產生／比對、attempt journal、review-success checkpoint 與安全診斷。
4. checkpoint 成功後，接回既有 review status、`AutoMergeGate.enable`、Lifecycle、Job completion、Lease／claim release。
5. 讓 scheduler/reconcile 只接手 exact `review_report_contract` 且已有成功 checkpoint 的 Job。
6. 完成固定矩陣測試與一次 exact-job dry-run；所有前置通過後，才執行 PR #8 的 live recovery。

## 範圍外

- 不修改 Tank Skirmish PR #8 的程式碼，不補 filler commit，不重做 LEA-46。
- 不建立第二個 LEA-46 Job、Lease claim、branch 或 PR。
- 不新增其他 `requires_manual` reason 的通用 recovery。
- 不降低 Reviewer report schema strictness，不人工拼 report，不讀截斷 sidecar 來猜 identity。
- 不新增人工 merge approval，不建立第二套 merge／direct-squash 實作，不提供 force／skip／bypass。
- 不處理 systemd timer health；crash recovery 以手動 `reconcile --all` 驗收即可。
- 不自動 revert 任何已發生的外部 mutation。

## 核心決策

### 1. Admission 與互斥

1. CLI 先做本機 Job ID／stage／cause／kill-switch 檢查；不合法時可讀本機資料，但 provider 與所有 mutation 為零。
2. `--dry-run` 只做 admission、權威 read-back、identity 與預計 mutation 清單；provider、Job CAS、GitHub／Linear mutation、Lease acquire 全為零。合法 exit 0，阻擋 exit 3。
3. Live replay 必須取得既有 per-job/per-issue Lease，整段 provider、checkpoint、merge/lifecycle 期間 heartbeat。Lease 競爭或 heartbeat 失敗後零後續 mutation。cycle singleton 不能代替 Lease。
4. Admission claim 必須仍指向同一 Job；replay 不建立或替換 claim。

### 2. 權威 read-back 與 identity

1. 每次 provider 前、checkpoint resume 前、merge 前，都重新讀取 PR、CI、Linear requirement、persisted base、effective diff，以及條件式 visual/publication evidence。
2. PR 必須 open、branch/head 與 Job 相符；project/issue/changeRequest 綁定必須相符。
3. 任一 replay identity 漂移都不得寫 checkpoint、review success 或 merge；Job 永久維持 `requires_manual`，交另一條 recovery，不自動重新綁定。
4. dynamic skeleton 只能由當次權威 request + identity 產生；舊 report、sidecar、PR/Linear 自由文字都不是 identity 來源。

### 3. 有界 Reviewer 嘗試與分類

1. 每個 Job + replay identity 的 provider invocation 絕對上限為 2；attempt 在 provider 啟動前以 CAS 持久化，crash 不會重送同一名額。
2. 第一次格式失敗可使用剩餘名額做一次格式修正 retry；retry feedback 只含 closed category 與安全化 code/path。
3. Retryable transport failure 與格式失敗分開計數／分類，但仍受「總 invocation <= 2」硬上限；沒有第三次呼叫。
4. 非 retryable transport、安全暫停或 identity 漂移立即停止。兩次均未取得 valid approved report 時維持 `requires_manual`，不得寫 success checkpoint/status/merge。

### 4. 安全診斷

1. Replay 不得重用會保存 redacted raw output 的舊 sidecar。
2. private journal／CLI 只保存 closed failure category、Zod `code`、normalized path 與由 code 對映的固定訊息。
3. 禁止保存 `issue.message`、received value、unknown key、raw output、sidecar text 或可反推外部值的動態 path。
4. Path 只允許 schema literal segment；array index 轉 `[*]`，record/dynamic key 也遮罩為 `[*]`。
5. Linear／PR 公開面只顯示「review report 格式不符」與 error code 類型數量；不得公開 path、unknown key、received value、原始輸出或 secret。
6. 每次格式失敗都寫 private journal；最終耗盡時才以穩定 marker 在 PR／Linear 各發布一次安全摘要，重跑不得重複。

### 5. Checkpoint、接續與冪等

1. approved report 先以 Job progress CAS 寫 review-success checkpoint；CAS 失敗時不得寫 review success。
2. checkpoint 只免除 Reviewer provider；接續前仍完整重驗 PR、CI、status、requirements、diff、evidence/publication identity。
3. checkpoint 後依序：review status record/read-back → `AutoMergeGate.enable` → authoritative merged read-back →既有 Lifecycle → Job completed CAS → admission／Lease release。
4. mutation key 使用 `reviewer-replay:<jobId>:<identityDigest>:<step>`；同命令重跑與 reconcile 併發不得重複 provider、status、merge、Linear comment、completion 或 claim release。
5. 稽核證據標示 `operation=reviewer-replay`、checkpoint digest、attempt total/outcome；沿用既有 lifecycle comment，不另發重複成功留言。

### 6. Merge 與特殊終態

1. 唯一 merge 入口是既有 `AutoMergeGate.enable`；C035 的取消雙閘門與所有既有 invariants 不得弱化。
2. Canceled、head drift、BEHIND、CI 非綠、review status read-back 不符、direct-squash 前取消都不得 merge。
3. 若 read-back 發現外部已合併，沿用 `already_merged_external`：暫停 project 未來 auto-merge、Linear Done＋稽核留言、Job completed；不得宣稱由 reviewer-replay 授權。
4. Scheduler 只可接手「exact cause + successful checkpoint + project kill switch enabled」；沒有 checkpoint 的 stuck Job 只能由 exact CLI 啟動 fresh review。
5. 現行 production `reconcile --all` 沒有一般 active-job resume 能力；本功能只新增 exact checkpoint inventory/bridge，不把其他 active／requires_manual Job 接進 reconcile，也不補通用 reconcile 缺口。

## 固定驗收矩陣與 traceability

| AC | 客觀驗收 |
|---|---|
| AC1 | job 不存在、錯 stage、錯 reason、kill switch 關閉、claim/identity 不符：provider/Lease/mutation 全零。 |
| AC2 | First attempt success：provider 恰一次，checkpoint 在 review status 前。 |
| AC3 | First format failure + second success：provider 恰兩次，第二次只收到安全 feedback。 |
| AC4 | 兩次格式失敗：維持原 requires_manual，零 success/status/merge。 |
| AC5 | Transport 與格式 failure taxonomy、兩種 counter 與 backoff 封閉；provider invocation 永不超過 2。 |
| AC6 | Checkpoint CAS 失敗：零 review success／merge。 |
| AC7 | Checkpoint 後 crash：reconcile 不重跑 provider，後續 mutation 冪等。 |
| AC8 | CLI 連跑兩次、CLI/reconcile 併發：provider、merge、Linear 留言、completion 均不重複。 |
| AC9 | 合成 secret、unknown key、received value 不出現在 private diagnostic 以外 sink；private 也只保存 safe code/path，無 raw value。 |
| AC10 | canceled、head drift、BEHIND、CI 非綠、review status read-back mismatch、external merge、direct-squash 前取消逐案斷言，不接受只驗 gate 有被呼叫。 |
| AC11 | Happy path 五項一致：review success、GitHub merged、Linear Done＋audit、Job completed、Lease/claim released。 |
| AC12 | 收斂後 generic `run --dry-run` 不再選中 LEA-46。 |
| AC13 | `reviewer-replay --dry-run` 合法 exit 0、阻擋 exit 3，且零 provider／零 mutation／零 Lease。 |
| AC14 | Scheduler 只接 exact reason + success checkpoint；其他 requires_manual 保持不可恢復。 |

每個 AC 必須在測試名稱或驗收報告中有一對一對應；不得以放寬 assertion、skip 或只驗函式被呼叫取代終態／負向 mutation assertions。

## Live recovery 前置與停止條件

1. 全部 AC、build/typecheck/lint/test 與獨立驗證通過。
2. Claude fresh code review 無 blocking finding。
3. Tank kill switch 只對 Tank Skirmish 啟用。
4. exact Job `reviewer-replay --dry-run` 通過，read-back PR open/head match/CI green。
5. 任一項失敗立即停止，不執行 live、不自動 revert。
6. Live 命令最多啟動一次；結果依 durable checkpoint/read-back 繼續，不用 generic dispatch 補跑。
