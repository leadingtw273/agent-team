# 運維注意事項（Ops Notes）

本檔記錄不屬於架構設計、但操作本系統時必須知道的風險與限制。目前只有一節：`state/dispatch` 下的 job-progress／admission 檔案格式回滾風險。

## `state/dispatch` 下的 schema 回滾風險（C016／C018）

### 風險說明

`state/dispatch/progress/<jobId>.json`（`FileJobProgressStore`，`src/adapters/dispatch/job-progress-store.ts`）與
`state/dispatch/admission/<projectId>__<issueId>.json`（`FileIssueAdmissionStore`，`src/adapters/dispatch/issue-admission-store.ts`）
兩個 store 都遵守本專案「不得編輯或遷移既有 `~/.agent-team/state` 下的檔案」的既有原則——每次 schema 擴充都以「新增可選欄位」的方式相容舊資料，從未反向相容過。

這代表：**只要曾經跑過含有新欄位的版本，寫入磁碟的 record 就會帶有舊版 schema 不認得的欄位**。若之後把程式碼回滾到更早的 commit，舊版 `zod` schema 是 `.strict()`（見兩個檔案各自的 schema 定義），讀到任何一個未知欄位都會直接判定整份 JSON 不合法——不是忽略該筆記錄，而是 `listForProject` 之類的整批讀取直接回傳失敗，等同讓 `agent-team run`／`dispatch resolve` 對整個 project 停擺。

已知會觸發這個問題的欄位版本邊界：

| 欄位 | 從哪個 commit 開始寫入 | 回滾到早於該 commit 前必須先處理 |
|---|---|---|
| `JobProgressRecord.stage.paused.pauseReason` | C016（`edcef59` 之前不存在） | 是 |
| `RequiresManualStage` 新增 `"dispatch"` 值、`RequiresManualReasonCode` 新增 `implementer_request_invalid`／`implementer_composition_blocked`／`authoritative_base_unavailable`／`worktree_directory_unavailable`／`implementer_pipeline_failed`／`invalid_base_revision` | C018（`d056a38`） | 是 |
| `RequiresManualReasonCode` 新增 `role_pipeline_unavailable`（非 implementer 角色出口）；`IssueAdmissionRecord.releaseReason` 新增 `legacy_recovered` 與 `releaseNote` 欄位 | C019（`943bd75`）／C016（`edcef59`） | 是 |

### 裁決

本機單人環境、回滾策略完全自控——**採「明確記錄並接受」**，不在本票內加程式碼層的向後遷移或版本探測機制。

### 操作規則

**回滾到 pre-C016（早於 `edcef59`）或 pre-C018 版本之前，必須先清理或遷移 `state/dispatch/progress/` 與 `state/dispatch/admission/` 下所有含以下內容的 record：**

- `stage.kind === "paused"` 且帶 `pauseReason` 欄位的 record（C016 起才會寫入）。
- `stage.kind === "requires_manual"` 且 `cause.stage === "dispatch"`，或 `cause.reasonCode` 為上表列出的 C018／C019 新增值（含 `role_pipeline_unavailable`）的 record。
- `state/dispatch/admission/` 下 `releaseReason === "legacy_recovered"` 或帶 `releaseNote` 欄位的 record（C016 起才會寫入）。

清理方式（任一即可）：

1. 用 `agent-team dispatch resolve --job <id> --as cancelled|superseded ...` 把相關 job 轉成終態（`cancelled`/`superseded`），使其不再出現在 `listForProject` 的讀取路徑中受影響的欄位判讀邏輯之外——**但注意 `dispatch resolve` 寫回的record 仍是新版 schema 格式，本身還是回滾後的舊版 schema 讀不懂，所以這條路徑只降低「未來還會新增」的風險，不解決既有檔案本身**。
2. 直接手動刪除或搬移這些 `.json` 檔案（連同其 `.lock`）到別處備份，讓回滾後的程式碼看到的目錄裡不再有它們。
3. 如果只是短暫測試舊版行為，改用一個全新的 `AGENT_TEAM_HOME`（空的 `state/dispatch` 目錄），不要直接對著正在使用的環境回滾。

不遵守以上任一步驟就回滾，`listForProject` 會在讀到第一筆不相容檔案時整批失敗（`external_failure`／`invariant_violation`，視失敗的確切檔案而定），導致該 project 底下所有 job 的排程/恢復功能全部停擺，直到把不相容檔案處理掉或前進回新版程式碼為止。
