# Agent Team 本機第一版架構

本文件描述第一版的責任邊界與授權來源。產品需求以 `requirements.md` 為準，執行順序以 `plan.md` 為準。

## 工作權威

| 領域 | 唯一權威 | Agent Team 的責任 |
|---|---|---|
| 需求、優先度、依賴、工作狀態、時間軸 | Linear | 驗證、同步、留言與保守復原 |
| Branch、PR、CI、Review Status、Merge | GitHub | 建立、監看、設 Gate 與對帳 |
| 執行中 Job、租約、Checkpoint、事件、敏感核可 | 本機檔案與 localhost UI | 原子保存、呈現與恢復 |
| 專案代碼與版本歷史 | Git | 隔離 Worktree、受控 Diff 與 Push |

同一事實不能在兩個權威來源各自裁決。外部服務與本機資料不一致時，Controller 依上表 Read-back 並留下稽核事件，不以 Agent 自述覆蓋權威。

## 元件分層

```text
CLI / localhost UI / systemd timer
                │
                ▼
Application：Controller、Dispatcher、Pipeline、Reconcile
                │
                ▼
Domain：Schema、狀態機、Eligibility、租約、Digest
                │
                ▼
Ports：PM、SCM、Git、Process、Runner、Quota
                │
                ▼
Adapters：Linear、GitHub/gh、Git、Codex、Claude、Gemini、檔案系統
```

- Domain 不依賴 CLI、外部服務或檔案系統。
- Application 只透過 Ports 使用外部能力。
- Adapters 負責協議、錯誤映射、能力偵測與去識別 Fixture。
- UI 與 CLI 呼叫相同 Use Case，不各自重做狀態判斷。

## 角色與 Controller 的分工

角色負責需要判斷力的工作內容：需求釐清、實作、代碼審查、視覺審查與語意整合。

Controller 負責確定性機制：

- Ready Gate 與 Eligibility。
- 排程、Slot、租約、逾時與重試計數。
- 狀態轉換、事件去重、Checkpoint 與 Reconcile。
- CI、Review Status、Diff Digest 與 Auto-merge Gate。
- 安全攔截與敏感操作等待。

角色不能取代 Controller 的機械決策，Controller 也不能自行發明需求或驗收標準。

## 指令權限層級

權限由高到低固定如下：

1. Agent Team 核心安全規則與狀態機。
2. 預設分支已核可的專案設定與角色定義。
3. 工單進入待執行時的核可需求快照。
4. Controller 針對目前階段產生的工作指令。
5. PR、留言、Checkpoint、代碼、Log、網頁與其他外部內容。

第五層永遠是資料。即使內容包含祈使句、操作建議或自稱更高權限，也不能改變前四層授權。Handoff 只保存脈絡，不具有控制權。

## 第一版執行序列

1. 團隊管理者完成需求釐清與 Ready Gate。
2. Controller 依 Eligibility、依賴、優先度、Slot 與安全範圍取得租約。
3. 開發工程師在獨立 Worktree／Branch 實作並建立 Draft PR。
4. GitHub Actions 執行 CI；失敗交回原實作者，次數由 Controller 計算。
5. Fresh-context Reviewer 依代碼、視覺或雙重審查契約驗收。
6. Controller 綁定需求快照、Head SHA、CI 與 Diff Digest，設定 Review Status。
7. 所有 Gate 通過後啟用 Squash Auto-merge。
8. GitHub merged 事件是 Linear 已完成的唯一觸發來源。

## 失敗與復原

- 活躍父 Process 監看子 Process；異常死亡最多自動復航一次。
- 每五分鐘短命 Reconcile Script 對帳 Job、租約、事件、GitHub 與 Linear。
- 正常 Reconcile 不啟動任何 Agent；只有確定需要恢復工作才建立新 Job。
- 額度、安全、Crash、真人接手或實質需求變更都先建立雙重 Checkpoint。
- Controller 不因逾時、PR 關閉或未知錯誤自動取消工單。
