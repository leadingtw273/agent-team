# Codex 主用／Claude 跨模型 Reviewer 實作計畫

狀態：Task 1～7 已完成；正式設定、Codex quota admission、failure fixtures 與 Sandbox 全鏈 Happy Path 均已驗證  
規格依據：[`docs/requirements.md`](../docs/requirements.md) ADR-009、9.1～9.5  
日期：2026-08-14

## 1. 目標

把目前 production runtime 從「routing 檔看似可選模型，但實際 pipeline 硬接 Claude」改成：

```text
Team Lead／Implementer／CI 修復／Reviewer 修復／Integration
                         │
                         └── Codex（主要執行 Provider）

CI 綠＋精確 Head／Diff Digest
                         │
                         └── Claude（必要 fresh-context Code Reviewer）

視覺證據
                         │
                         └── Gemini（Visual Reviewer）
```

同時移除 Claude 主動 subscription-quota refresh 路線，保留執行期間的結構化撞牆判定、Team Lead 可見性、Linear 留言與 GitHub pending Gate。

## 2. 鎖定範圍

### 2.1 已核可決策

- Codex 承擔一般執行角色；Claude 只承擔必要代碼審查；Gemini 維持視覺審查。
- Claude Review 不做事前 quota probe；缺少 Claude snapshot 不阻擋 Review 啟動。
- Claude 必要審查不可改由 Codex 補審。
- 只有 `rate_limit_event.status=rejected` 能確認 Claude 額度牆；單獨 HTTP `429` 是原因未確認的限流。
- 撞牆或限流時不得接受部分 Review output，不得放行 `agent-team/review=success` 或 Auto-merge。
- 有可信 reset 才自動延後重試；未知 reset 不猜時間、不主動輪詢。

### 2.2 已核可的 Codex weekly-only admission

2026-08-14 live diagnostic 證明 Codex App Server 可官方讀取 quota，但目前只回週窗口：85% remaining、5 小時窗口缺席。leadi 已核可：

- 有效 Codex 週 snapshot 足以讓新工作通過 quota admission。
- 5 小時窗口若未回傳，不把整個 Codex Provider 判成 `quota_unknown`。
- 真實短窗撞牆由 Codex Runner 已有的 `UsageLimitExceeded → rate_limited` 路徑處理。
- 若未來官方回傳可驗證的 5 小時窗口，先通過目標 CLI 版本 schema／Fixture 驗證，再將它加入 admission；不得因今天沒有而寫死永遠忽略。

理由：否則現行官方資料形狀會使 Codex 永遠無法成為主模型，與 ADR-009 的目的矛盾；本做法不捏造 5 小時剩餘量，只使用官方實際回傳的週值。

### 2.3 不在本計畫

- 主動 Claude PTY／TUI／Haiku quota refresh。
- Claude.ai 個人訂閱 quota pull API（官方目前沒有）。
- 用 OpenAI API RPM／TPM 推算 ChatGPT Codex 訂閱額度。
- Claude 撞牆時改由 Codex 自審。
- 新建完整排程服務、資料庫、常駐 Server 或通用 Provider billing 系統。
- 為未知 `429` 猜固定 backoff 時間。

## 3. 現況基線與缺口

1. `~/.agent-team/config/dispatch/routing.json` 五個角色目前全部指向 Claude Sonnet。
2. `providers.json` 只有 Claude／Gemini，沒有 Codex production config。
3. `buildImplementerPipeline`、CI recovery、Reviewer recovery 目前都硬接 `ClaudeRunner`。
4. `ReviewerPipeline` 雖硬接 Claude code reviewer，但 Review model 沿用 `record.model`；改成 Codex 實作後會把 Codex model name 傳給 Claude。
5. `JobProgressRecord` 只保存 `model`，沒有保存 provider 或獨立 code-review model，fresh process 無法可靠重建原 routing 決策。
6. Claude Runner 目前接受官方 `rejected` 與未文件化 `exceeded`，遇 `is_error=true` 一律降成 `external_failure`，也沒有解析 `api_error_status`。
7. `quota-composition.ts` 目前是 Claude-only production admission，並包含已被 ADR-009 取代的 active refresher。
8. 工作樹現有三個 quota-refresher 未提交變更；它們屬被取代方向，實作前必須先保存 patch，再依 Task 1 清除，不得直接覆蓋或遺失。

## 4. Task 分解

### Task 1：封存並退出 Claude active quota refresh（已完成）

目標：先讓工作樹回到符合 ADR-009 的乾淨起點，不讓舊 QP03 半成品混入新實作。

In scope：

- 將目前三個未提交檔案的 patch 保存到 `/tmp/agent-team-claude-active-refresh-superseded.patch`，並 read-back 雜湊與檔案清單。
- 移除 production composition 對 `ClaudeQuotaRefresher`／`activeRefresh` 的依賴。
- 刪除只服務主動 model-turn refresh 的 adapter、測試與設定欄位；保留 QP01 被動診斷 collector。
- 舊 private config 若仍含 `activeRefresh`，載入時回清楚的「已取代設定」錯誤或提供一次性人工遷移說明；不得靜默忽略安全相關設定。

Out of scope：Codex quota admission、Claude runtime 撞牆處理。

驗收：

- production code 不再呼叫 `claude -p` 取得額度。
- `rg activeRefresh|ClaudeQuotaRefresher` 只允許出現在歷史文件／遷移說明，不出現在 runtime composition。
- patch 可從 `/tmp` read-back；使用者既有修改沒有無痕消失。
- quota diagnostic 仍不建立 prompt、Job、Lease 或 admission。

升級觸發：若刪除 refresher 會破壞 QP01 被動診斷，停止並回決策層拆介面。

### Task 2：固定角色 Provider policy 與 durable assignment（已完成）

目標：讓「Codex 實作、Claude Code Review、Gemini Visual Review」成為 runtime 可驗證不變式，而不是文件慣例。

In scope：

- `modelRoutingConfigSchema` 約束：`team_lead`／`implementer`／`integration_engineer` 只能使用 Codex candidates；`code_reviewer` 只能 Claude；`visual_reviewer` 只能 Gemini。
- `providers.json` schema 新增 required Codex config（executable、models、非秘密 account label）；Claude／Gemini schema維持各自責任。
- Job progress 新增 durable execution provider 與 code-review model assignment；新 Job 建立時一次固定。
- 舊 record 缺 provider assignment 時 fail closed 到具名 legacy 原因，不以 model name 猜 provider。
- CAS invariants 禁止既有 Job 中途改 provider／review model。

Out of scope：自動改寫 `~/.agent-team` production config；該 mutation 另需執行 Task 時明確核可。

驗收：

- 非 Claude `code_reviewer` route 被 schema 拒絕。
- 非 Codex execution route 被 schema 拒絕。
- 新 progress record 可跨 process read-back 完整 provider/model assignments。
- legacy record 不會被錯誤交給新 Provider。
- settings 改變不影響已建立 Job。

升級觸發：若必須提高整份 Job schema version或 migration 既有 runtime state，改 code 前回報並另做 migration spec。

### Task 3：Codex production composition（已完成）

目標：讓實作與修復 pipeline 真正使用 `CodexRunner`。

In scope：

- 新增與 Claude/Gemini factory 對稱的 `codex-factory.ts`。
- Implementer、CI recovery、Reviewer recovery、Integration composition 依 durable execution provider 建立 Codex Runner。
- Review pipeline 仍固定 Claude；code-review model 取 durable review assignment，不再沿用 execution model。
- Provider capability／model allowlist／實際 selected model 互相校驗，錯配 fail closed。
- 保持 Codex implementer `workspace-write`、Claude reviewer read-only、Gemini visual-only 邊界。

驗收：

- 真 composition test 證明 Implementer／兩種修復得到 `CodexRunner`，Code Reviewer 得到 `ClaudeRunner`。
- Codex model name 不會傳入 Claude，Claude model name不會傳入 Codex。
- Claude 不能擔任 Implementer；Codex 不能形成有效 Code Review success。
- 現有安全測試（approval、sandbox、worktree clean、evidence hash）全數維持。

升級觸發：若 Codex app-server workspace-write 無法維持現有 protected-region／tool-decision 安全不變式，停止，不以放寬 sandbox 解決。

### Task 4：Codex 官方 quota snapshot 接入 admission（已完成）

目標：使用官方 App Server read-only RPC 形成 Codex production quota authority。

In scope：

- collector 支援 `account/read`＋`account/rateLimits/read`＋再次 `account/read` 同 epoch guard。
- 依目標 CLI 生成／核對 protocol schema；支援官方 backward-compatible `rateLimits`，並容忍 `rateLimitsByLimitId` 存在或缺席，不硬編碼唯一 limit ID。
- 只輸出 opaque identity、CLI version、provenance、實際回傳 windows 與 reset；不保存 email／token／raw response。
- 將 production admission 從 Claude bridge 改為 Codex bridge，保留 singleflight 與一次 read 原則，但不啟動 model turn。
- 依 2.2 裁決，週 bucket 有效即可 admission；缺 5h 不捏造數值。週 bucket unknown／stale／account switch／version drift仍 fail closed。
- 新增 Codex route liveness，移除「只有 Claude route 可 live」的 composition 假設。

驗收：

- live probe 與 fixture 都能產生 weekly confirmed snapshot。
- invalid account/version/reset/schema 回 `quota_unknown`，且零 claim／Lease／Job／Provider start。
- valid weekly snapshot 可走到 Codex liveness；缺 five-hour 本身不阻擋。
- `UsageLimitExceeded` 仍分類 `rate_limited` 並走既有 retry/checkpoint，不誤報完成。
- OpenAI API headers 或 model 文字永遠不能成為 quota authority。

升級觸發：若官方 RPC 不再提供可驗證 weekly window，停止 Happy Path，不用 operator label 或 API RPM/TPM 補值。

### Task 5：Claude Review runtime 限流分類（已完成）

目標：把 Claude Runner 的官方訊號轉成不誤報、可被 pipeline 使用的結構化結果。

In scope：

- 只把 `status=rejected` 視為 confirmed quota wall；移除 `exceeded` 的 authoritative 判定。
- 解析 `api_error_status`；單獨 `429` 映射為 `quota_unknown`／unconfirmed throttling，不映射 confirmed quota。
- `ProviderEvent.quota_boundary` 擴充可選 bucket、resetAt 與 confidence，所有欄位先 schema 驗證、再去敏保存。
- `rate_limit_type` 支援官方五小時、七天與模型別週 bucket；未知 bucket 保留 generic confirmed wall，不猜名稱。
- Runner／Reviewer provider 合併 event 與 final result，但不得只靠 event 順序；不完整 output 一律丟棄。

驗收矩陣：

| 輸入                               | 結果                                        |
| ---------------------------------- | ------------------------------------------- |
| `rejected + five_hour + resets_at` | confirmed five-hour wall，可排 reset 後重試 |
| `rejected + seven_day`             | confirmed weekly wall                       |
| `rejected`，缺 bucket/reset        | confirmed generic wall，未知欄位不推算      |
| `429`，無 rejected                 | unconfirmed throttling                      |
| `allowed_warning`                  | 不中斷 Review                               |
| `exceeded` only                    | 不視為官方 confirmed wall                   |
| exit/error，無上述訊號             | generic provider failure                    |

升級觸發：若目標 Claude CLI 的真 fixture 與官方 SDK enum 衝突，先鎖版本並回 spec，不擴大文字 parser。

### Task 6：等待狀態、Linear 留言、GitHub Gate 與恢復（已完成）

目標：讓 Team Lead 真的知道 Claude Review 為何停住，且任何錯誤都不會誤 Merge。

In scope：

- 新增 durable reviewer-wait stage，保存 reason、confidence、bucket、可選 resetAt、Head SHA／Diff Digest binding；不得保存 provider raw text。
- confirmed wall＋resetAt：`retryNotBefore=resetAt`，Reconcile 到期前零 model start；到期後建立全新 Claude Session。
- confirmed wall 無 reset 或單獨 `429`：保持等待，不自動重試；提供具確認語句的 narrow operator resume 命令，只把同一 Job 回到 `awaiting_review`，不釋放 admission、不重跑 implementer。
- Linear：主要狀態審查中、Agent 狀態等待中；confirmed wall 使用具名窗口/reset 留言，unconfirmed 429 使用 ADR-009 固定文案。
- GitHub：精確 Head 的 `agent-team/review` 維持 pending，Auto-merge disabled。
- Resume 前重新驗證 PR open、Head、CI、requirement snapshot、Diff Digest；任一漂移走既有 invalidation，不使用舊部分結果。
- 留言／狀態 mutation 使用 idempotency key 與 read-back，重送不重複留言。

驗收：

- Team Lead read model 可直接看到 confirmed／unconfirmed 與下一步，不讀 raw Log。
- reset 前多次 Reconcile 為零 Claude process。
- unknown reset 必須人工確認後才重試。
- 重試使用 fresh Session，完整 Review run counter只在有效完整審查後計算。
- Linear／GitHub 任一 publication 失敗時 fail closed，Auto-merge 不啟用。

升級觸發：若現有 Linear Adapter 無法原子維持 workflow／agent condition／blocker comment 的可重播語意，先拆 publication coordinator，不把多個 mutation 假裝成一個 transaction。

### Task 7：Production config migration 與 Happy Path 驗收（已完成）

目標：在不碰正式專案的前提下，證明新路由完整走通 Sandbox。

In scope：

- 先產生 production config migration preview：Codex execution、Claude code reviewer、Gemini visual reviewer；read-back diff 與 loader 驗證後，依使用者對後續 Task 的自動核可授權修改 `~/.agent-team/config`。
- 固定版本與 account opaque identity 後重跑 quota diagnostic。
- 跑完整 quality gate、targeted contract/integration tests、Sandbox internal canary。
- Happy Path：Codex Implementer → PR → CI → fresh Claude Review → exact-Head status → Squash Merge → Linear Done。
- Failure fixtures：Claude confirmed wall、Claude 429 unknown、Codex UsageLimitExceeded、reset 前 Reconcile。

驗收命令至少包含：

```text
pnpm run typecheck
pnpm run lint
pnpm run test:contract
pnpm run test:integration
pnpm run test
node dist/cli/index.js quota probe-status --provider codex
```

Production config、Linear/GitHub/Sandbox mutation 都需在 Task 7 開工前取得當次明確授權；本 plan 核可不等同自動執行外部 mutation。

執行結果（2026-08-14）：

- 三份 production config 已備份、部署、0600／SHA-256／真 loader read-back PASS。
- Codex 0.147.0 App Server live probe 回 weekly 82% remaining、`five_hour_unavailable`；依 2.2 通過 admission 前提。
- Sandbox production dry-run 回 `no_eligible_candidates`，且零 Job／零 Lease／零 model start。
- 首次 LEA-37 live run 在 Codex App Server 對複合唯讀命令提出互動核可時暫停；舊 Job 已取消並釋放 claim。這是 unattended approval 邊界，不是 quota wall。
- 經 leadi 明確核可 unattended sandbox 方案後，Codex runner 固定 `approvalPolicy: "never"`；Implementer 只可寫入該 Job worktree，Reviewer 為 read-only，兩者皆 `networkAccess: false`，非預期 tool request 仍 fail closed。
- LEA-37 重跑 Job `job_f97d32cf-…` 完成 Codex Implementer → Sandbox PR #51（Head `6830bfc…`）→ CI SUCCESS → fresh Claude Code Review；Reviewer 首次 pending 後重試並核可，`agent-team/review` SUCCESS。
- PR #51 已 Squash Merge（`bb2345ef…`），Linear LEA-37 已 Done；最終 production read-back 為 46 個 terminal Jobs、0 non-terminal Job、0 active／expired Lease。
- 重跑 admission 的 Codex weekly remaining 為 81%，5 小時窗口仍為 unavailable；沒有捏造 5 小時數值。
- 兩次 fresh Claude `opus` 唯讀 code review 分別在 118 秒／25 tool turns 與 109 秒／14 tool turns 後仍無 final verdict，由 host 依 bounded timeout 中止；兩次均無 `rate_limit_event` 或 permission denial，故分類為 review unavailable（tool-use timeout），不是 quota wall、PASS 或 BLOCK finding。
- 完整 repository gate：246 個 test files 通過、2 個略過；2857 個 tests 通過、5 個略過；typecheck、format、lint 全部通過。

## 5. 固定驗收矩陣

| 類別       | 必驗                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| 路由       | Codex execution、Claude code review、Gemini visual review；跨角色錯配全紅             |
| Durability | fresh process 從 progress record 還原相同 provider/model；legacy 不猜                 |
| Quota      | Codex weekly official snapshot；未知／漂移 fail closed；Claude 零事前 probe           |
| Review     | rejected confirmed、429 unconfirmed、partial output discarded、fresh retry            |
| 狀態       | Linear 審查中／等待中、GitHub pending、Auto-merge off、留言冪等                       |
| 恢復       | reset 前零啟動、reset 後重驗 binding、unknown reset 需人工確認                        |
| 安全       | Claude reviewer read-only、Codex unattended worktree 精確授權、零 secret/raw response |
| E2E        | Sandbox Codex→Claude Happy Path 真實完成；failure case 不得 merge                     |

## 6. 回滾

- 每個 Task 使用獨立 commit／PR；不得把 config mutation 與 code migration 混在同一不可分割步驟。
- Task 1 的 superseded patch 與 migration 前 config backup 在 Task 7 通過後移出 `/tmp`，保存於私有持久備份；可再生的 Codex schema 暫存則清除。
- production routing config 已在 migration 前保存去敏 inventory 與完整本機備份，部署後以 0600／SHA-256／真 loader read-back 驗證。
- 回滾不得恢復 Claude active quota model-turn refresh；若 Codex admission失敗，系統應 fail closed 或回舊版，不以舊 QP03 繞過。

## 7. 執行與驗收限制

- leadi 後續已明確授權剩餘 Task 自動核可並執行；該授權不擴大既定 scope，也不允許用正式專案或虛構工單替代 Sandbox 驗收。
- 個別 Task 是多檔 code 變更，由 Codex 實作；目前上位規則禁止 subagent，因此執行時無法使用 fresh-context subagent 驗收，至少另跑只依固定矩陣的獨立 pass並揭露限制。
- 外部 Claude spec/plan review 目前因未公開文件外傳風險被安全政策拒絕；不能宣稱本 plan 已跨模型 review。Runtime 完成後的 Claude Code Review 是產品功能，不等同把本機內部 plan 送外部審查。
