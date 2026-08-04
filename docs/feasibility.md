# Agent Team v1 可行性與 Spike Gate 裁決

狀態：Phase 1 通過，附帶明確降級與註冊前置  
日期：2026-08-04  
證據範圍：S001～S006 真實 Probe、去識別 Fixture、Contract Test、GitHub PR／CI Read-back

## 1. 總裁決

**PASS WITH DEGRADATIONS**：可以進入 Phase 2 Domain Foundation。

至少一個 Provider 能在機械式安全邊界內擔任實作者；Linear、GitHub 與 Webhook 核心能力也都可自動化。現有降級沒有推翻需求基線，因為規格已要求未知額度 fail-closed、外部 Checkpoint、設定 mutation read-back，以及註冊未完成時不得派工。

這個裁決只允許開始建置 Core Domain，不表示專案已可全自動運行。下列能力仍保持關閉：

- 未取得新鮮 5h 額度訊號的 Provider 不接新工作。
- GitHub required Ruleset 尚未建立前，不使用 Auto-merge queue。
- Linear Project 尚未建立或選定前，專案維持 `setup_incomplete`。
- 外部 HTTPS Webhook Runtime／URL 尚未配置前，只能使用 Reconcile，不宣稱即時事件鏈已完成。

## 2. Provider 能力矩陣

| Provider | 第一版角色 | 裁決 | 可採用能力 | 降級／阻塞 | Runtime 必守邊界 | 證據 |
|---|---|---|---|---|---|---|
| Codex | 實作者、整合工程師、代碼審查者候選 | Adopt with degradation | 非互動 JSONL、唯讀沙箱、app-server Approval／Interrupt、週額度、結構化撞牆錯誤 | 5h bucket 未出現；Provider Thread 不是 Checkpoint | 鎖版本；Approval 仍經固定危險類別；5h unknown 時不啟動新 Codex Job | [S001](../spikes/codex/README.md)、`fixtures/providers/codex/` |
| Claude Code | 實作者、整合工程師、代碼審查者候選 | Adopt with degradation | stream-json、Team 登入辨識、唯讀 Review、週額度事件、Resume | 無動態非互動 callback；無結構化 Interrupt；5h 平時可能 unknown | denial 優先於 exit/result；核可後以收窄工具開新 Turn；TUI 刷新需鎖版本 | [S002](../spikes/claude/README.md)、`fixtures/providers/claude/` |
| Gemini CLI | 視覺審查者 | Adopt for visual review only | JSON 視覺輸入、read tool evidence、supplemental admin policy、unavailable 判定 | stream-json 視覺結果可截斷；SIGTERM 不可靠；不提供實作者能力或帳號額度 | 只用 JSON；工具固定 read-only；保存實際模型；不得排入寫碼／整合候選 | [S003](../spikes/gemini/README.md)、`fixtures/providers/gemini/` |

### 額度可用性裁決

額度能力按 Provider、帳號指紋、bucket、CLI 版本與擷取時間分開保存，狀態只有 `confirmed`、`stale`、`unknown`。未知不是 0%，也不是可用。

- Codex 週額度可採用；本次 `secondary=null`，5h 為 `unknown`，沒有可信手動刷新路徑。
- Claude 週額度事件可採用；5h 可透過版本鎖定的互動 TUI 作手動刷新降級，格式漂移即回 `unknown`。
- Gemini v1 只維護 available／unavailable，不從單次 token stats 推算帳號額度。
- 5h unknown 不阻擋 Domain／Adapter 開發，但該 Provider 不具新 Job eligibility。若所有實作者候選都 unknown／unavailable，工單必須顯示明確阻塞原因，不得空轉或偷偷放寬。

## 3. Platform 能力矩陣

| 平台能力 | 裁決 | 已驗證 | 未完成／降級 | 後續約束 | 證據 |
|---|---|---|---|---|---|
| Linear GraphQL | Adopt | Viewer、Team、Issue、Comment、Label Group／子 Label、Issue Template、取消與 read-back | 目前 0 個 Project | O003 註冊前必須建立或選定 Project；不得用 Team 冒充 Project | [S004](../spikes/linear/README.md)、`fixtures/providers/linear/` |
| Linear Upload | Adopt with cleanup degradation | signed URL、headers、PUT、Comment 嵌入成功 | Asset delete 回 `FEATURE_NOT_ACCESSIBLE`；一次完整 Probe 留下 1 個無引用純文字 Asset | 正式驗收證據本來就持久保存；測試／清理 UI 必須誠實顯示無法刪除 | [upload fixture](../fixtures/providers/linear/upload-capability.json) |
| GitHub PR／CI／Status | Adopt with read-back | Branch、Draft／Ready、Actions Checks、Head SHA Commit Status、Squash Merge | 同帳號不能原生 Approve | 用結構化 Review Comment＋`agent-team/review` Status；Push 後舊 review 一律失效 | [S005](../spikes/github/README.md)、`fixtures/providers/github/` |
| GitHub Rulesets | Adopt, configuration pending | Public Repo 的 Rulesets API 可讀 | count=0；main Branch Protection 未配置 | O004 必須預覽差異、取得使用者確認、provision、GET read-back；此前保持 `setup_incomplete` | [capability fixture](../fixtures/providers/github/repository-capabilities.json) |
| GitHub Auto-merge | Adopt with read-back | 設定已啟用；兩輪相同 PATCH＋GET 穩定為 true | 尚無 required Ruleset，不能形成強制 Gate | 能力開啟不等於允許排入 merge queue | [auto-merge fixture](../fixtures/providers/github/auto-merge-enabled.json) |
| Webhook 驗簽／Inbox 邊界 | Adopt | GitHub／Linear Raw Body HMAC、Delivery ID、Linear 60 秒窗口、duplicate、out-of-order、快速 ACK | HTTPS Runtime／Tunnel 不屬核心，目前未配置 | durable Inbox 成功後才回 200；外部 API／模型工作只能在 ACK 後 | [S006](../spikes/webhook/README.md)、`fixtures/webhooks/` |

## 4. 風險逐項裁決

| 原未知風險 | 結論 | 理由與防線 |
|---|---|---|
| Provider 能否機械攔截危險操作 | Adopt with guardrails | Codex 有 Approval callback；Claude 以 denial＋Checkpoint＋收窄新 Turn；Gemini 不執行寫入。禁止 bypass／yolo。 |
| 模型說完成是否可信 | Block self-report as evidence | 成功必須同時檢查 Process、結構化 Event、denial／error、Artifact／Git read-back。 |
| Provider Session 能否作唯一恢復點 | Block | 三個 Provider 都必須使用 Agent Team 的 Git＋結構化 Checkpoint；Session／Thread 只能輔助續作。 |
| 5h／週額度能否穩定取得 | Degrade／fail-closed | 週額度可用；5h 不完整。每 bucket 獨立維持 fresh／stale／unknown，unknown Provider 不接新 Job。 |
| Gemini 能否安全寫碼 | Block for v1 | 現有 Spike 只支持 read-only 視覺 Reviewer；未來須另開 Implementer Spike。 |
| Linear Label Group／Template 是否能自動建立 | Adopt | 真 mutation 與 read-back 成功；正式流程仍先做差異預覽，以 ID 對帳。 |
| Linear 檔案能否完整清理 | Degrade | 上傳可用但目前 Key 無 delete capability；不能把 Comment 刪除誤報成 Asset 刪除。 |
| GitHub 是否能強制 Review／CI Gate | Degrade until provisioned | API capability 已有，但 Ruleset 尚未配置。不得由 Controller 直接 merge 冒充 enforced gate。 |
| Private Repo 能否在目前方案配置 required Ruleset | Block on current plan | S005 的 Private Probe 回方案限制；核心經授權改 Public 後才解除。未來 Sandbox 建立前須由使用者選擇 Public 或升級方案，不得沿用舊 Plan 自動建 Private。 |
| GitHub 同帳號能否原生 Approve | Block／known limitation | GitHub 明確拒絕 self-approval；以結構化 Comment＋綁 Head SHA Status 表達內部 Reviewer 結論。 |
| Webhook 是否需要核心常駐 Server | Adopt external boundary | 核心只定 verifier／Envelope／Inbox；Runtime 只需提供設定 URL 與 Secret，不進 Core Domain。 |
| Webhook 重送／亂序會不會重複執行 | Adopt fail-closed | Provider＋Delivery durable dedupe；亂序先保存，交由 replay／權威 read-back 收斂。 |
| CLI／Schema／Policy 版本漂移 | Adopt with revalidation | Provider 版本變更後先重跑對應 Spike 與 Contract；未知 Event／欄位／policy 一律 fail-closed。 |

## 5. Phase Gate 與後續順序

S001～S006 均已有真 Probe 與去識別 Fixture，沒有發現需要改寫 Spec 的阻斷性矛盾，因此：

1. **允許開始 F001**，並依 Plan DAG 建置 Foundation。
2. R003～R005 只能實作本文件列出的角色能力；Gemini 不得升級為實作者。
3. R007 必須先實作逐 bucket `unknown` 與手動刷新降級，不能用估算補值。
4. O003 前先解決 Linear Project；O004 才建立 GitHub required Ruleset，且一定 read-back。
5. O005 前由使用者另外提供 HTTPS Webhook Runtime URL；Agent Team 不管理 Tunnel 實作。
6. E001 建立 Sandbox 前先 Probe GitHub 方案能力；目前方案下必須由使用者明確選擇 Public，或先升級支援 Private protection 的方案。
7. 核心流程穩定前不建立 Sandbox、不自我註冊、不復活舊 `agent-gamedev`。

## 6. 完成證據

| Task | PR／Merge | 核心證據 |
|---|---|---|
| S001 | PR #6／`55f1baf` | Codex exec、app-server Approval／Interrupt／rate limit 真 Probe |
| S002 | PR #7／`794bbe3` | Claude Team auth、exec、read-only review、permission denial、quota event 真 Probe |
| S003 | PR #8／`f232d59` | Gemini JSON 視覺、admin policy、unavailable、signal 真 Probe |
| S005 初驗 | PR #9／`4085a57` | Draft PR、CI、Commit Status、self-approval limitation、private-plan blocker |
| S006 | PR #10／`b68f1b2` | Webhook signature、dedupe、ordering、latency、post-ACK timeout Contract |
| S004 | PR #11／`d251d07` | Linear GraphQL round-trip、Label Group、Template、Upload 真 Probe |
| S005 公開重驗 | PR #12／`140f77f` | Repo public、Auto-merge 冪等 read-back、Rulesets capability／configuration 分離 |

每個 Merge 後 main CI 都已成功；精確 Run 與 PR 狀態仍以 GitHub read-back 為權威。
