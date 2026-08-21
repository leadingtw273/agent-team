# Human-directed workflow MVP 計畫

## 執行原則

- 保持原流程，僅在工單輸入與合併後增加最小分流。
- 一張 Task 只交付一個可驗收差異；發現鄰接問題先記錄，不順手擴建。
- 同一問題最多兩次聚焦修正；第三次先做範圍檢討。
- 新單立即使用新契約，舊單按需遷移，不批次重寫歷史。

## Task

### HDW01：白話欄位與 labels

- Linear template 新增三句人類摘要。
- 新增 `人類驗收` 與 `驗證強度` label groups。
- parser 與 domain issue 帶入三個欄位。

驗收：新 provision 專案可解析；缺欄位的 Ready 工單 fail closed；legacy 專案不受影響。

### HDW02：durable pending checkpoint

- 保存合併身分、需求摘要 digest、狀態與決策紀錄。
- Job checkpoint 保存當次驗收政策與 pending identity。
- GitHub merged read-back 帶 exact merge receipt。

驗收：CAS、重跑、錯 identity 與毀損資料均不誤寫成功。

### HDW03：合併後最小分流

- `not_required` 沿用 Linear Done。
- `required` 先寫 pending，再讓 Linear 保持審查中；Job／Lease／claim 正常收尾。
- dispatch 在 quota／provider／claim 前阻擋 pending issue。

驗收：兩條 happy path 與 pending 防重派皆有聚焦測試。

### HDW04：人類決策 CLI

- `acceptance list`
- `acceptance accept`
- `acceptance request-adjustment`
- Team Lead 每次狀態回報提醒 pending 項目。

驗收：accept 冪等完成；request-adjustment 只留言、不自動建單；零 pending 明確回報 0。

### HDW05：收束與上線

1. format、typecheck、lint、完整測試與瀏覽器回歸各跑一次。
2. 一次 bounded cross-model code review；超出 MVP 的建議進 backlog，不擴張本 PR。
3. 建立 Core PR，沿用既有 review／CI／merge gate。
4. Sandbox provision labels，跑 required／not_required canary。
5. Tank 只做新單契約 rollout，立即回到遊戲功能開發。

## 不在本批

- production UI
- 自動建立或恢復修正單
- dependency proof 平台
- 人類編輯區域 reservation／檔案鎖
- verification command orchestration
- workspace-wide migration 或歷史工單批次重寫

上述項目只有在真實使用暴露具體問題後，才各自開一張最小工單。
