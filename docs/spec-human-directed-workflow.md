# Human-directed workflow MVP

狀態：實作中

## 目的

讓專案負責人一眼看懂工單，並可在指定工單合併後親自驗收。既有 Agent Team 的接單、實作、審查、CI、merge gate 與自動合併流程保持不變。

本功能採敏捷 MVP：只交付已確認需要的最小閉環；未在真實運作中發生的邊界情況不預先擴建。

## 新工單契約

新工單可包含：

- `人類摘要`：要做什麼、完成後會看到／能操作什麼、如何驗收。
- `人類驗收`：`需要` 或 `不需要`。
- `驗證強度`：`輕量`、`標準` 或 `嚴格`，供 Team Lead 與執行者判斷；MVP 不建立新的驗證執行引擎。

當專案已建立上述 Linear label groups 時，新進 Ready 工單缺少任一欄位就不接單。舊 Job 與尚未 provision 的專案沿用既有流程；不批次重寫歷史工單。

## 合併後流程

### 不需要人類驗收

完全沿用既有流程：GitHub 合併、Linear 轉已完成、Job 完成並釋放 Lease／claim。

### 需要人類驗收

GitHub 權威 read-back 確認合併後：

1. 以 project、issue、Job、PR、head、merge commit 與需求摘要建立 durable pending checkpoint。
2. Linear 保持 `審查中`，並留下單一白話提醒。
3. Job 完成，Lease／claim 正常釋放；等待人類期間不占 Agent 執行資源。
4. 相同 issue 有 pending checkpoint 時不得重新接單。

Team Lead 使用：

- `agent-team acceptance list --project <projectId>`：列出待驗收項目。
- `agent-team acceptance accept --project <projectId> --issue <Linear-ID>`：接受成果，冪等轉 Linear 已完成並留言。
- `agent-team acceptance request-adjustment --project <projectId> --issue <Linear-ID>`：只記錄要求調整；Team Lead 再用既有建單方式建立一般修正單。

## 安全邊界

- 不繞過既有 review、CI 或 `AutoMergeGate`。
- GitHub `merged` 必須帶 exact merge commit 與 merge time，否則不建立 pending checkpoint。
- checkpoint 身分或 Linear read-back 不一致時 fail closed，不冒稱完成。
- 所有留言與狀態 mutation 使用穩定 idempotency marker。
- MVP 不含自動建立修正單、通用 migration 平台、production UI、人類編輯區域 reservation 或新的驗證命令編排器。

## 驗收條件

1. 新 provision 專案的工單可解析三句摘要、驗收需求與驗證強度。
2. 缺少新契約的 Ready 工單不建立 provider、claim、Lease 或 Job。
3. `不需要` happy path 不退化。
4. `需要` happy path 合併後產生 pending、Linear 留審查中、Job 完成且 Lease／claim 釋放。
5. pending issue 不重複接單；`list` 可列出。
6. `accept` 可重跑且最後 Linear 已完成；`request-adjustment` 不自動擴張流程。
7. format、typecheck、lint、完整測試與既有瀏覽器測試通過。
8. 只在 Agent Team Sandbox 各跑一張 required／not_required canary，再套用到 Tank。
