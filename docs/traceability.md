# Agent Team v1 需求追蹤矩陣

本文件把核可規格、Plan Task 與可驗證證據連成單一追蹤鏈。需求文字以 `requirements.md` 為唯一基線；本矩陣只建立索引，不重新定義需求。

## 狀態語意

- `已驗證`：實作已合併，且有本機 Gate、獨立 Review 或真 CI 證據。
- `已規劃`：Task 與驗收方式已核可，但尚未執行。
- 狀態不得由 Agent 自述單獨改為已驗證；必須附 Git、CI、Test、Probe 或 Read-back。
- 上述單一狀態只表示原始 Task／規格追蹤，不代表 production 已可達。2026-08-11 起，當前能力一律先看下方四層真值表：`code`、`test`、`production`、`live` 不得互相代替。

## 2026-08-11 路線校正：能力真值表

基準：main `2bc269b`；最新 GitHub Actions Run `31398014580` 的 `Quality gates` 成功。`live narrative` 代表交接與人工 read-back 有紀錄，但 repo 內尚無可重播、去敏 case artifact，因此不能算 release evidence。

| 能力 | code | test | production | live | 當前裁決 |
|---|---:|---:|---:|---:|---|
| Domain／Schema／Provider-neutral Ports | 是 | 是 | 不適用 | 不適用 | 可信基礎 |
| Linear／GitHub／Git Adapters | 是 | 是 | 是 | narrative | 高度可信，缺可重播 artifact |
| Registration Setup／Activation | 是 | 是 | CLI 可達 | narrative | 高度可信，缺可重播 artifact |
| Proactive Registration Probe | 是 | 是 | CLI 可達 | narrative | 高度可信，缺可重播 artifact |
| Implementer dispatch | 是 | 是 | 可達 | E101 narrative | 核心 Happy Path 已形成 |
| Code Review | 是 | 是 | 內嵌 resume 可達 | E101 narrative | code 可信，live 證據待版本化 |
| Visual／Dual Review | 是 | 是 | config 完整時可達 | E102 narrative | 不列入第一輪 Smoke Test |
| CI repair | 是 | 是 | 可達 | E103 narrative | 不列入第一輪 Smoke Test |
| Merge／Lifecycle | 是 | 是 | 可達 | E115 暴露取消／合併缺口 | **P0：取消工單仍可能被合併** |
| Quota enforcement | policy／UI model 有 | 是 | 未接可信 sample | 無 | **未完成；unknown admission 不可信** |
| Reconcile／Watchdog | 是 | 是 | active jobs 固定為空 | 無 | **未完成；無法真正復航** |
| Danger approval | classifier／UI model 有 | 是 | production 一律拒絕，無核可 bridge | 無 | 安全但不可用；第一輪不觸發 |
| `project` CLI | 介面有 | 是 | blocked default | 無 | **未完成** |
| localhost UI | 元件有 | 是 | blocked default／fixture read model | 無 | **未完成** |
| Dependency／Concurrency | Domain 有 | 是 | resolver 未接 | 無 | 半完成；第一輪不測 |
| Integration role | Domain／角色定義有 | 是 | dispatch 不可達 | 無 | 不得宣稱 v1 已可獨立調度 |
| Team Manager entry | 角色契約有 | 零散 | Host contract 未文件化 | 無 | **第一輪前需明確定義** |
| Live case evidence | harness／validator 有 | 是 | production writer 未閉環 | narrative | **缺 versioned redacted artifact** |

### 當前執行優先序

1. 取消工單的 Merge revocation boundary。
2. Codex／Claude quota capability 重驗與 production admission gate。
3. Durable active-job inventory、Reconcile resume 與 systemd live proof。
4. `project` production read model 與最小 localhost UI。
5. Team Manager host contract、Smoke Runbook、live artifact、internal canary。
6. leadi 第一輪 Sandbox Smoke Test。

完整 Task、依賴與第一輪邊界見 [`roadmap-to-first-sandbox-test.md`](roadmap-to-first-sandbox-test.md)。診斷細化、逐 artifact transcript、root-file broker、review context 診斷、secret scanner corpus 微調與合成 E2E 擴張在第一輪前暫停。

## 規格章節對應

| 規格 ID | 規格主題 | Plan Task | 主要 Test／Probe | 狀態 |
|---|---|---|---|---|
| SPEC-01 | 鎖定前提：使用者、外部服務、產品定位、動機 | B001、B005 | 文件 SHA Read-back、角色／架構 Contract | 已驗證 |
| SPEC-02 | 第一版目標：需求到 Merge、Done、Checkpoint 的完整鏈 | C004-C009、E101-E109、D003 | Sandbox Happy Path、Failure Injection、親測腳本 | 已規劃 |
| SPEC-03 | 第一版不做：Plugin、Linear Agent、SQLite、常駐 Server 等 | B005、F009-F011、D004 | 架構 Review、依賴／資料層 Contract、出口稽核 | 已規劃 |
| SPEC-04 | 使用者只與團隊管理者互動、Ready Gate、需求變更 | B005、F003、C011、D003 | 角色 Contract、Eligibility 矩陣、Change Control Fixture | 已規劃 |
| SPEC-05 | Linear 狀態、Label Group、Form Template、留言政策 | S004、F002-F004、A001-A004、O003 | Linear Capability Probe、Adapter Contract、Round-trip | 已規劃 |
| SPEC-06 | 五個核心角色與 Controller 分工 | B005 | `role-definitions.test.ts`、fresh-context 架構 Review | 已驗證 |
| SPEC-07 | 每工單獨立 Branch／Worktree／Draft PR | A005-A006、C005、E101 | Temp Repo Integration、Sandbox PR 證據 | 已規劃 |
| SPEC-08 | CI、Fresh Review、Visual Manifest、Digest、Auto-merge、衝突 | B004、F007-F008、A008、C006-C010、E101-E105、E113 | 真 Actions Run、Review／Digest／Conflict E2E | 已規劃 |
| SPEC-09 | Provider Runner、模型路由、週額度與三態訊號 | S001-S003、R003-R007、U004-U005、E106-E107 | 真 CLI Probe、Quota Fixture、UI／Fallback E2E | 已規劃 |
| SPEC-10 | 危險操作分類、localhost 核可、固定權限層級 | B005、R008、U002、U006、E108、E118 | Authority Contract、Safety Fixture、注入 E2E | 已規劃 |
| SPEC-11 | 雙重 Checkpoint、45／60 分鐘、Watchdog、Reconcile Timer | F006、F008、R009、C012-C014、O007-O008、E109-E111 | Crash／Clock／Lease Fixture、五分鐘復航與 Soak | 已規劃 |
| SPEC-12 | 優先度、Slot、Provider 備援、同 Repo 併行 | F003、F006、C002-C004、E112 | Dispatcher 決策矩陣、租約競爭、Sandbox 併行 | 已規劃 |
| SPEC-13 | Node 24、TypeScript、設定分層、檔案式狀態 | B002-B005、F001-F012、C001 | 編譯 CLI、架構 Contract、Crash／Lock／Schema Test | 已規劃 |
| SPEC-14 | localhost 管理 UI、安全 Session、中文表單 | U001-U008 | Browser、CSRF、Session、axe、視覺 Review | 已規劃 |
| SPEC-15 | Linear、GitHub、Webhook Runtime Adapters | S004-S006、A001-A010、W001-W005 | Capability Matrix、Contract Fixture、真 Probe | 已規劃 |
| SPEC-16 | 專案註冊、Setup PR、可信設定、健康狀態 | C001、O001-O009、E004 | Registration State Test、Setup PR、主動 Probe、`agent-team registration` CLI | 已規劃 |
| SPEC-17 | 獨立 `agent-team-sandbox` 與完整驗證情境 | E001-E118 | Sandbox CI、代碼／雙重審查、Failure E2E、Soak | 已規劃 |
| SPEC-18 | 第一版八項驗收出口 | E101-E118、D001-D005 | 本文件「第一版驗收出口」八列證據 | 已規劃 |
| SPEC-19 | 高階實作順序與核可後可執行 Plan | B001-B006、S001-D005 | Plan SHA、Task DAG、Phase Gate | 已規劃 |
| SPEC-20 | 舊系統教訓：SSOT、空轉、Worktree、Handoff、假綠 | B003-B006、F003、C013、E109-E118 | 紅綠 Gate、Authority Contract、多來源對帳 | 已規劃 |
| SPEC-21 | 八份 ADR | B005-B006、D004 | 本文件 ADR 索引、架構 Review、出口稽核 | 已驗證 |
| SPEC-22 | 已收斂澄清清單 | B001、B006、D004 | 規格 SHA、追蹤完整性 Contract、Release Audit | 已規劃 |
| SPEC-23 | Provider、額度、GitHub、Linear、檔案、WSL2 已知風險 | S001-S007、F010-F012、O002、O007-O008 | Spike Gate、Failure Fixture、Registration Health | 已規劃 |
| SPEC-24 | 官方參考資料 | S004-S006、A001-A010、D002 | Spike provenance、Adapter Contract、操作文件 Read-back | 已規劃 |

## 第一版驗收出口

| 出口 ID | 規格第 18 節出口 | Plan Task／E2E | 必要證據 | 狀態 |
|---|---|---|---|---|
| EXIT-01 | 至少一張代碼審查工單與一張雙重審查工單完整合併 | E101、E102 | Linear Issue、PR、CI、兩類 Review、Merge、Done | 已規劃 |
| EXIT-02 | 每個主要失敗分支有自動化測試或可重跑 Probe | E103-E118、E006-E008 | 個別 Case 報告與 Aggregate Report | 已規劃 |
| EXIT-03 | 實際殺死子 Process，五分鐘內復航或清楚阻塞 | E109、E009 | PID 清單、Crash Event、租約、復航／阻塞時間戳 | 已規劃 |
| EXIT-04 | 額度訊號失效不誤判，UI 可刷新與恢復 | R007、U005、E106-E107 | 帳號綁定 Fixture、刷新一次、備援與 UI 操作 | 已規劃 |
| EXIT-05 | 危險操作未核可不執行，核可／拒絕留摘要 | R008、U006、E108 | Process 前攔截、UI 決策、Linear 稽核留言 | 已規劃 |
| EXIT-06 | Merge 前需求快照、CI、Reviewer、Head SHA、Digest 一致 | F007、C007-C008、E105 | Canonical Fixture、Status、有效 Diff 偷換反向測試 | 已規劃 |
| EXIT-07 | Linear、GitHub、UI、本機狀態可對帳且沒有假綠 | E005、E007-E009、E110、E116-E117 | 四來源 Evidence Validator、Soak、流程外事件報告 | 已規劃 |
| EXIT-08 | 提供使用者可親測的完整案例與啟用說明 | D002-D003、E101-E102 | 新環境 dry-run、Happy Path 與親測逐步結果 | 已規劃 |

## ADR 索引

| ADR | 決策 | 主要落地 Task | 防回歸證據 |
|---|---|---|---|
| ADR-001 | Linear 與 GitHub 是工作／代碼權威，不自建看板 | B005、A001-A010、D004 | Architecture ownership table、Adapter Contract |
| ADR-002 | 本機核心優先，Plugin 延後 | B001-B005、D004 | Repo Scope、依賴稽核、Release Exit |
| ADR-003 | 第一版不使用 Linear 原生 Agent 身分 | S004、A001-A004、O003 | Capability Matrix、固定留言標頭與 Label Contract |
| ADR-004 | 無常駐 Server，保留五分鐘 Reconcile Timer | C013-C014、O007-O008、E109-E110 | 正常 0 Agent Spawn、Crash／Timer E2E |
| ADR-005 | JSON／JSONL／YAML 檔案狀態，不使用 SQLite | F005-F011、E110 | Atomic write、Lock、Replay、Partial tail Fixture |
| ADR-006 | Fresh Reviewer＋Commit Status＋Diff Digest | F007、A008、C007-C008、E101-E105 | Fresh Context、Head SHA Status、Digest E2E |
| ADR-007 | 危險操作只在 localhost UI 核可 | R008、U001-U006、E108 | CSRF／Session、安全分類與 Linear 注入反向測試 |
| ADR-008 | 舊 Repo 唯讀，獨立 Sandbox 先行 | B001、E001-E118 | 舊 Repo Clean Gate、Sandbox 全案例報告 |

## Phase 0 已驗證證據

| Task | Merge／Run | 已驗證內容 |
|---|---|---|
| B001 | Commit `30cb1fdfdda336ce9b28b6a84907873617419870` | 初始 Private Repo、`main`、需求／Plan SHA Read-back；S005 經授權改為 Public 並重新驗證 |
| B002 | PR #1，Merge `7ab3b1a50f007e6014780c8c84dbca59aab82a13` | Node 24、pnpm 10、TypeScript strict ESM、編譯 CLI |
| B003 | PR #2，Merge `7e3fab4cedeaa560556398c2513036dd33f823b2` | 七類 Gate 紅燈與全綠、Fresh Review |
| B004 | PR #3，Merge `144d0fd50d72193486c54adcecd315ca8b7f72af`；Run `30898284445` | Pinned Actions、最小權限、首個真 CI 27 秒全綠 |
| B005 | PR #4，Merge `9638ec5200e6dbedf332b12cbd142fd594e2fafa`；Run `30898922226` | 五角色、權限層級、Contract 反向測試與 CI 全綠 |

## Phase 1 已驗證證據

完整 Adopt／Degrade／Block 裁決與後續約束見 [`docs/feasibility.md`](feasibility.md)。

| Task | Merge／PR | 已驗證內容 |
|---|---|---|
| S001 | PR #6，Merge `55f1baf` | Codex JSONL、app-server Approval／Interrupt、週額度與 5h unknown |
| S002 | PR #7，Merge `794bbe3` | Claude Team auth、唯讀 Review、permission denial、週額度事件與 5h unknown |
| S003 | PR #8，Merge `f232d59` | Gemini JSON 視覺、read-only policy、unavailable 與 signal 限制 |
| S004 | PR #11，Merge `d251d07` | Linear GraphQL、Label Group、Template、Upload；目前 0 Project |
| S005 | PR #9／#12，Merge `4085a57`／`140f77f` | GitHub PR／CI／Status；Public 後 Auto-merge 可用、Ruleset 尚未配置 |
| S006 | PR #10，Merge `b68f1b2` | GitHub／Linear Webhook 驗簽、dedupe、亂序、快速 ACK |
| S007 | 本文件與 `docs/feasibility.md` | Spike Gate：PASS WITH DEGRADATIONS，可進 Phase 2 |

## Phase 2 Foundation 已驗證證據

| Task 範圍 | Merge／PR | 已驗證內容 |
|---|---|---|
| F001-F006 | PR #14-#19 | Foundation、Project／Issue、Eligibility、Workflow、Event、Job／Lease／Watchdog 契約 |
| F007-F009 | PR #20-#22 | 需求快照、Diff Digest、Checkpoint／Visual Manifest、Provider-neutral Ports |
| F010-F012 | PR #23-#26，main `9f610d3` | Crash-safe File State、Event Store／Inbox、Secret／輸出遮罩與複審修補 |

Foundation Gate 在同步 main 上完成 lint、typecheck、unit、contract、integration、build、format 與 diff-check；F012 複審發現的複合 Header／自訂 split flag 遮罩缺口已由 PR #26 關閉。

## Phase 3A Platform Adapter Track 已驗證證據

| Task | Merge／PR | 已驗證內容 |
|---|---|---|
| A001-A004 | PR #27-#30，Merge `0ebf164`～`000900c` | Linear transport、read model、mutation、artifact upload；Fixture 與 mutation read-back |
| A005-A006 | PR #31-#32，Merge `4d946c7`／`2a86bed` | Local Git Worktree／Commit／Push 與 Secret、Scope、並行碰撞 Preflight |
| A007-A008 | PR #33-#34，Merge `dd0372f`／`d24cf4e` | `gh` transport、PR／CI／Status／Auto-merge／Conflict；精確 Head SHA gate |
| A009-A010 | PR #35-#36，Merge `a90a2f`／`56f5fd` | Signed Webhook durable Inbox 與 Linear／GitHub authoritative reconcile read-back |

## Phase 3B Provider、Quota、Safety Runtime 已驗證證據

| Task | Merge／PR | 已驗證內容 |
|---|---|---|
| R001-R002 | PR #37-#38，Merge `cfde4d1`／`01d59bd` | Bounded Child Process、外部 Checkpoint、Provider Job Protocol、外部資料權限邊界 |
| R003 | PR #39，Merge `a8896fd` | Codex app-server Runner、動態 Approval、結構化 Interrupt、Crash Checkpoint |
| R004 | PR #40，Merge `4ae437c` | Claude stream-json Runner、唯讀 Reviewer、permission denial 優先於 exit 0 |
| R005 | PR #41，Merge `df043b2` | Gemini JSON 視覺 Reviewer、read-only policy、實際模型證據與 zero-change proof |
| R006 | PR #42，Merge `9f4b090` | 角色模型有序路由、不可用／Slot／額度備援、執行中不回切、Gemini visual-only |
| R007 | PR #43，Merge `df1456a` | 帳號／CLI 版本／時間綁定的週與 5h 三態額度；unknown fail-closed、刷新一次、3% Checkpoint |
| R008 | PR #44，Merge `8b9f8fe` | 七大危險類別、相似命令同類、未知 fail-closed、專案長期允許仍稽核、Process 前攔截 |
| R009 | PR #45，Merge `9dc10e5` | Preflight→WIP Commit／Push→私有 YAML→Linear 摘要；Push／Crash 失敗仍保留可復航 Checkpoint |
| QP01 | Quota Probe Spec v2／本分支 | Claude Status Line＋stable auth/version bounded epoch；Codex App Server weekly-only partial；private `quota probe-status` 零 admission／Job／Lease／model turn |
| QP02 | Quota Probe Spec v2／本分支 | Claude full/fresh接既有policy-backed new-Job admission；quota先於liveness/claim/Lease/Job；Codex未接admission；Q01 exact fallback語意不變 |

Track B Gate 在 main `9dc10e5` 上重跑 10 個相關測試檔、97／97 通過；R009 合併後 main CI Run `30957008043` 通過完整品質 Gate。R007-R009 各 PR 均綁定精確 Head SHA、CI 與 `agent-team/review` status；因本 session 的 Claude review 路徑持續回傳空結果，這三張採目前 Agent 的獨立 AC pass，並已在各 PR 證據留言揭露非 fresh-context 限制。

## 維護規則

1. 新增或修改規格條款時，必須先更新需求基線並重新核可，再更新本矩陣。
2. 新 Task 必須至少對應一個規格 ID；沒有需求來源的工作不得直接進入實作。
3. `已規劃` 只能在證據可 Read-back 後改為 `已驗證`。
4. Task、Test／Probe 或 ADR 連結失效時，Contract Test 必須阻擋合併。
5. Release 前由 D004 對本矩陣與規格第 18 節逐列收尾。
