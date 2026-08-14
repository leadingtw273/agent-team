# Agent Team 路線校正版 Roadmap：走到第一輪 Sandbox 測試

狀態：第一輪 Sandbox Happy Path 已達成  
日期：2026-08-11  
基準：main `2bc269be3387fc72ceddf378997ce7f050ab62e5`

## 0. 2026-08-12 執行狀態

- T00～T11 已完成；T11 internal canary 實際走完 Linear Ready → Implementer → PR → CI → Fresh Review → Squash Merge → Linear Done。
- T11 四來源去敏 artifact 已由 official collector／validator／atomic writer 產生並合併；replay PASS。
- T12 fresh-context 唯讀驗收 PASS，blocking finding=0；限制與裁決見 [`evidence/t12-first-sandbox-acceptance.md`](evidence/t12-first-sandbox-acceptance.md)。
- T13 使用者第一輪測試包已提供，見 [`first-user-test-guide.md`](first-user-test-guide.md)。
- 2026-08-14 ADR-009 路由與 Codex App Server production quota admission 已完成；live weekly-only probe PASS，Claude 改為必要 fresh-context code reviewer 且不做事前 quota probe。
- LEA-37 已真實完成 Codex Implementer → PR #51 → CI → fresh Claude Review → Squash Merge → Linear Done；最終 0 non-terminal Job、0 active／expired Lease，達成第 6 節第一輪 PASS。
- 首次 LEA-37 run 的互動 approval 暫停已以 unattended sandbox 修正：`approvalPolicy: "never"`、Implementer 精確 worktree write、Reviewer read-only、兩者無網路，非預期 tool request fail closed。
- 「可開始第一輪使用者測試」不代表 v1 全部情境完成；危險操作 UI、完整限流 live case 與其他非 Happy Path 仍依第 7 節邊界延後。

## 1. 目標出口

leadi 只透過外層 Codex／Claude 所承載的「團隊管理者」提出並核可一個安全、簡單的代碼需求；Agent Team 在 `agent-team-sandbox` 真實走完：

`Linear Ready → implementer → Worktree／Branch → PR → CI → fresh code review → Diff Digest → Squash Merge → Linear Done`

第一輪通過表示使用者可以開始測試，不表示 v1 全部異常情境完成。

## 2. 鎖定邊界

- Linear 管工作；GitHub 管代碼、CI、Review 與 Merge；本機保存 Runtime 狀態。
- v1 團隊管理者由外層 Codex／Claude 對話承載，不另建聊天 Server。
- localhost UI 只顯示 Runtime／模型／額度與敏感控制，不承擔需求討論。
- 第一輪只測安全的 Codex implementer＋fresh Claude code review Happy Path。
- 視覺雙審、危險操作、額度撞牆、依賴、衝突、取消與流程外 Merge留到後續測試輪次。

## 3. 執行順序

```text
T00 真相基線
  ↓
T01 C035 Merge 安全
  ↓
┌─────────────────────────────┐
│ T02A Codex quota／Claude runtime signal 重驗 │
│ T02B Active-job inventory   │  可平行
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│ T03A Codex quota production gate │
│ T03B Reconcile resume spine │  可平行；撞同檔則序列
└──────────────┬──────────────┘
               ↓
T04 systemd crash／resume live proof
               ↓
T05 project read model → T06 最小 production UI
               ↓
T07 Team Manager host contract → T08 Smoke Runbook
               ↓
T09 live artifact → T10 Sandbox preflight
               ↓
T11 internal canary → T12 fresh acceptance → T13 使用者測試包
```

## 4. Task 出口

| Task | 單一出口 | 必要 production 證據 |
|---|---|---|
| T00 | 文件與 CLI 說明反映真實成熟度 | 文件 read-back、CLI snapshot、CI |
| T01 | canceled／unknown 阻止兩條 Merge mutation；post-race 可稽核 | 負向回歸＋Sandbox 專屬取消 case |
| T02A | 確認 Codex 主動 quota 能力，以及 Claude Review runtime 限流訊號分類 | CLI/version/sample/freshness 去敏紀錄 |
| T02B | Reconcile 可從 durable progress 列出 active jobs | restart 後 active／terminal 對照 |
| T03A | Codex unknown／expired quota 不建立新 Job；Claude Review 不以缺少主動 snapshot 阻擋啟動 | Codex 零 Job／零 lease admission probe；Claude Review runtime failure fixture |
| T03B | 可恢復 Job 只 resume 一次，不確定時清楚阻塞 | replay 不重複 Job／PR／留言／Merge |
| T04 | timer 五分鐘內復航專屬 canary 或誠實阻塞 | PID、job、lease、timer、event before/after |
| T05 | `agent-team project` 顯示 production 真狀態 | CLI read-back，不回顯 Secret |
| T06 | `agent-team ui` 啟動 localhost-only 狀態頁 | 瀏覽器實跑、CSRF/session、截圖與視覺 review |
| T07 | 團隊管理者 host contract 可由 fresh agent 執行 | fresh-context 文件演練 |
| T08 | leadi 只需透過對話完成第一輪操作 | Runbook dry-read |
| T09 | production run 產生去敏、可重播 live artifact | validator 缺證據必紅 |
| T10 | Sandbox 已準備好跑 Smoke | main／PR／Job／activation／quota／timer preflight |
| T11 | internal canary 完整通過 | 一 Issue／Job／PR，Merge 後零非終態 Job |
| T12 | fresh reviewer 只依證據判定 release candidate | AC 逐條 read-back |
| T13 | 交付 leadi 第一輪測試包 | 白話範例、UI 啟動、預期時間軸與健康檢查 |

## 5. 執行紀律

1. T01 完成前不做新的 live Auto-merge／direct-squash case。
2. 每張工單使用獨立 Worktree／Branch／PR；live mutation 任務序列化。
3. 每張都需 CI、代碼品質審查與受影響 production CLI 實跑；fake／unit 綠燈不能取代 production 證據。
4. 45 分鐘觸發 Team Lead 檢查；若原 Agent 完成餘量的成本明顯較低，允許繼續，否則拆剩餘工作。
5. 新 Store／狀態機／通用 subsystem 必須直接關閉本 Task 的第一輪 blocker，否則退回 Backlog。
6. Live 發現的非 P0、非安全、非主旅程 blocker 不插隊。

## 6. 第一輪 PASS

2026-08-14 LEA-37 已逐項達成下列出口；這不會把第 7 節延後情境自動視為通過。

1. leadi 只與團隊管理者對話，不手動處理 Branch、PR 或 CI。
2. 一張新 Sandbox 代碼工單完整完成。
3. 精確 Head 的 CI、Review Status 與 Diff Digest 全綠後才 Merge。
4. Merge 後 Linear Done；沒有非終態 Job、殭屍 Lease、重複 PR 或重複留言。
5. `project`／UI 能解釋結果，且 repo 內有可重播 live artifact。

## 7. 暫停項目

第一輪前暫停 C027、C027b、C029、C030、C032、C034 heuristic corpus 微調、C024、合成 E2E 擴張、Plugin、自我註冊與其他平台 Adapter。它們沒有被取消，只是不再阻擋使用者第一次上手。

## 8. Review 限制

本 Roadmap 依 2026-08-11 fresh-context 全方向審查重排。Codex 起草後，Claude CLI Plan review 在限定窗口內零輸出而中止；因此不能宣稱 Roadmap 原稿曾跨模型複審通過。這是歷史 review 限制，不覆蓋第 0 節的最新執行證據；T12 fresh acceptance 驗的是 T11 產物，也不倒推補作當時的 Plan review。

2026-08-14 的需求規格 ADR-009 已取代 Claude QP02／QP03 主動 admission refresh 方向：Claude 第一版只做必要代碼審查，啟動前不探測訂閱額度；Codex quota production gate 與 Claude 執行期間 `rejected`／單獨 `429` 分級改為兩條獨立驗收線。
