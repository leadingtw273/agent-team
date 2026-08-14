# Agent Team：第一輪使用者測試指南

狀態：**第一張 Codex→Claude Happy Path 已完成，可繼續測試**  
日期：2026-08-14  
適用範圍：Agent Team Sandbox 的安全、小型、代碼審查型需求。

本狀態代表第一輪 Happy Path 已由 LEA-37 真實走通；不代表 v1 所有異常情境完成。

## 0. 從哪裡開始

在 `/home/markchou/project/agent-team` 開啟 Codex 或 Claude Code 對話；這個外層對話就是第一版的「團隊管理者」。把下一節的開場句直接告訴它即可。localhost 管理 UI 是選看的狀態頁；想看時只要對團隊管理者說「幫我開啟 Agent Team 管理後台」，不要自行保存或轉貼帶 session fragment 的網址。

## 1. 你要做什麼

你只需要和「團隊管理者」對話，不需要手動操作 Linear 狀態、Branch、Worktree、PR、CI、Reviewer 或 Merge。

建議直接這樣開始：

> 請在 Agent Team Sandbox 幫我規劃一個安全的小型代碼需求。先與我釐清需求並給我驗收條件，不要立刻執行；工單體量控制在 15～30 分鐘，只需要代碼審查，不要涉及視覺、危險操作、外部依賴或資料遷移。

若你已有明確需求，也可以說：

> 請在 Agent Team Sandbox 新增一個純函式：＿＿＿＿。先整理規格、驗收條件、範圍內外、依賴與預估體量給我核可；核可後由你建立 Linear 工單並自動執行。

## 2. 預期對話流程

1. 團隊管理者釐清需求，整理 Ready Gate 規格。
2. 你核可規格與計畫。
3. 團隊管理者建立 Linear Backlog 工單，設定角色、審查方式、範圍、依賴與預估體量。
4. 工單移到 Ready 前，團隊管理者完成最後唯讀 launch gate；新 Job admission 只採 Codex App Server 的官方帳戶與額度 snapshot。
5. 有效週窗口足以 admission；目前官方若未回 5 小時窗口，不捏造數值，也不因此阻擋 Codex。
6. Codex Implementer 在獨立 Worktree／Branch 實作並建立 Draft PR；GitHub CI 自動驗證。
7. CI 綠後啟動全新的 Claude Code Reviewer；不在啟動前主動查詢或刷新 Claude 訂閱額度。
8. Reviewer 依功能、代碼品質、型別、測試邊界與不必要複雜度驗收；若執行期間撞額度牆，工單留在審查中並維持 GitHub pending。
9. 精確 Head 的 CI、Review Status 與 Diff Digest 一致後才 Squash Merge。
10. Linear 更新為「已完成」，本機 Job、Lease 與 Admission 全部收斂。

## 3. 測試中如何詢問進度

任何時候都可以只問團隊管理者：

> 目前這張單做到哪裡？請用 Linear、GitHub、本機 Job／Lease 三個來源對帳後，用白話告訴我現在狀態、下一步與是否需要我介入。

正常回答應包含目前階段，例如：等待實作、等待 CI、等待代碼審查、等待合併、已完成或具名阻塞原因。單一 Agent 自述不可當成完成證據。

## 4. 成功時你應看到什麼

以下由團隊管理者跨來源讀回後用白話回報；你不需要自行查詢，管理 UI 也只是選看：

- Linear：工單從待辦／待執行推進到已完成，重要轉換有時間軸留言。
- GitHub：只有一個 PR；CI SUCCESS；`agent-team/review` SUCCESS；PR 已 Squash Merge。
- 本機：exact Job=`completed`；non-terminal／blocked／resumable=0；active／expired lease=0；Admission 已釋放。
- 管理 UI：能看到 Sandbox 專案、註冊狀態、Job／Lease 與 wakeup 狀態。2026-08-14 read-back 為 `healthy/unattended`；若未來顯示 degraded，須依當下來源診斷，不沿用歷史結論。
- 若任一權威來源不一致，團隊管理者必須誠實回報 degraded／blocked，不得宣稱完成。

## 5. 目前已知限制

- **額度**：Codex production admission 已接官方 App Server；2026-08-14 live probe 為週額度可用、5 小時窗口缺席。若未來回傳有效 5 小時窗口才納入判定。Claude 不做事前 quota probe；只有執行期間官方 `rejected` 才標示 confirmed wall，單獨 `429` 標示原因未確認，兩者都不會放行 Merge。
- **喚醒**：canonical systemd timer、Webhook Runtime 與 tunnel 已 read-back 為 enabled／active，`health` 為 `healthy/unattended`。若任一來源後續降級，團隊管理者須據實回報，不得沿用本文件的歷史健康結論。
- **UI**：第一版是 localhost 唯讀管理介面；一般設定、額度切換與危險操作核可還不是完整 production route。
- **測試範圍**：這一輪只驗代碼審查 Happy Path。視覺雙審、危險操作、依賴、衝突、取消、quota 撞牆與 Provider 自動備援留到後續輪次。
- **速度**：即使已有 event-driven ingress 與定時 reconcile，fresh Reviewer 與 CI 仍可能使完整流程需要約 10～25 分鐘；不應以短時間沒有新留言判定空轉。

## 6. 第一輪請不要做的事

- 不要手動 Merge PR、重跑或取消 CI、改 Branch／Worktree。
- 不要手動移動 Linear 狀態或修改 runtime 狀態檔。
- 不要把 API Key、quota 確認句或 localhost session token 貼進 Linear／GitHub。
- 不要選擇資料刪除、production deployment、依賴升級、資料遷移或視覺工作作為第一張測試單。
- 發現問題時只告訴團隊管理者，由它跨 Linear、GitHub、本機狀態診斷並決定安全路徑。
- 想中途停止時，也只要告訴團隊管理者「請安全停止這張單並說明目前可保存狀態」；不要自行取消 CI、關 PR 或修改狀態檔。

## 7. 本輪已證明的基線

- Internal canary：Linear LEA-33 → Job → `leadingtw273/agent-team-sandbox` PR #47 → CI → fresh code review → Squash Merge → Linear Done。
- Controller P0 修復：`leadingtw273/agent-team` PR #155、#156 已合併，能解除歷史 auto-merge pause，並對既有 approval 重新跑 fresh Reviewer，而非重用舊核可。
- Live artifact：`leadingtw273/agent-team` PR #157 已合併，四來源 evidence 可重播 PASS。
- T12 fresh-context 驗收：PASS，blocking finding=0。
- Production UI smoke：標題、Sandbox 專案與導覽可見，axe violation=0。
- 2026-08-14：正式路由已切為 Codex execution／Claude code review／Gemini visual review；Codex weekly-only quota live probe PASS。
- 2026-08-14：LEA-37 由 Codex 實作，Sandbox PR #51 的 CI 與 fresh Claude Review 通過後 Squash Merge，Linear Done；最終 0 non-terminal Job、0 active／expired Lease。
- LEA-37 首次執行暴露互動 approval 不適合 unattended controller；修正後 runner 使用 `approvalPolicy: "never"`、精確 worktree sandbox、無網路，非預期 tool request 仍 fail closed。

## 8. 第一輪完成後怎麼回報

請對團隊管理者說：

> 請復盤這次使用者測試：列出工單時間軸、每個 Agent 的工作、CI／Review／Merge 證據、遇到的阻塞、是否需要人工介入，以及下一輪應優先測哪個失敗情境。請生成白話 HTML 報告。
