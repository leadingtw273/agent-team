# Agent Team Core：人類主導交付工作流規格

狀態：已核可；Claude Opus 初審 4 個 blocker 已修正，定向複驗 PASS  
日期：2026-08-21  
裁決者：leadi  
適用範圍：所有由 Agent Team 註冊與管理的專案

## 1. 決策摘要

Agent Team 採用「人類主導交付」作為所有專案的預設工作方式：Agent 負責可客觀驗證的工程工作，使用者保留產品判斷與可直接修改產物的權力。系統不把每張工單都推向同樣沉重的驗證，也不把產品驗收誤用成故障處理。

本規格固定以下核心規則：

1. 新工單使用白話標題與三句人類摘要，既有 Agent Ready Packet 保持不變。
2. 每張工單明確標示「人類驗收」與「驗證強度」。
3. 工程 Gate 通過後仍由既有 AutoMergeGate 自動合併；需要人類驗收的工單在合併後留於「審查中」，直到使用者接受。
4. 不需要人類驗收的工單在合併後直接完成。
5. 「需人工」只代表自動化失敗、安全阻塞或必須人工介入，不代表產品驗收。
6. 使用者可直接調整產品產物，再由 Team Lead 收件、清除工具雜訊、做最低充分驗證並納入正式 Git 流程。
7. 新單立即生效；舊單只在再次啟用或實際修改時遷移；不批次重寫已完成、已取消或純歷史工單。

## 2. 元前提覆核（四問）

### 2.1 目標使用者

- 主要使用者是以自然語言指揮工作的專案負責人／產品負責人；Tank Skirmish 中即遊戲總監 leadi。
- 隱藏使用者包含 Team Lead、實作者、Reviewer、維運者與稽核者。
- 使用者不需親自處理 Git，但可直接修改工作產物並要求 Team Lead 收件。

### 2.2 類似系統

- 類比是一般人類主導的軟體／遊戲團隊：工程團隊交付、負責人判斷產品效果，兩者不是同一個 Gate。
- Linear 是工作與產品驗收狀態的可視界面；GitHub 是程式碼、PR、CI 與 merge 的權威。
- Agent Team 不建立另一套看板，也不把學習工具本身當成產品目標。

### 2.3 Identity

- Agent Team 是通用的人類主導自動化核心，不是 Tank Skirmish 專用腳本，也不是只追求無人值守的流水線。
- Tank Skirmish 是正式產品專案，不是 Agent Team 的測試沙箱。
- 人類直接調整場景或內容是正式協作方式，不是繞過流程的例外。

### 2.4 真正動機

- 讓使用者快速看到、操作並判斷產品，而不是把大部分時間耗在重複驗證與流程基礎設施。
- 保留高風險變更所需的嚴格安全性，同時讓一般玩法、視覺與內容工作只做足以支持決策的驗證。
- 避免同一問題不斷擴張成新 threat model、fixture framework 或與當前交付無關的治理工作。

覆核結果：方向相較舊規格有實質調整，但沒有改變 Agent Team「長期可維護本機工具」的產品定位。新維度是使用者可直接編輯產品產物；此能力服務於產品決策，不把 Godot 學習變成 Agent Team 目的。

## 3. 名詞與權威來源

### 3.1 核心名詞

- **人類主導交付**：Agent 完成工程交付，人類保留產品判斷與直接修改權的預設協作模式。
- **人類摘要**：Linear Description 最上方給人閱讀的三句摘要；Tank 專案可顯示為「導演摘要」。
- **Agent Ready Packet**：現有由固定 Heading 組成、供 Controller 解析與派工的結構化需求內容。
- **工程完成**：精確 PR Head 已通過要求的工程 Gate、經 AutoMergeGate 合併，Job 完成且 Lease／claim 已釋放。
- **人類驗收**：工程完成後，由使用者依產品結果判斷接受或要求微調；不是 merge authorization。
- **最低充分驗證**：依工單風險只執行足以證明本次 AC、直接回歸與安全不變式的最小驗證集合。
- **人類修改收件**：Team Lead 將使用者直接修改的工作樹變更，經意圖辨識、雜訊分離、最低充分驗證後納入正式 Git 流程。

### 3.2 權威矩陣

| 事實 | 唯一權威 |
|---|---|
| PR 是否合併、精確 merge commit | GitHub |
| CI、review status、AutoMergeGate | GitHub 與既有 Agent Team receipts |
| Job 工程生命週期、Lease／claim | Agent Team 私有持久化狀態 |
| 工單工作狀態與顯示標籤 | Linear 權威 read-back；但不得反推人類驗收已接受 |
| 人類是否接受產品結果 | durable acceptance record；來源限註冊 owner／指定裁決者的明確裁決，Linear 只作顯示與稽核 |
| 使用者直接修改的實際內容 | Git working tree／diff read-back |

## 4. Linear 人類閱讀契約

### 4.1 標題

- 新工單標題用結果導向白話描述，讓使用者不開 Description 即可理解目的。
- 禁止只用內部代號、元件名或實作方法當標題。
- Agent identifier 可保留在 metadata、branch 或既有機器欄位，不佔用人類標題主體。

範例：

- 採用：`讓坦克可前進、倒車與原地轉向`
- 不採用：`Implement CharacterBody3D controller`

### 4.2 人類摘要

新工單 Description 最上方增加一個獨立 Heading：

```markdown
## 人類摘要（給專案負責人）

- 要做什麼：<一句話>
- 完成後會看到／能操作什麼：<一句話>
- 如何驗收：<一句話>
```

專案可把 Heading 顯示成更貼近角色的名稱，例如 Tank Skirmish 使用 `導演摘要（給 leadi）`，但三個欄位語意固定。

人類摘要不得取代、縮減或改名 Agent Ready Packet 的既有 Heading。Parser 只解析既有已知 Heading；人類摘要是額外且唯一的未知 Heading。

語意是否一致由 Team Lead 在建單／遷移期判斷，不假裝由 deterministic parser 理解自由文字。若 Team Lead 發現語意衝突：

1. Ready Gate fail closed。
2. 不啟動 provider、不建立 Job、不建立 Lease／claim。
3. Team Lead 修正兩者並重新取得權威 read-back。
4. 實作者與 Reviewer 不得自行選擇其中一份。

Ready Gate 可機械判定並測試的範圍固定為：

- 三個摘要欄位 Heading 與非空值都存在。
- 摘要沒有複製或偽造任何 Agent Ready Packet 固定 Heading。
- 核可快照同時保存 human summary digest 與 Packet／requirement digest；核可後任一內容漂移都走既有 `requirements_changed`，不得派工。

Ready Gate 不執行 LLM 語意比較。Team Lead 對齊完成後才可形成核可快照；機器保證核可後兩份內容不會各自漂移。

### 4.3 新 Label Group

所有註冊專案都必須具備兩個單選 Label Group：

`人類驗收`

- `需要`
- `不需要`

`驗證強度`

- `輕量`
- `標準`
- `嚴格`

Team Lead 在建單時決定兩個值；使用者可覆寫。實作者不可更改或降低等級。Reviewer 可要求升級驗證強度，但必須指出本工單直接風險，不能藉此擴張範圍。

缺任一分類的新工單不得通過 Ready Gate。既有專案只在新 Label Group 與 Template 已完成 provisioning read-back 後切換強制檢查；在切換前禁止建立新工單或啟用舊工單，既有 in-flight 工單依 §9.1 的固定相容路徑收斂。

## 5. 驗證強度

驗證強度只調整工程 Gate 之上的額外驗證量。專案既有 required CI、required review status、取消／head drift／BEHIND／external merge 檢查與唯一 `AutoMergeGate.enable` 入口，是三種強度共同且不可降低的下限。

### 5.1 輕量

適用：視覺擺放、內容調整、低風險參數、純可逆產品變更。

最低集合：

- 針對本次變更的靜態／格式檢查。
- 執行該專案對此 change region 已註冊的單一 runtime smoke；若沒有對應 smoke，執行專案全域 boot smoke，且沒有直接錯誤。
- 若標示需要人類驗收，以使用者產品判斷作為最終產品接受依據。
- 繼承本節開頭的共同工程 Gate 下限；輕量只省略額外證據與多輪驗證，不省略 required CI、review status 或 AutoMergeGate。

不要求為主觀視覺選擇建立完整自動 fixture、像素級矩陣或多輪模型驗證。

### 5.2 標準

適用：一般程式、遊戲操作、碰撞、普通功能與可逆行為變更。

最低集合：

- 與變更直接相關的 targeted tests。
- 專案既有必要品質命令。
- Runtime／scene boot smoke，且無直接錯誤。
- 一次 fresh-context 獨立 review。
- GitHub CI 與既有 merge gate。

### 5.3 嚴格

適用：安全、權限、資料、部署、破壞性操作、Agent Team Core lifecycle／merge／claim／lease 等不可輕易復原的不變式。

最低集合：

- 完整相關測試與明確負向測試。
- 獨立 fresh-context 驗收。
- 涉及跨 provider trust boundary、權限／secret、不可逆 mutation 或 Agent Team 自身 merge／lifecycle 不變式時，必須跨模型 review；其餘嚴格工單由 Team Lead 在核可快照明列是否需要。
- 精確 read-back、crash／retry／idempotency 證據。
- 既有所有安全與 merge invariants 不得降低。

### 5.4 驗證收束

- 第一輪 review 可提出本工單直接 blocker。
- 修正一次後，第二輪只驗原 blocker 與其直接回歸。
- 新增但不影響原 AC 的改善列為後續建議，不阻擋本工單。
- 同一義務第二次仍失敗時進行範圍復盤；第三次不得繼續擴張，必須啟動既有「驗收範圍熔斷」。
- 不得因假想未來需求建立本次不需要的 framework、fixture 平台或新產品義務。

## 6. 人類驗收生命週期

### 6.1 不需要人類驗收

```text
待執行 → 進行中 → 審查中 → GitHub merged → Linear 已完成
```

- Review 與 AutoMergeGate 成功後依既有流程合併。
- GitHub merged read-back 觸發 Job completed、Lease／claim release 與 Linear Done。

### 6.2 需要人類驗收

```text
待執行 → 進行中 → 審查中 → GitHub merged
                                  ├─ Job completed
                                  ├─ Lease／claim released
                                  ├─ 下游工程依賴可解除
                                  └─ Linear 保持審查中，等待人類驗收

人類接受 → Linear 已完成
人類要求調整 → 原工單保持審查中；建立 linked adjustment issue
```

重要不變式：

1. 人類驗收不是 merge gate，不新增人工 merge approval。
2. 唯一 merge 入口仍是既有 `AutoMergeGate.enable`；不得 force、skip 或 bypass。
3. 工程完成與產品接受分開持久化，不能只靠 Linear 狀態推測。
4. `需人工` 不得拿來表示等待人類驗收。
5. 需要驗收的工單合併後，Agent status 不再顯示執行中或等待 provider；它是工程已完成、產品待接受。
6. Job 完成與 Lease／claim 釋放後，不得因 Linear 還在審查中重新派工同一 issue。

### 6.3 下游依賴解除

需要人類驗收的前置工單，不必等 Linear Done 才解除下游工程依賴。Controller 必須以以下全部精確證據判定：

- 前置 issue 當前綁定的有效 Job 已 completed，且沒有其他 active Job／Lease／claim。
- Job 綁定 PR 的 exact head 已由 GitHub read-back 為 merged。
- merge receipt 與 merge commit 已持久化。
- Lease／claim 已釋放。
- 前置工單未取消、未被 reopen、未發生 requirement identity 漂移。

只有 Linear `審查中` 或一則留言不足以解除依賴。外部合併仍依既有 provenance 與暫停規則處理，不得冒稱為 Agent Team 授權。

### 6.4 人類驗收紀錄

每個待人類驗收項目至少持久化：

- projectId、issueId、jobId
- PR URL／number、head SHA、merge commit
- 人類摘要與驗收步驟的 digest
- mergedAt、pendingSince
- acceptance state：`pending | adjustment_pending | accepted | invalidated`
- 依序遞增的 decisions[]：sequence、decision (`accept | request_adjustment`)、由受信任入口產生的 decisionReceiptId、decidedAt
- 依序遞增的 adjustments[]：sequence、decisionReceiptId、adjustmentIssueId、該 issue 的工程完成 receipt（完成後才有）

狀態 mutation 必須 CAS／冪等；`decisionReceiptId` 是一次人類裁決的冪等鍵。同一 receipt 重放不得重複留言、重複完成或重複建 adjustment issue；新的 receipt 才能開始下一個 sequence。

Record identity 綁定 `projectId + issueId + jobId + mergeCommit + requirementDigest`，同 issue 被 reopen 後產生新的工程世代，不覆寫舊 record。若原工單在 pending／adjustment_pending 期間被取消、reopen 或 requirement identity 漂移，舊 record 以一次 CAS 轉為 `invalidated`、留下去敏 drift finding；不得自動回改 Linear。Invalidated／accepted 舊世代不阻擋合法新 Job、不列入 pending UI，也不能作下游依賴解除證據。

### 6.5 接受與要求調整

- 只有專案註冊 owner 或明確指定裁決者，能透過受信任對話／UI 提交驗收裁決；不得從任意 Linear 留言解析驗收。
- 使用者明確指定原工單通過後，Team Lead 必須先 read-back exact issue 與 merge commit，再以 decision receipt 把 acceptance 設為 accepted，最後將 Linear 移至 Done。
- 模糊的「看起來可以」不得跨多張工單推論成全部接受；Team Lead 應列出待驗收項目請使用者對應。
- 使用者要求調整時，不 reopen 已完成的工程 Job、不重寫原需求快照；每個新的 decision receipt 建立一張小型 linked adjustment issue 並進入 `adjustment_pending`。該調整單工程完成後，原工單回到 `pending`，仍必須由使用者對原工單作新的明確 `accept` 或 `request_adjustment` 裁決；不得由子單完成自動推導原單 accepted。

## 7. 提醒與 UI

- 工程合併且需要人類驗收時，Linear 留一則去敏、冪等通知，包含看到／操作什麼與驗收方式。
- Team Lead 每次進入專案 handoff、status、continue 類互動時，主動摘要尚待人類驗收項目。
- Agent Team UI 提供 pending human acceptance 清單與 pending 數量。
- 不建立每日重複留言；提醒以對話／UI 聚合呈現。
- 沒有 pending 項目時明確顯示零，不把舊審查中工單誤列入。

## 8. 人類修改收件

### 8.1 用途

使用者可在 Godot 或其他產品工具內直接微調視覺、場景、參數或內容，保存後告知 Team Lead。這不是 Agent Team 的「教學模式」，而是負責人的正式產品決策。

### 8.2 收件流程

1. Team Lead read-back repo、branch、working tree 與完整 diff。
2. 依使用者說明分出刻意變更、工具自動生成雜訊與不明變更。
3. 可安全判定的工具雜訊不納入；不明變更只問一個最小必要問題。
4. 一律建立新的 linked adjustment issue，並在原待驗收工單保存連結；原工單與已完成 Job 永不重新派工。
5. 依該工單驗證強度執行最低充分驗證。
6. Adjustment issue 建立正常 Job 綁定後，以正常 branch／commit／PR／CI／review／AutoMergeGate 納入；不得建立無 Job 綁定的收件 PR，也不得直接改 protected default branch。
7. 完成後回報 exact commit／PR／issue，不要求使用者手動 Git。

Core v1 不新增任意自動提交 working tree 的 unattended CLI。收件先是 Team Lead 的受控 host operation；只有完成意圖、變更範圍與 repo ownership 的可信綁定後，才可另立工單自動化。

### 8.3 平行修改所有權

- 使用者宣告正在編輯的檔案／場景後，Team Lead 必須建立 project-scoped private durable reservation，至少綁定 owner、exact repo identity、canonical change regions、baseline revision／working-tree digest 與建立時間；使用者保存並通知收件或明確放棄後才由 Team Lead 冪等釋放。Agent 不得同時修改仍有效的人類擁有區域。
- Tank Skirmish 預設：使用者擁有正式場景、建築、地面、光照與鏡頭；Agent 優先修改隔離的 gameplay scripts、PackedScenes 與 tests。
- Admission 必須把核可工單的既有 change regions 與有效 reservation 作 deterministic overlap 檢查；重疊或無法 canonicalize 時在 Job／Lease／claim／provider 前 fail closed。沒有明確不重疊區域就不平行實作。
- 使用者保存並通知後，Team Lead 先讀取使用者 diff，再做整合；不得用生成版本覆蓋使用者變更。

## 9. 遷移政策

### 9.1 全域政策

- 新建工單自功能發布起立即使用新標題、人類摘要、人類驗收與驗證強度。
- 舊工單只有在下一次被啟用、移到待執行、實際修改需求或建立 adjustment issue 時才補齊白話標題、人類摘要、人類驗收與驗證強度。
- 舊工單遷移前不得自動派工；Team Lead 先補齊並 read-back。
- 已完成、已取消與只供稽核的歷史工單不重寫。
- 不做 workspace-wide 批次更新，不用缺省值猜測歷史意圖。
- 功能發布時已在 `in_progress`／`in_review` 且已建立 Job 的舊工單，不中斷、不補猜新 label，固定沿用舊相容路徑：工程 merge 後直接 Linear Done。它們完成後才切換專案 provisioning；不得把此相容規則用於新建或尚未派工的舊單。

### 9.2 Tank Skirmish 首次套用

- LEA-42 保持 Registration Audit Backlog，不轉成可執行工單。
- LEA-83～LEA-88 是已被新方向取代的 preflight-first 工單：逐張留下簡短取消原因並取消，保存歷史，不改寫成新功能。
- Core 上線後，下一批一次完整建立：
  - 坦克 W/S 前進倒車與 A/D 轉向。
  - 鏡頭只跟隨坦克平移，保留使用者定案角度與 size。
  - 地面／建築基本碰撞。
  - 使用者實機操作與手感驗收。
- 下一批不包含射擊、砲塔瞄準、AI、血量、HUD、音效。
- 批次先完整建單，再依依賴釋放執行波次。

## 10. 安全、隱私與相容性

- 新增人類驗收狀態不得弱化既有取消、head drift、CI、review status、BEHIND、external merge 與 direct-squash 前取消檢查。
- Linear／PR 留言只放產品摘要與去敏狀態，不放私有路徑、原始模型輸出、secret 或 received value。
- 舊 project config schema v1 仍可讀；本功能是全域預設，不以 project opt-in／kill switch 關閉。
- Registration reconciliation 新增 Label／Template 欄位時遵循既有 preview、confirm、read-back、fingerprint 與 idempotency 契約。
- 對既有專案的 provisioning 只補缺少的新物件，不重建同名物件、不改寫歷史 issue。
- Durable acceptance record 是人類驗收唯一權威。若 Linear 被人工移到 Done，reconcile 不得據此推導 accepted，也不得自動把 Linear 改回；它產生一筆可見 drift finding，等待 Team Lead／owner 裁決。

## 11. 非目標

- 不把使用者訓練成 Godot 工程師；操作說明只在協作需要時提供。
- 不建立另一個人工 merge approval。
- 不讓所有視覺工作都要求自動視覺 evidence。
- 不把產品待驗收映射為 `需人工`。
- 不在本功能自動提交任意未確認 working tree。
- 不重寫已完成或已取消的 Linear 歷史。
- 不藉此重構所有 lifecycle、registration 或 UI。
- 不改 Tank PR／程式碼來測 Agent Team Core。

## 12. 固定驗收條件

1. 新工單 Template 在 Agent Ready Packet 前顯示三句人類摘要，既有 parser 仍能解析所有固定 Heading。
2. 新工單缺 `人類驗收` 或 `驗證強度` 時，Ready Gate 在 provider／Job／Lease 前 fail closed。
3. 人類摘要三欄缺漏、複製固定 Packet Heading，或核可後任一 digest 漂移時，零 provider、零 Job／Lease／claim；語意對齊由 Team Lead 在核可前負責。
4. `不需要` 工單在 exact merged read-back 後完成，既有 happy path 不退化。
5. `需要` 工單在合併後 Job completed、Lease／claim released、Linear 保持審查中且 durable pending record 存在。
6. pending acceptance 工單不得被 generic dispatch 再次選中。
7. 使用者接受 exact issue／merge commit 後，Linear Done；命令重放不重複留言或完成。
8. 每個新的 `request_adjustment` decision receipt 只建立一張 linked adjustment issue；同 receipt 重放不重複建單，新的 receipt 可建立下一個 sequence，原 engineering Job 永不 reopen。
9. 下游依賴只在 exact merged＋completed Job＋release receipts 全部成立時解除，不靠 Linear `審查中` 推測。
10. 取消、head drift、CI 非綠、review status 不符、BEHIND、external merge、direct-squash 前取消的既有負向測試仍通過。
11. `需人工` 只用於故障／安全介入；不得只因等待產品驗收而進入該狀態。
12. UI 與 Team Lead status 只依 durable acceptance record 列出 pending／adjustment_pending，零項明確顯示零且不誤列一般 `審查中`；重複 reconcile 不製造重複 Linear 留言。
13. `輕量／標準／嚴格` 各有 admission、不可降級、reviewer 升級與驗證命令選擇測試。
14. 新單立即使用新契約；舊 Ready 工單未遷移不得派工；completed／canceled 歷史零 mutation。
15. Linear provisioning 對既有專案可預覽、確認、read-back 新 Label Group，重跑為 unchanged。
16. Tank 遷移只取消 LEA-83～88、保持 LEA-42，且不修改 Tank repo 程式碼。
17. 專案只有在新 Label／Template provisioning read-back 後才啟用新 admission；切換前不建新單、不啟用舊單，切換中的 in-flight Job 固定走舊完成路徑。
18. 人類修改收件遇到不明變更時停止並要求最小澄清，不得靜默丟棄或納入；收件必建 adjustment issue／Job，絕不直接寫 protected default branch。
19. 人類擁有 change region 存在未收件變更時，Agent admission fail closed；任何生成版本不得覆蓋該區域。
20. 人工把待驗收 Linear issue 移到 Done 不會建立 accepted record，也不觸發自動回改，只產生一次冪等 drift finding。

## 13. 澄清清單與裁決紀錄

| 問題 | 已採用裁決 |
|---|---|
| 使用者學 Godot 是否是 Agent Team 目的？ | 否；只是在產品驗收時保留直接調整能力。 |
| 使用者改場景後誰處理 Git？ | Team Lead 收件、分離雜訊、驗證並走正式 Git 流程。 |
| Linear 標題與 Description 怎麼讓人易讀？ | 白話結果標題＋最上方三句人類摘要；Agent Packet 不變。 |
| 摘要與 Packet 衝突怎麼辦？ | fail closed，由 Team Lead 修正，不讓 Agent 猜。 |
| 所有變更都要人類驗收嗎？ | 否；逐單標示需要／不需要。 |
| 需要驗收是否先卡住 merge？ | 否；工程 Gate 通過後自動合併，產品驗收在後。 |
| `需人工` 可否表示待產品驗收？ | 否；只用於故障、安全或必須人工介入。 |
| 合併後 Linear 用什麼狀態等待？ | 沿用 `審查中`，另以 durable acceptance record 區分。 |
| 工程 Job 與 Lease 是否等待人類？ | 否；合併後完成並釋放。 |
| 下游依賴是否等人類接受？ | 否；以 exact merge＋completed Job＋release receipts 解除。 |
| 驗證是否全部降為輕量？ | 否；依風險分輕量／標準／嚴格。 |
| Reviewer 可以無限擴大檢查嗎？ | 否；最多直接 blocker 修正與一次定向複驗，之後走範圍熔斷。 |
| 人與 Agent 可否同時修改？ | 可，但 change region 必須明確不重疊；人類編輯區禁止 Agent 寫入。 |
| Core 是否只給 Tank 開啟？ | 否；所有專案預設生效。 |
| 是否批次改寫所有舊工單？ | 否；新單立即生效、舊單按需遷移、不批次重寫歷史。 |
| Tank 舊 LEA-83～88 如何處理？ | 留原因後取消；LEA-42 保持稽核 Backlog。 |
| 下一批 Tank 功能是什麼？ | 移動、鏡頭跟隨、基本碰撞、使用者手感驗收；不含戰鬥系統。 |

## 14. 實作前提與停止條件

- 本規格須先完成 Claude Opus 唯讀 review；只修正直接 blocker，最多一輪定向複驗。
- 目前另一條 lifecycle branch／dirty worktree 的實作不得被覆蓋、stash、reset 或混入本 branch。
- 若既有 lifecycle 最終模型與本規格假設不同，先更新接合計畫，不在 code 中默默改寫產品語意。
- Core AC 與 fresh-context 驗收完成前，不對 Tank 歷史工單做 live mutation。
- 當前上位環境不允許新 subagent 時，以獨立驗證 pass 代替 fresh-context subagent，並明確揭露限制。
