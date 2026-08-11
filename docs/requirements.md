# Agent Team 本機第一版需求規格

狀態：已核可，實作中；2026-08-11 起依路線校正版 Roadmap 收斂第一輪 Sandbox Smoke Test  
日期：2026-08-04  
規格來源：leadi 與 Codex 的逐題需求釐清  

## 1. 鎖定前提

### 1.1 目標使用者

- 第一版主要使用者是 leadi。
- 使用者只和「團隊管理者」互動，不需手動操作 Linear、GitHub、Branch、PR 或 CI。
- 未來 Linear 看板可能加入真人工程師或美術同事，因此工單與流程必須保持一般 IT 團隊可理解的形式。
- 隱藏使用者包含未來維運者、審計者、Agent 實作者與 Reviewer。

### 1.2 類似系統

- 工作管理採 Linear，程式碼協作採 GitHub，流程類比現代 IT 團隊。
- Agent Team 不重做看板或 Git 平台，只負責把 Agent 執行、安全、額度與復航接進既有服務。
- Agent Team 與一般 IT 團隊的差異限於 Agent 執行狀態、額度狀態、危險操作核可與自動復航。

### 1.3 產品定位

- 第一階段是長期可維護的本機工具，不包裝成 Plugin。
- 架構保持單一核心與 Adapter 邊界，未來可低成本包裝成 Codex／Claude Code Plugin。
- 舊 `agent-gamedev` 正式廢止，只保留為唯讀歷史教材，不移植其 Producer、Supervisor、自建看板或檔案工單系統。

### 1.4 真正動機

- 使用者希望以自然語言交代需求，由團隊管理者完成拆單、派工、追蹤、審查、合併與異常說明。
- 消除舊系統的空轉、無人喚醒、狀態判定分裂、交接文字越權、共用 Worktree 競態與假綠燈。
- 避免為已有成熟服務的功能重新造輪子。

## 2. 第一版目標

建立一套可在 Linux／WSL2 本機運行的 Agent Team，完整走通：

1. 使用者與團隊管理者釐清需求。
2. 團隊管理者在 Linear 建立結構化待辦。
3. 使用者核可後，工單進入待執行。
4. Agent Team 根據角色、依賴、優先度、額度與併行限制接單。
5. 實作者在獨立 Worktree／Branch 完成工作並建立 Draft PR。
6. GitHub Actions 執行 CI；失敗時交回原實作者修正。
7. 獨立 Reviewer 依代碼／視覺需求驗收。
8. 所有 Gate 通過後啟用 Squash Auto-merge。
9. GitHub merged Webhook 將 Linear 工單更新為已完成。
10. 額度、安全、Crash 或人工暫停時能留下可接續 Checkpoint。

## 3. 第一版不做

- Codex／Claude Code Plugin Manifest、Marketplace、安裝器與自動升級。
- Linear Agent、Delegate、Agent Session、Linear Agent App 或 OAuth App。
- Trello Adapter、GitLab Adapter；只保留抽象邊界。
- SQLite、常駐 Agent Team Server、複雜排程服務或自建看板。
- Windows 原生環境；Windows 使用者走 WSL2。
- OpenAI／Anthropic／Google 的直接 API Key 計費模式。
- Gemini 自訂週額度牆。
- 專案權重、額度池比例、夜班窗口、活躍使用者額度門檻變化。
- Agent Team 自我註冊；先用獨立 Sandbox 驗證。
- 正式遊戲專案；舊 `agent-gamedev` 不復活。

## 4. 使用者互動模型

### 4.1 唯一主要入口

- 使用者主要與團隊管理者 Agent 對話。
- 團隊管理者負責需求釐清、查重、依賴分析、拆單、建單、優先度建議與異常翻譯。
- 使用者只需處理需求核可、危險操作核可、模型／額度設定與少數真正改變方向的決策。
- GitHub／Linear 的工程邊界異常由團隊管理者自行採保守規則處理並記錄，不逐項打斷使用者。

### 4.2 工單建立與核可

- 討論尚未收斂時不建 Ready 工單。
- 團隊管理者可建立 Backlog 工單；任何 Agent 發現的新工作也只能建立 Backlog。
- 使用者可在對話中核可，或在 Linear 將工單移到「待執行」。
- Ready Gate 不完整時，Agent Team Controller 不派工，將工單退回待辦並留言列出缺漏。

### 4.3 需求變更

- 小補充：不改驗收結果、風險、依賴、角色、審查類型或體量，可繼續並記錄。
- 實質變更：新增／刪改 AC、擴大範圍、增加外部服務或危險操作、改角色／依賴／審查類型、體量明顯增加。
- 實質變更必須 Checkpoint、退回待辦、更新規格並重新核可。
- 團隊管理者負責依上述機械條件初判；使用者是最終決策方。
- 可直接繼續的例子：修正錯字、補上既有名詞解釋、加入不改變 AC 的輸入範例。
- AC 上下界調整、新增 Edge Case、增加交付物或改變可觀察結果，都不是小補充。
- 團隊管理者無法確定時，一律視為實質變更並用單一摘要向使用者升報，不讓實作者或 Reviewer 自行裁決。

## 5. Linear 工作模型

### 5.1 專案映射

一個註冊專案固定對應：

- 一個本機 Git Repository
- 一個 GitHub Repository
- 一個 Linear Team 下的一個 Linear Project

Monorepo 第一版仍視為一個專案，以工單範圍指定目錄；同 Repo 多 Linear Project 延後。

### 5.2 主要工作狀態

```text
待辦 → 待執行 → 進行中 → 審查中 → 已完成
                       ↑       │
                       └───────┘ 審查未通過
```

- 待辦：需求可整理，不會自動執行。
- 待執行：Ready Gate 已通過；等待資源時維持此狀態。
- 進行中：實作、測試、CI 修正、Reviewer 修正。
- 審查中：CI 已綠，Reviewer 執行中或等待 Auto-merge。
- 已完成：只能由 GitHub merged 事件觸發。
- 已取消：只能由使用者透過團隊管理者或 Linear 明確要求；Controller 不會因逾時、失敗或 PR 異常自動取消。取消時停止、Checkpoint、關閉未合併 PR；第一版不自動刪除 Branch／Worktree。
- 暫停與阻塞不另建主要狀態，使用 Agent 狀態與阻塞原因表達。

### 5.3 原生欄位與 Label Group

- Assignee：真人責任人；Agent Team 永不自動修改。
- Agent 角色：單選 Label Group。
- 審查需求：單選 Label Group，值為代碼審查、視覺審查、雙重審查。
- Agent 狀態：排隊中、執行中、等待中、已暫停、已阻塞。
- 阻塞原因：等待依賴、週額度不足、5 小時額度限制、額度資訊無法確認、等待危險操作核可、整合異常、合併衝突、變更請求已關閉、未知錯誤。
- 阻塞原因同時多個時，Linear 顯示最需處理的一個；後台保存完整清單，解除後自動切換下一個。
- 沒有 Agent 角色的工單一律視為真人工作，不自動執行。

### 5.4 Form Template 與 Ready Gate

Form Template 使用中文輸入介面，詳細內容輸出成結構化 Description；Agent 角色與審查需求保留為可篩選的原生 Label Group。

Ready Gate 必填：

- 目標
- 背景
- 驗收條件
- 範圍內
- 範圍外
- 依賴關係（原生關係；沒有也須明示無）
- 優先度（不可為無優先度）
- Agent 角色
- 審查需求
- 預估體量（目標 15～30 分鐘；超過 45 分鐘先拆單）

選填：補充限制、預期風險、預期變更區域。沒有明確不重疊的變更區域時，同 Repo 不併行實作。

### 5.5 留言政策

- Personal API Key 的修改會顯示為使用者帳號，因此所有自動留言固定以 `🤖 Agent Team｜角色名稱` 開頭。
- Label 保存最新狀態；重要轉換保存成時間軸留言。
- 留言包含狀態／原因／後續動作／PR 或後台連結，不放完整模型對話、隱藏推理或 Secret。
- 視覺證據、危險操作摘要、模型切換、Checkpoint、審查結論與流程外合併必須留言。

## 6. 團隊角色

第一版核心角色：

- 團隊管理者（`team_lead`）
- 開發工程師（`implementer`）
- 代碼審查者（`code_reviewer`）
- 視覺審查者（`visual_reviewer`）
- 整合工程師（`integration_engineer`）

未來可新增前端工程師、後端工程師、遊戲工程師、運維工程師、美術設計師、美術工程師；第一版不細分。

Supervisor 與 Producer 不再是角色：

- Linear＋團隊管理者處理需求與優先序。
- 確定性控制程式處理排程、額度、租約、逾時、Checkpoint 與狀態轉換。

角色 MD 只定義行為、責任與品質標準，不保存模型、額度或平台設定。

## 7. 執行、Branch 與 Worktree

- 每張工單一個獨立 Branch 與 Worktree。
- Branch 命名包含 Linear ID，例如 `feature/ENG-123-login-api`。
- 第一個安全 Checkpoint 後建立 Draft PR；Draft 可跑 CI，但不啟動 Reviewer。
- 一張工單原則上一張 PR；需要多張獨立 PR 時先拆成 Sub-issues。
- 預設 Squash Merge，PR 保留完整 WIP 歷史，main 每張工單一個乾淨 Commit。
- 實作者執行中移除 Agent 角色時，先 Checkpoint、Push、釋放租約，讓真人可接手同一 PR／Branch。
- 執行中更換 Agent 角色視為實質需求變更。

## 8. CI、審查與合併

### 8.1 CI

- Agent Push 後由 GitHub Actions 自動跑專案 CI。
- CI 失敗交回原實作者在同 Branch 修正。
- 任何會改變 Runtime 行為、可執行代碼、Build、依賴、部署設定或生成管線的工單，都屬於「需要 CI」。Next.js、Node、Godot、CLI、Workflow 與 IaC 都在此範圍。
- 純 Markdown、純說明文件或不參與 Runtime 的靜態素材可不跑程式碼 CI，但必須使用文件、資產或視覺檢查契約。
- 沒有可執行 CI 的程式碼專案不得啟動一般自動開發；唯一例外是 `CI Bootstrap` 特殊工單。該工單須由團隊管理者核可，使用安裝／設定 Read-back、Workflow 語法檢查與獨立代碼審查驗收；合併後必須用第一個真 GitHub Actions Run 證明 CI 可用，失敗則專案維持設定未完成。

### 8.2 Reviewer 隔離

- Reviewer 使用全新 Session／Context，不讀實作者對話。
- 輸入限核可工單快照、AC、Repo、PR Diff、CI、專案規則，以及和 AC 直接相關的失敗 Log、效能基準、已知 Issue、資產或視覺證據。
- 不提供實作者中間對話、隱藏推理、臨時筆記、Handoff 建議或與 AC 無關的完整 Log。
- Reviewer 可用同一模型，但不可沿用同一 Session。
- 實作者不得自我核可。
- Reviewer 不另開 Linear 審查工單；同一工單進入審查中。

### 8.3 代碼審查準則

必查 AC、測試有效性、正確性、錯誤處理、邊界、安全、Secret、可讀性、模組邊界、維護成本、重複／過度設計、相容性、Scope 與文件／Migration。

Finding：

- 阻擋合併：必須修正。
- 後續建議：不阻擋；需要時另開 Backlog。
- 問題釐清：需求歧義，交回團隊管理者。

不得因個人風格偏好阻擋符合專案 Formatter／Lint 的代碼。

### 8.4 視覺審查準則與證據

- 視覺／雙重審查的專案必須註冊視覺證據產生指令。
- 證據可為截圖、錄影、渲染圖或前後比較，附標準 Manifest 與 AC 對應。
- Manifest 第一版為版本化 JSON，最少包含：`schemaVersion`、`issueId`、`commitSha`、`generatedAt`、`environment`、`artifacts[]`。每個 Artifact 必含 `path`、`mediaType`、`sha256`、`title`、`acceptanceCriteria[]`；完整 JSON Schema 在實作計畫定義並以 Fixture 驗證。
- 視覺 Reviewer 檢查版面、間距、層級、可讀性、風格一致性、尺寸／狀態、基本可及性、破圖／裁切／閃爍與視覺退化。
- 純主觀偏好不能阻擋，必須指出 AC、參考基準或可觀察問題。
- 核心證據必須上傳並嵌入 Linear 留言；過大檔案至少附關鍵影格、GitHub Artifact 連結與雜湊。
- 證據不足或上傳失敗不得合併。

### 8.5 GitHub 單帳號核可

- GitHub 不允許 PR 作者核可自己的 PR。第一版不使用原生 Approve 作為 Agent Reviewer Gate。
- Reviewer 留下結構化 Review Comment。
- Controller 針對精確 Head SHA 設定 `agent-team/review` Commit Status：pending／failure／success。
- Branch Protection 必須要求 CI 與 `agent-team/review`，不要求同帳號不可能提供的原生 Approval。
- 未來加入真人、GitHub App 或機器人帳號後可增加原生 Approval。

### 8.6 Diff Digest 與 Auto-merge

- Reviewer 通過時綁定核可需求快照與實際 Diff Digest。
- Merge 前重算；Digest 相同只重驗 CI，不重耗 Reviewer Token。
- 有效 Diff 改變時原核可失效，重新 CI 與審查。
- Reviewer 不自行 Merge 或標記 Done；Controller 啟用 Auto-merge。
- GitHub merged Webhook 是完成權威。
- 流程外合併仍更新 Linear Done，但留下缺少 Gate 的稽核警告、暫停新 Auto-merge，等待團隊管理者檢查；不自動 Revert。

### 8.7 合併衝突

- 簡單衝突先交原實作者處理一次。
- 語意衝突交整合工程師。
- 需求衝突交團隊管理者／使用者。
- 任何衝突解決造成有效 Diff 改變，都必須重新審查。

## 9. 模型與額度

### 9.1 Provider Runner

- Codex：本機 Codex CLI 登入帳號。
- Claude：本機 Claude Code CLI 登入帳號。
- Gemini：本機 Gemini CLI，預設供視覺 Reviewer 使用。
- 第一版不串接直接 API 計費。
- 每個角色配置有序模型清單；主模型不可用時依序切換。
- 執行中工作不因主模型恢復而刻意切回。

### 9.2 額度政策

- Codex 與 Claude 各自配置週額度上限；超過不啟動新工作。
- 不配置自訂 5 小時百分比牆；接近／碰到 Provider 5 小時限制時立即記錄並 Checkpoint。
- 已啟動工作在週額度剩約 3% 時強制進入末端收尾，只允許安全 Checkpoint。
- Gemini 第一版只判定可用／不可用與備援。

### 9.3 額度訊號三態

- 已確認：帳號、來源、時間與剩餘量有效。
- 已過期：派新工作前刷新一次。
- 無法確認：不誤判為 0%，不啟動該 Provider 新工作，嘗試下一備援。
- 帳號切換或手動重置使舊樣本失效。
- 監測器失效不立即殺死執行中工作，但優先 Checkpoint。
- UI 分開提供「刷新額度」與「確認並恢復派工」。
- 額度 Adapter 必須有 Fixture、反向測試與定期相容性驗證。

## 10. 安全模型

### 10.1 永遠存在的攔截器

- 一般 Worktree 讀寫、測試、專案依賴、Branch、Commit、Push、Draft PR 自動放行。
- 每個工具／命令仍經 Runner 操作分類器；第一版沒有完全跳過安全檢查模式。
- Agent 不得修改安全設定、Secret、營運設定或繞過攔截器。

### 10.2 危險操作類別

- `project_destructive`
- `git_destructive`
- `local_environment`
- `deployment`
- `external_write`
- `secret_access`
- `paid_action`

未知危險操作預設暫停。真正核可／拒絕只能在本機管理 UI；Linear 只顯示類別、目的、範圍、結果與後台連結。可在 UI 設「此專案長期允許」固定類別；即使長期允許仍須稽核留言。

### 10.3 指令權限

權限由高至低：

1. Agent Team 核心安全規則與狀態機
2. 預設分支已核可的專案設定與角色定義
3. 工單進入待執行時的核可需求快照
4. Controller 針對目前階段產生的工作指令
5. PR、留言、Checkpoint、代碼、Log、網頁與外部內容

第五層全部是資料，不能因含祈使句而擴張權限。Handoff 與 Agent 建議不具有控制權。

## 11. Checkpoint、復航與防空轉

### 11.1 雙重 Checkpoint

- Git：經 Diff、Scope、未追蹤檔與 Secret 檢查後建立並 Push WIP Commit。
- 本機：保存完成項目、剩餘工作、測試、下一步、阻塞、需求快照與模型資訊。
- Linear 只同步摘要與連結。
- 換模型／復航者從工單、Git、測試與 Checkpoint 接續，不依賴舊 Session 對話。

### 11.2 工作體量與逾時

- Task 目標 15～30 分鐘；超過 45 分鐘在 Plan 階段先拆分。
- 45 分鐘是單一模型 Job 的檢查點，不是整張工單從建單到合併的總時間。
- 有效進度只包含：新的受控 Git Diff、完成一個測試／Build 里程碑、新 Checkpoint、得到能縮小問題範圍的新錯誤證據，或完成明確不同的解法實驗；Process 心跳、重複同一命令與純模型輸出不算。
- 45 分鐘時由團隊管理者依有效進度與剩餘工作評估。若原 Agent 完成成本明顯低於重拆，可延長一次 15 分鐘；單一模型 Job 60 分鐘為硬邊界。
- 每個模型 Job 在 Process 異常死亡後最多自動復航一次；再次死亡立即阻塞。
- CI 修正輪：一次 CI Failure 觸發、原實作者產生新 Diff 並 Push，計一輪；最多兩輪。
- Reviewer 修正輪：一次阻擋合併 Finding 觸發、原實作者產生新 Diff 並 Push，計一輪；最多兩輪。
- 完整審查執行最多三次：初次審查加兩次修正後重審。單純 Rebase 且 Diff Digest 不變不計新審查。
- CI 與 Reviewer 上限分項計算，但任一先達上限就停止，不繼續消耗另一項額度。
- 超限即 Checkpoint、保留 PR／Branch、停止耗 Token，由團隊管理者診斷。

### 11.3 最小喚醒器

- Agent Team 沒有常駐 Server。
- 活躍 Controller 父 Process 即時監看 Agent 子 Process。
- `systemd --user timer` 每五分鐘執行 `agent-team reconcile --all`。
- 健康檢查是確定性 Script，不呼叫模型，不耗模型 Token；正常時只讀本機檔案後退出。
- 發現殭屍租約、死亡 Job、漏接 Event 或待派工項目時先做機械式修復；只有真正恢復工作才啟動模型。
- 無 systemd 時可由外部 Webhook Runtime 或 cron 呼叫同一命令；未配置時專案健康顯示降級。

## 12. 排程與併行

- 跨專案先按 Linear 優先度：緊急、高、中、低。
- 同優先度在專案間輪流；同專案依 Ready 時間先後。
- 新高優先單可超越未啟動工作，不強制中斷正在執行的工作。
- 預設全域 2 個模型 Job，包含 Codex、Claude、Gemini、Automated Team Lead、實作者、Reviewer 與整合工程師；每 Provider 1 個、每專案最多 2 個、同 Repo 整合／合併永遠 1 個。
- 執行中 Job 不被新高優先工作搶占。只有全域 Slot 空出後才重新選擇候選。
- 派工決策固定為：取得全域 Slot → 依優先度與專案輪替選工單 → 依角色模型順序逐一檢查 Provider 額度與 Provider Slot → 檢查專案／Repo Slot 與變更區域 → 取得租約並啟動。任何一步失敗都不占 Slot，工單保持排隊並繼續評估下一個安全候選。
- Primary Provider 額度不足、不可用或 Slot 已滿時，依模型順序嘗試備援；沒有可用候選才等待，不因 Gemini 尚有額度而突破全域上限。
- 同 Repo 只有 Ready Gate 明確宣告不重疊的變更區域才可併行；未知時序列化。
- 實際變更區域超出宣告且互相重疊時，Checkpoint 後由團隊管理者決定。
- CI、Webhook、健康檢查與機械同步不占模型名額。

## 13. 本機架構與資料

### 13.1 技術基底

- TypeScript 核心，編譯成 Node.js CLI；新專案統一 Node 24。
- 本機 UI 為靜態 HTML／CSS／少量原生 JavaScript。
- UI 使用固定版本 Tabler CSS 與 SVG Icons，SRI／CSP、無遠端 JavaScript，提供同版本離線 fallback。
- 第一版正式支援 Linux／WSL2；Process／SCM／PM／Provider 走 Adapter。

### 13.2 設定分層

- Agent Team 核心內建預設：標準角色、流程、狀態機。
- 專案 `.agent-team/`：版本化角色差異、測試／視覺命令、專案規則與平台 ID。
- `~/.agent-team/config/`：模型順序、併行、週額度、Webhook URL、專案長期安全許可。
- `~/.agent-team/secrets/`：Linear Key、Webhook Secret 等；權限 0600。
- `~/.agent-team/state/`：Job JSON、Event JSONL、Checkpoint YAML、Inbox、租約與額度樣本。
- 專案設定變更走 PR／審查／重新驗證；營運設定由 UI 修改，新設定只影響後續 Job。
- 設定 PR 沒有繞過品質 Gate 的快速通道，沿用一般 CI／Reviewer 修正與重審上限；Setup PR 在自動流程啟用前由使用者核可。
- Agent 無權修改 config、secrets 或長期安全許可。

### 13.3 檔案狀態可靠性

- 原子寫入後 rename、檔案鎖、Delivery ID 去重、Secret 遮罩。
- 第一版不自動刪除歷史；UI 可按專案／Job 檢視與手動清理。
- 不保存模型隱藏推理；保存經遮罩的命令摘要、stdout／stderr、Diff、CI、事件、額度與錯誤。

## 14. 管理 UI

頁面：總覽、專案、執行中、角色與模型、額度、安全、事件、設定。

- `agent-team ui` 按需啟動，只綁 `127.0.0.1`，不經 HTTPS Tunnel 對外。
- 啟動時產生一次性隨機 Session Token，僅存在 Process 記憶體；關閉失效。
- Mutations 需 Session 與 CSRF；閒置逾時自動鎖定。
- Secret 只能覆寫／測試，不能讀回完整明文。
- UI 關閉不影響一般工作；危險操作保持等待。
- 表單寫入設定，不要求使用者輸入行內 CLI 參數；提供進階 Raw YAML 檢視。

## 15. 外部服務 Adapter

### 15.1 Linear

- Personal API Key＋GraphQL API；Key 由 UI 寫到專案外 Secret。
- 不使用 OAuth、Linear Agent、Delegate 或 Agent Session。
- 註冊驗證 Viewer、Team、Project 與讀寫權限。
- UI 掃描並預覽後建立中文工作狀態、Label Group 與 Form Template；不刪除或靜默改名既有項目。
- 物件以 ID 儲存，不依賴顯示名稱。

### 15.2 GitHub

- 本機 Git 負責 Branch／Worktree／Commit／Push；官方 `gh` CLI 負責 PR、Checks、Status、Auto-merge 與 Reconcile。
- UI 驗證 CLI、登入帳號、Repo 與必要權限，不複製 PAT。
- Branch Protection／Ruleset 先掃描差異；使用者在 UI 核可後可一鍵套用，不靜默降低既有保護。
- SCM 核心抽象為 Change Request、Check、Review、Merge Policy，日後可加入 GitLab／`glab`。

### 15.3 Webhook Runtime

- HTTPS Webhook Runtime 與 Tunnel 是第一版全自動模式的必要前置，由使用者另外提供；Agent Team 只配置 Base URL，不綁定 ngrok、cloudflared 或其他產生方式。
- Runtime 必須保留 Raw Body、Headers 與 Delivery ID，呼叫標準 Ingest Command。
- Agent Team 核心驗證 GitHub／Linear Signature、原子寫入 Inbox、去重後快速返回，再由短命 Process 處理。
- 同一 Base URL 使用 `/webhooks/github` 與 `/webhooks/linear`。
- Webhook 漏接由 Reconcile 補齊；Reconcile 是災難恢復而非主要事件來源。
- 沒有可驗證 Webhook 時，專案維持「設定未完成」，只能做 UI 手動 Probe／Reconcile，不允許宣稱無人值守。團隊管理者會引導使用者提供 Runtime 與 Tunnel，再由註冊 Probe 驗證簽章、Delivery ID、回應時間與雙向事件。

## 16. 專案註冊與可信設定

1. UI 唯讀檢查本機 Repo、GitHub、Linear、CLI、CI、Webhook 與環境。
2. UI 收集設定；Secret 寫到專案外。
3. 建立 `agent-team/setup` Worktree／Branch，寫入 `.agent-team/`。
4. 建立 Setup Draft PR；合併後只從預設分支載入可信設定。
5. 主動 Probe：建立 Linear 測試單（最後取消）與 GitHub Draft PR（最後關閉），驗證讀寫、CI、Status 與 Webhook。
6. 主動 Probe 不宣稱已驗證真正 main 合併；第一張真工單完成才證明 Auto-merge 全鏈。

專案健康：

- 設定未完成：任何必要註冊 Gate 尚未通過；不自動派工。
- 已註冊：全部必要 Gate 通過，可自動派工。
- 降級：已註冊後發生非破壞性 Adapter／Webhook／額度監測異常；正在安全階段的工作可 Checkpoint，但停止受影響的新派工與 Auto-merge。
- 已停用：只能由使用者主動設定；不自動派工或恢復，既有工作先 Checkpoint。
- Revalidation 全綠可由設定未完成／降級回到已註冊；已停用必須由使用者明確啟用後再 Revalidate，不依時間自動轉移。

每張工單只做輕量唯讀 Preflight；完整 Revalidation 由 UI 手動觸發並允許建立 Probe。

## 17. 第一個驗證專案

- 新建乾淨的 `agent-team` Repository 開發本機核心。
- 新建極小的 `agent-team-sandbox` Repository 做第一個被管理專案。
- Agent Team 核心在流程穩定前不自我註冊。
- 舊 `agent-gamedev` 不作 Sandbox、不遷移、不修改。

Sandbox 必驗：

- 註冊與 Setup PR
- Linear 建單、Ready Gate、依賴與角色
- Worktree、Draft PR、CI 成功
- CI 失敗修正
- 代碼 Review 成功／失敗／重新審查
- 視覺證據上傳與雙重審查
- Diff Digest 防偷換
- Auto-merge 與 Linear Done
- 額度過期／未知／備援切換／末端 Checkpoint
- 危險操作等待、核可、拒絕、長期允許與稽核
- Process 死亡、殭屍租約、漏接 Webhook 與五分鐘復航
- 真人接手、取消與流程外 GitHub 事件

## 18. 第一版驗收出口

只有以下全部具備證據才算完成：

- Sandbox 端到端成功完成至少一張代碼審查工單與一張雙重審查工單。
- 每個主要失敗分支至少有一個自動化測試或可重跑 Probe。
- 實際殺死 Agent 子 Process 後，五分鐘內自動復航或清楚阻塞，不空轉。
- 額度訊號失效時不誤判、不啟動不安全的新工作，UI 可刷新與恢復。
- 危險操作未核可前不執行，核可／拒絕均在 Linear 留有摘要。
- Merge 前需求快照、CI、Reviewer、Head SHA 與 Diff Digest 一致。
- Linear、GitHub、UI 與本機狀態能互相對帳，沒有假綠燈。
- 提供使用者可親測的完整操作案例與啟用說明。

## 19. 高階實作順序（非執行 Plan）

1. 可行性 Spikes：三種 CLI 安全攔截、額度訊號、Linear 上傳、GitHub Status、Webhook Ingest。
2. Domain Core：Schema、狀態機、Event、租約、Checkpoint、Adapter Contract。
3. Git／GitHub 與 Linear Adapter。
4. Provider Runner、模型路由、額度與安全攔截。
5. Dispatcher、Controller、Reconcile 與 systemd Timer。
6. 本機管理 UI 與註冊精靈。
7. Sandbox CI／視覺證據與端到端驗證。
8. 文件、親測案例與第一版收尾。

詳細可執行 Plan 必須在本規格核可後另寫並再次 Review。

## 20. 舊 `agent-gamedev` 教訓

- 自建看板／檔案工單讓狀態真實來源分裂；改由 Linear 成為工作記錄權威。
- Gate 數 approved 檔案、Claim 卻看 Branch，造成幽靈工單與 27 輪空轉；新系統共用同一 eligibility 判定。
- 只在有人互動時檢查，Process 死後無喚醒；新系統加入不耗 Token 的五分鐘 Reconcile Timer。
- 共用主 Worktree 內 Claim／Checkout 與白天操作競態；新系統每工單獨立 Worktree。
- Handoff 的祈使句越權合併；新系統固定指令權限層級，Handoff 永遠是資料。
- 測試假綠、環境變數污染與 Fixture 過度理想化；新系統要求真 CI、反向驗證、Probe 與實際流程證據。
- 大工單造成長 Context、零寫入與反覆拆補；新系統在 Plan 階段控制 15～30 分鐘粒度。
- 夜班與活躍度額度規則過早複雜化；新系統改為全天條件驅動，由 UI 配置明確週額度。
- Agent 自述「誰改了什麼」不可靠；以 Git Diff、Commit、CI、Digest 與 Event 對帳。
- 狀態、事件、Unit 生死與產出缺一不可；健康檢查使用多來源判定，不能靠單一訊號。

## 21. ADR

### ADR-001：採用外部專案管理與版控服務

背景：舊系統自行建置看板、檔案工單與合併流程，成本高且狀態分裂。  
決策：Linear 是工作管理權威，GitHub 是代碼／CI／Merge 權威，Agent Team 只做整合與執行。  
被否決：自建看板；Trello 第一版；僅做內容映射而不圍繞服務流程。  
影響：必須實作 Provider-neutral PM／SCM Adapter，並接受外部服務可用性。

### ADR-002：本機核心優先，Plugin 延後

背景：過早自我註冊與 Plugin 化曾造成進度空轉。  
決策：第一版為本機 TypeScript／Node CLI＋UI，保留邊界但不做 Plugin 包裝。  
被否決：第一版同時發布 Codex／Claude Plugin；繼續在舊 Repo 疊加。  
影響：先驗證工作流；未來包裝不得改寫 Core Domain。

### ADR-003：不使用 Linear 原生 Agent 身分

背景：第一版要輕量且先驗證流程，不需要 Delegate／Agent Session。  
決策：Personal API Key＋GraphQL；Agent 身分以 Label Group 與固定留言標頭表達。  
被否決：Linear Agent App、Delegate、OAuth。  
影響：Linear 操作顯示為使用者帳號，必須明確標示自動化留言；多人化時再改 OAuth。

### ADR-004：無常駐 Server，但保留最小 Reconcile Timer

背景：完全無 Timer 時，整個 Process 死亡後無法自我喚醒。  
決策：Webhook 事件驅動＋五分鐘短命 Reconcile Script；UI 按需啟動。  
被否決：常駐 Agent Team Server；完全不輪詢。  
影響：Linux／WSL2 需 systemd user timer 或外部等價喚醒來源。

### ADR-005：檔案式狀態而非 SQLite

背景：第一版追求本機可查、可搬與低維運成本。  
決策：JSON／JSONL／YAML＋原子 rename、鎖與去重。  
被否決：SQLite；以 Repo 文件當 Runtime State。  
影響：必須嚴格定義 Schema、租約、恢復與 Compaction 邊界。

### ADR-006：獨立 Reviewer＋Commit Status Gate

背景：每張單需功能與品質驗收，但單一 GitHub 帳號不能 Approve 自己的 PR。  
決策：Fresh-context Reviewer、PR Comment、`agent-team/review` Required Commit Status、Diff Digest。  
被否決：實作者自驗；假裝同帳號可原生 Approve；僅靠 Linear 留言。  
影響：Branch Protection 與 Status API 權限成為註冊 Gate；未來可再加真人 Approval。

### ADR-007：安全核可只在本機 UI

背景：Linear 留言可被誤解或冒用，不適合承載高權限核可。  
決策：Linear 顯示摘要，真正核可／拒絕與長期許可只在 localhost UI。  
被否決：從 Linear 留言核可；完全跳過權限檢查。  
影響：UI 必須有一次性 Session、CSRF、Secret 不回顯與稽核紀錄。

### ADR-008：舊專案廢止，Sandbox 先行

背景：舊 `agent-gamedev` 混合團隊系統與遊戲內容，已累積大量結構性負債。  
決策：新建 `agent-team` 與 `agent-team-sandbox`，舊 Repo 只讀保存。  
被否決：原地重構舊 Repo；直接讓 Agent Team 自我管理；直接拿正式遊戲試跑。  
影響：需從教訓重新設計，不做代碼搬運；Sandbox 成為第一版出口。

## 22. 澄清清單

- [x] 看板應自建或使用市場工具？答：Linear，Agent Team 不重做看板。
- [x] Agent Runtime 狀態與 PM 是否同一後台？答：拆分；Linear 管工作，localhost UI 管執行與敏感操作。
- [x] 真人未來能否使用同一看板？答：能；無 Agent 角色即真人工作。
- [x] 是否保留夜班與活躍度額度牆？答：移除，全天條件驅動。
- [x] Supervisor／Producer 是否保留？答：否；團隊管理者＋確定性 Controller 取代。
- [x] Codex／Claude 如何納入？答：角色模型順序與 Provider Runner，角色不綁模型。
- [x] Reviewer 如何拆分？答：代碼與視覺兩類，Fresh Context，雙重審查需皆通過。
- [x] GitHub／GitLab 如何抽象？答：SCM Adapter；第一版 GitHub，GitLab 延後。
- [x] 合併衝突由誰處理？答：原實作者一次、語意衝突整合工程師、需求衝突團隊管理者。
- [x] 額度如何避免誤判？答：帳號綁定的三態樣本、刷新與恢復分離、備援路由。
- [x] 危險操作如何核可？答：固定大類、localhost UI 核可，Linear 只顯示摘要。
- [x] Task 是否允許長時間？答：15～30 分目標、45 分檢查、60 分硬邊界。
- [x] Agent 卡死如何復航？答：父 Process Watchdog＋五分鐘無 Token Reconcile Timer。
- [x] Plugin 是否第一版就做？答：否，本機核心驗證後再包裝。
- [x] 是否使用 Linear Agent／Delegate？答：否，先用標準 Issue＋Label Group。
- [x] 工單角色放哪？答：Assignee 管真人責任，Agent 角色單選 Label Group 管自動派工。
- [x] Linear 自訂欄位如何處理？答：Form Template 收集資料，原生 Label Group 保存可篩選單選值。
- [x] Ready 資料不完整怎麼辦？答：退回待辦並留言缺漏，不建立 Job。
- [x] 一個專案如何映射？答：一個 Local Repo＋GitHub Repo＋Linear Project／Team。
- [x] Reviewer 是否另開工單？答：否，同工單跨完整生命週期。
- [x] 視覺證據放哪？答：標準 Manifest，核心證據必須附在 Linear 留言。
- [x] Checkpoint 保存什麼？答：遠端 WIP Commit＋本機結構化狀態。
- [x] 交接文字是否能下令？答：不能；只有核可需求與 Controller 能下令。
- [x] 真人如何接手？答：移除 Agent 角色觸發 Checkpoint 與租約釋放。
- [x] 同 Repo 如何併行？答：只有明確不重疊變更區域才允許。
- [x] 同帳號 GitHub Reviewer 如何核可？答：Required Commit Status＋PR Comment，不用原生 Approve。
- [x] 第一次用什麼驗證？答：獨立 `agent-team-sandbox`，核心不先自我註冊。
- [x] 舊 `agent-gamedev` 如何處理？答：廢止、唯讀留存，只汲取教訓。

## 23. 已知風險（不是未決需求）

- Codex／Claude／Gemini CLI 的危險操作攔截能力不同，必須先做 Provider Spike；無法機械攔截的 Provider 不得進入全自動模式。
- 供應商額度顯示格式可能變動，Adapter 必須能力偵測、Fixture 回歸與 fail-closed。Fixture 指已去除帳號與秘密的真實輸出樣本，只用於 Parser 回歸，不是把 Runtime 額度還原成固定值。偵測失敗先刷新一次，仍失敗就標示無法確認、嘗試下一備援，直到下次排程／手動刷新前不反覆重試。
- GitHub 單帳號 Status Gate 的信任邊界是本機使用者；公開多人產品需改用 GitHub App 或專用機器人。
- Personal Linear API Key 的操作歸屬使用者；多人散布時需改 OAuth。
- 檔案式 Event／Lease 在單機可行；多機、多租戶服務化時需要重新評估持久層。
- WSL2 systemd、Tunnel 與 Webhook Runtime 屬外部前置；註冊 Gate 必須誠實顯示未配置狀態。

## 24. 參考資料

- Linear GraphQL API：https://linear.app/developers/graphql
- Linear Label Group：https://linear.app/docs/labels
- Linear Form Template：https://linear.app/docs/issue-templates
- Linear File Upload：https://linear.app/developers/how-to-upload-a-file-to-linear
- GitHub PR Review：https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews
- GitHub Required Status Checks：https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- GitHub Commit Status API：https://docs.github.com/en/rest/commits/statuses
