# ADR：Linear-first 工作權威與 GitHub 程式碼權威

## 狀態

MVP 決策已核可；Claude Opus 第一輪找到 B1–B7 blockers，全部採納後第二輪 spec closure review `PASS`。實作期 code review 另指出 legacy／PR-create crash recovery、unsafe supersede 與公開 conflict evidence 缺口；本次依下述「實作收束」縮回最小安全閉環。

### 2026-08-26 實作收束

- legacy Job 與「GitHub 已建立 PR、但本機／Linear 尚未完成綁定」只在 deterministic branch、唯一 open PR、immutable back-pointer、Head 全部吻合時自動補 `job_started`／`pr_bound`。
- 已完整綁定的正常 Job 不進 recovery read-back；resume 維持原本快速路徑。
- 跨 Job 的 PR handoff 仍是未來設計方向，但本次不假裝已有安全的雙 Lease／successor checkpoint。遇到 open PR 的 `superseded` 會發布 `authority_conflict`、投影既有「已阻塞＋整合異常」並保持舊 Job 非 terminal；不關 PR、不發布假的 handoff／superseded，也不釋放 claim。
- admission 在尚無唯一 canonical Job／fence 可綁定時只 fail closed，不能猜一個 Job 發結構事件；issue-level 無 Job conflict publication 留待後續獨立 Task，不阻擋本次孤兒 PR recovery。

## 鎖定前提（judgment 四問）

- 目標使用者：leadi、Agent Team 接手 Job、Team Lead、未來維運與稽核者。
- 類似系統：以外部 issue tracker 作 collaboration/control plane，以 source-control provider 作 code/PR truth，本機 journal 只支援可靠執行與 crash recovery。
- Identity：Agent Team 是長期、可跨專案使用的自動開發基礎設施，不是單一 session 的私有自動化。
- 動機：人與 Agent 應從同一張 Linear 工單理解完整工作脈絡；未來能複查為何建立、交接、阻塞、審查與合併，而不是依賴某台機器上的隱藏狀態。

## 背景

目前 Linear 保存主要 workflow 狀態，但 PR identity、Head、細部階段與 recovery 判斷大量落在本機 Job progress。這讓本機逐漸成為第二套產品狀態：人類或新 Job 只看 Linear 無法理解上一手做到哪裡，PR #74 的孤兒 PR 是具體症狀。

涉及子系統：Linear issue/status/labels/comments、GitHub PR/commit/checks/merge、Job progress、Lease/CAS、dispatch/reconcile/handoff。

## 已確認決策

1. Linear 與 GitHub 都是權威資訊來源，也同時給人與 Agent 閱讀，並構成可複查的開發紀錄。
2. Linear 是工作的 collaboration/control plane：所有會影響工作交接、人類判斷與生命週期的狀態都必須可見且可機器讀取。
3. GitHub 是程式碼與 PR 真實狀態來源：branch、commit、PR、Head、checks、review、merge 必須由 provider read-back，Linear 不可單獨冒稱 GitHub 已發生的事。
4. 本機 Job progress 只保留執行機制：Lease、monotonic lease epoch、CAS revision、process/session、heartbeat、私密診斷、以 `(job, mutation intent, identity digest)` 為 key 的 durable attempt counter／pending intent，以及 crash checkpoint；不得成為 Linear 上完全不可見的重要業務決策。
5. 新 Job 接手前必須讀 Linear 工作脈絡並向 GitHub核對；本機與外部權威不一致時進 reconciliation，不默默偏信本機。
6. 現有 Label taxonomy 足以承載角色、審查／驗收／驗證政策與粗粒度 Agent 狀態；Label schema 自本 ADR 起凍結，本次零新增 Label／Label Group。
7. Job、branch、PR、Head、CI/review 細階段、交接與詳細阻塞原因不得新增 Label，改由結構化 lifecycle event 留言承載。
8. 未來只有「跨專案長期穩定、會改變派工或 Gate、且既有原生狀態／Labels／event 無法表達」的概念，經明確裁決後才能新增 Label。
9. Linear 只對七類 meaningful lifecycle transition 追加公開 event：Job 開始、PR 建立／Head 綁定、CI 結果或修復 Head 改變、第二模型審查結果、阻塞／暫停／等待人工、取消／取代／交接、合併／完成／外部合併。
10. Heartbeat、重複輪詢、相同 CI 狀態、模型輸出片段、CAS revision 與一般內部重試細節不寫公開 event；只有 `escalation_requested` 為主管裁決所需的 durable attempt count 是明確白名單例外。
11. 每個 lifecycle event 使用同一則 append-only Linear 留言承載「白話摘要＋隱藏的 `agent-team-lifecycle:v1` 封閉 JSON」。
12. 結構資料只允許固定 schema／closed enum／安全 identity，不解析白話內容作 mutation 授權，不保存模型 raw output、secret 或私密診斷。
13. 每個 event 使用依 event kind 封閉定義的 canonical identity 欄位形成穩定 event ID；retry 先 read-back，同一 event 不重複發布，已發布 event 不覆寫。不得把 timestamp 或未持久化的 retry attempt 放進 event ID。
14. 採欄位分權而非全域優先序：Linear 權威擁有需求、核可、workflow、取消／取代、人工驗收與交接；GitHub權威擁有 branch/commit/PR/Head/checks/review/merge 事實；本機只擁有 Lease/CAS/heartbeat/private diagnostics/pending mutation intent。
15. Linear 取消且 GitHub PR open：核對 identity 後依 Linear 意圖關閉；GitHub 已 merge 而 Linear 未完成：以 GitHub 事實留下 external-merge event 並收斂 Linear。
16. PR identity 不符或外部權威互相矛盾時，不選邊猜測；零危險 mutation，沿用現有 `已阻塞＋整合異常`，追加 authority-conflict event 並進 reconciliation。
17. Job 是 Linear 工單一次工作的持久實例，承載該次工作的 Job ID、branch／PR 綁定與 lifecycle identity；Controller 依這個 Job 實例選擇並分派 Agent 執行。
18. Agent execution/session 是可替換的執行者，不是新的工作身分；process crash、額度不足、模型切換或 Agent 換手時，原則上在新 Lease 下繼續同一 Job。
19. 只有明確取消舊嘗試、需求發生重大變更，或由另一工作嘗試正式取代時才建立新 Job；不得以單純重啟或換 Agent 為由建立第二個 Job。
20. PR 是 Linear 工單開發工作線的程式碼與審查紀錄，不固定隸屬單一 Job；同一時間只能有一個 Job 擁有該 PR 的自動化 mutation／merge 權限。
21. Job 交接預設保留原 PR：舊 Job 先終止操作權並釋放 Lease，Controller read-back PR／branch／Head，發布含舊 Job、新 Job、PR 與交接 Head identity 的 handoff event，再由新 Job明確接管。
22. 新 Job 接管原 PR 後，必須重新驗證 requirements、Head、CI、review 與 merge gate；handoff 不繼承舊 Job 的合併授權。
23. 只有工單取消、實作方向放棄、舊 branch 與新需求不相容，或 PR identity 衝突無法安全確認時才關閉 PR；Job 被取代本身不是關閉 PR 的充分條件。
23a. 上述 handoff 是目標語意，不是本次 MVP 的完成宣稱；在缺少雙 Lease 與 successor durable checkpoint 的現況下，`superseded` 必須依實作收束 fail closed。
24. 跨 Linear／GitHub mutation 發生部分成功或 `sent-unknown` 時，不做自動反向補償；Job 維持未完成，Controller 先 read-back，僅在 identity 與意圖仍完全一致時最多做一次冪等安全重試，再 read-back 驗證。
25. Controller 只處理有封閉規則且答案唯一的機械性 reconciliation；安全重試仍未收斂、外部權威矛盾、identity 漂移或需要理解工作脈絡時，必須停止並升級 Team Lead 裁決。
26. 升級 Team Lead 前，Controller 必須整理權威證據包：issue／Job／PR／Head identity、Linear 與 GitHub read-back、已嘗試操作、重試次數與待裁決事項；Team Lead 不從猜測或本機敘事直接下 mutation。
27. Team Lead 仍無法安全裁決時，沿用現有 `已阻塞＋整合異常` 並留下公開安全摘要，再提醒 leadi；Controller 不得越權持續重試。
28. 本次 MVP 只排除使用者偽造或手改 `agent-team-lifecycle:v1` 結構留言的對抗性邊界；不新增 bot 身分、簽章或額外授權系統。
29. 使用者正常操作 Linear 原生 workflow、Labels 與依賴關係仍是核心輸入，且可發生於任意時點；Controller 在每個 outbound mutation 決策點前都必須 provider read-back，途中觀察到取消／暫停／取代即中止原 intent 並走對應收斂路徑。
30. Managed branch 名稱必須是 project／issue key／Job ID 的 deterministic function；PR body 必須保存 `agent-team-pr:v1` closed back-pointer（project、issue、Job、branch identity），使 PR 可從 GitHub 反向發現而不依賴本機 binding。
31. cancel／resolve／reconcile／admission 在 Linear 找不到 `pr_bound` 時，仍必須以 deterministic head ref 向 GitHub 查詢 open PR；發現存在但未完成 public binding 的 PR 時發布 `authority_conflict` 並升級，禁止把「Linear 無 event」解讀成「GitHub 無 PR」。
32. Lifecycle closed set 增加 `job_completed` terminal event；`job_cancelled`、`job_superseded`、`job_completed` 都會終止該 Job 的 PR 操作權。正常完成在 `job_completed` 可 read-back 前不得只靠本機 terminal 狀態釋放對外 ownership。
33. 每個 PR control event 帶 monotonic `ownershipEpoch`：初次 `pr_bound=1`，`pr_handoff=current+1` 並引用 prior owner／epoch；current owner 是最高有效 epoch 指向、且尚未出現對應 terminal event 的 Job。相同 epoch 出現矛盾 owner 或無法形成唯一 owner時即 `authority_conflict`。
34. 每個 managed outbound mutation（含 git push、PR mutation／comment／status、Linear lifecycle mutation 與 merge）在 provider call 前必須通過同一 fencing check：CAS read-back lease epoch 仍屬目前 execution、Job 非終態、Linear 原生狀態仍允許、PR owner／ownership epoch 一致、相關 branch／Head identity 相符；任一不符即零 provider side effect。
35. 同一 `(job, mutation intent, identity digest)` 的 provider 呼叫上限為兩次（initial＋一次 retry）；每次送出前以 CAS `persist-before-send` 累加 durable attempt count，crash／sent-unknown 仍計入，跨 resume 不歸零。
36. Team Lead escalation 使用安全化 `escalation_requested` lifecycle event 傳遞 evidence packet；公開欄位僅允許 issue／Job／PR／Head identity、Linear／GitHub safe read-back projection、closed attempted-operation enum、durable attempt count 與 closed decision question，不含 raw output、secret、received value 或 private diagnostics。
37. LEA-136 的 escalation 終點是：Controller 發布 `escalation_requested`、投影既有 `已阻塞＋整合異常` 並停止；目前由對話中的 Team Lead 或後續輪巡接手裁決。本 Task 不新增不存在的自動 Team Lead model pipeline，也不得冒稱已自動喚起主管。

## 待釐清決策

- 無；目前 MVP 架構邊界已收斂。

## 被否決的替代方案

- 本機 Job progress 作主要權威、Linear 只給人看：否決；會產生雙重真實來源與不可見交接。
- 所有 heartbeat/CAS/process 細節都高頻寫 Linear：否決；這些是執行機制，會造成 API 噪音、延遲與不必要的 UI 汙染。
- 只相信 Linear、不向 GitHub read-back：否決；Linear 不能取代 PR/Head/checks/merge 的 provider truth。
- 一個 Job 永久獨占一個 PR，換 Job 就強制關閉並重開 PR：否決；這會切碎程式碼、CI 與 review 歷史，並把 Job 操作權終止錯當成 PR 實作放棄。
- 本次一併建立 lifecycle event 作者簽章／bot 專用身分／對抗使用者偽造：延後；目前沒有實際需求，會使 MVP 擴張成權限系統。
- 本次完成跨 Job 原子 PR handoff 或 admission 階段的無 Job 結構化 conflict publication：延後；兩者都需要獨立 identity／locking 規格，不能靠猜測補齊。

## 影響

- LEA-136 暫停原本「local-first binding」實作，待本 ADR 收斂後重寫為 Linear-first PR lifecycle MVP。
- 後續 Job admission、resume、resolve 與 reconcile 都必須把 Linear 工作狀態納入 authority read-back。
- 本機狀態欄位可暫時保留作 durable journal，但其對外重要內容必須有 Linear/GitHub 對應證據。

## MVP 邊界（L0–L3 收束）

- L0 原目標：取消／取代 Job 後，不再留下無人負責、仍可被自動操作的開啟 PR。
- L1 直接不變式：PR 綁定與 Job 控制權必須可由 Linear lifecycle history＋GitHub read-back 重建；同一 PR 同時最多一個 Job 擁有自動化操作權；Job terminal 前外部狀態必須收斂。
- L2 必要 recovery：provider 部分成功／sent-unknown 時做一次 read-back、最多一次安全重試，再升級 Team Lead；所有步驟冪等且 crash 後接續同一 Job。
- L3 延後：全歷史工單批次遷移、七類事件所有既有路徑一次改造、跨 Job 原子 PR handoff、admission 無 Job conflict publication、bot 身分／簽章、對抗性使用者競爭修改、跨 provider 通用交易框架，以及自動喚起／執行 Team Lead 模型的主管 pipeline。

## Lifecycle event identity（canonical serialization）

所有欄位先走既有 canonical serialization，再產生 digest；表內欄位是 event ID 的完整輸入集合，未列欄位不得影響 ID。

| Event kind | Event ID canonical fields | 語意 |
|---|---|---|
| `job_started` | issue ID、Job ID | 每個 Job 恰一次 |
| `pr_bound` | issue ID、Job ID、PR number、branch identity、initial Head、ownership epoch | 每次首次公開 binding 恰一次 |
| `job_cancelled` | issue ID、Job ID | 每個 Job 取消恰一次 |
| `job_superseded` | issue ID、old Job ID、new Job ID | 每次正式取代恰一次 |
| `pr_handoff` | issue ID、PR number、old／new Job ID、prior／new ownership epoch、handoff Head | 每次控制權交接恰一次 |
| `job_completed` | issue ID、Job ID | 每個 Job 正常完成恰一次；merge identity 留 payload 並向 GitHub read-back |
| `authority_conflict` | issue ID、Job ID、PR number（可無）、conflict class、conflict epoch、observed identity digest | 同一未解衝突去重；Team Lead 已收斂後再次發生才增加 conflict epoch |
| `escalation_requested` | issue ID、Job ID、mutation intent、identity digest、escalation epoch | 同一未解 escalation 去重；payload 可帶安全 attempt count |
| `external_merge_observed` | issue ID、PR number、merge commit SHA | 每個外部 merge 事實恰一次 |

`conflictEpoch`／`escalationEpoch` 在 per-issue Lease 下以 CAS persist-before-publish；sent-unknown 重播沿用原 epoch，不重新配置。正常 CI／review event 的完整推廣不屬 LEA-136，本表只封閉本 Task 實際使用的 kinds。

## LEA-136 最小實作範圍

1. 定義並持久化本 Task 所需的 `agent-team-lifecycle:v1` closed event：`job_started`、`pr_bound`、`job_cancelled`、`job_superseded`、`pr_handoff`、`job_completed`、`authority_conflict`、`escalation_requested`、`external_merge_observed`；每則含白話摘要、安全結構資料與穩定 event ID。
2. Job 建立／恢復前 read-back Linear lifecycle history 與 GitHub；同一非終態 Job 因 session／Agent 更換時恢復原 Job，不建立第二 Job。
3. PR 建立前使用 deterministic managed branch；PR body 寫入 closed back-pointer。PR 建立或首次發現後，先由 GitHub read-back 精確 PR／branch／Head，再發布 `pr_bound`；本機 binding 不得是唯一可見來源。Linear 無 binding 時仍須以 head ref 反向查 GitHub。
4. Linear 工單取消時，若綁定 PR identity 一致且仍 open／unmerged，關閉精確 PR；確認 GitHub 與 Linear 記錄收斂後，Job 才能 terminal 並釋放 Lease。
5. Job 正式被取代且仍有 open PR 時，本次不做不完整 handoff：PR 保持 open，零 handoff／terminal／claim release，公開 `authority_conflict` 並投影阻塞；跨 Job 接管留待具備雙 Lease與 successor checkpoint 後另行實作。
6. 以 ownership epoch＋terminal events 封閉推導 PR current owner；所有 managed outbound mutation 共用 pre-send fencing。identity 漂移、雙重 active ownership 或外部權威衝突時零危險 mutation，投影既有 `已阻塞＋整合異常`、發布安全摘要並升級 Team Lead。
7. 部分成功／sent-unknown 不自動反向補償；Controller 依 durable attempt counter 做一次 read-back、最多一次封閉條件下的冪等安全重試，再次 read-back 後仍未收斂即以 `escalation_requested` 發布 safe evidence packet。
8. 不批次重寫舊工單；既有 Job 只在 resolve／resume／reconcile 或新 Job admission 實際觸及時按需補齊。

## 驗收條件

1. 同一 Linear 工單已有非終態 Job 時，process crash、模型切換或 Agent 換手只產生新 execution／Lease，不建立第二 Job／branch／PR。
2. PR bind 成功後，Linear 可讀到 exact Job ID、PR number、branch、Head SHA、ownership epoch 與穩定 event ID；GitHub read-back 不符時不得發布成功 binding。PR body back-pointer 與 deterministic branch 可由 issue／Job 反向查回 exact open PR。
3. 取消工單且 exact PR open：即使 `pr_bound` 在 Linear 缺失，也必須先經 head-ref 反向查詢發現 PR；identity 完整一致時 PR 關閉恰一次、取消 event 恰一則、Job terminal、Lease／claim 釋放；存在但未完成 binding 時先 conflict／escalate，不得假定無 PR。
4. 取消工單但 PR 已 external merge：不得冒稱由取消流程授權或重新開啟；留下 external-merge provenance 並交既有完成／暫停政策收斂。
5. 正式 supersede 且原 PR 仍 open：PR 保持 open，零 handoff／terminal／claim release，恰一則去重的 `authority_conflict`，Linear 投影阻塞；不得讓 successor 或舊 session 繼續 mutation。
6. supersede 後舊 Job／舊 session 即使復活，其首次 outbound mutation 必須因 lease epoch／owner／Head fencing 不符而在 provider call 前被拒；push、改 PR、留言、設 review status、Linear lifecycle mutation或合併的 provider call count 均為零。
7. PR／branch／Head 任一 identity 漂移、同 PR 出現兩個 active Job 或 Linear／GitHub 權威矛盾：零危險 mutation，進 `已阻塞＋整合異常` 並產出 Team Lead 證據包。
8. GitHub mutation 成功但 Linear event sent-unknown：read-back 後只補 event，不反向撤銷 GitHub；同一 `(job, intent, identity)` 的 provider call 跨 crash 累計最多兩次，且每次 call 前已持久化 attempt count。
9. 安全重試後仍未收斂：Controller 發布 `escalation_requested`、投影既有 `已阻塞＋整合異常` 後停止，不進入無限 retry；對話中或輪巡的 Team Lead 可從 Linear 看見兩邊 read-back、attempt count 與待裁決事項。本 Task 不驗收自動啟動 Team Lead 模型。
10. Lifecycle event 不含 raw model output、secret、received value 或 private diagnostics；白話留言與非 closed-schema comment 不作 mutation 授權。
11. 新 Job admission 依最高 `ownershipEpoch` 與 terminal events 推導唯一 owner，並讀取 GitHub 現況；不會在已有 active owner／未收斂 PR 時建立重複 Job。正常完成後 `job_completed` 會解除 owner，使後續合法 Job 不被永久阻擋。
12. 既有 C035 取消後禁止合併、AutoMergeGate、CI／review／Head read-back 與 external merge provenance 負向測試保持綠燈。

## Glossary 草稿

| 術語 | 定義 | 所屬專案 | 首次確認日期 |
|---|---|---|---|
| Linear collaboration/control plane | Agent Team 中供人與 Agent 共讀、記錄工作生命週期、交接、阻塞、驗收與稽核歷史的 Linear 工單介面；所有外部可觀察的重要工作狀態必須在此可見且可機器讀取 | agent-team | 2026-08-26 |
| Local execution journal | 只保存 Lease、CAS、process/session、heartbeat、私密診斷、mutation intent 與 crash checkpoint 的本機可靠執行紀錄；不得獨占人或接手 Job 需要知道的工作狀態 | agent-team | 2026-08-26 |
| Job | 一張 Linear 工單中某一次工作的持久實例；由 Controller 建立並維護 Job ID、branch／PR 綁定與 lifecycle identity，再分派可替換的 Agent execution 執行 | agent-team | 2026-08-26 |
| Agent execution/session | Controller 為既有 Job 分派的單次執行程序或模型工作階段；可因 crash、額度或模型切換而替換，但不因此改變 Job identity | agent-team | 2026-08-26 |
| PR work line | 一張 Linear 工單在 GitHub 上持續累積程式碼、CI、review 與討論歷史的開發工作線；可經明確 handoff 由不同 Job 依序接管，但同時只能有一個 Job 擁有自動化操作權 | agent-team | 2026-08-26 |
| Controller | 依封閉規則建立／協調 Job、分派 Agent、持有 Lease 並執行可客觀驗證之 mutation 與 reconciliation 的執行控制器；遇到職責外判斷必須升級 Team Lead | agent-team | 2026-08-26 |
| Team Lead | 接收 Controller 權威證據包，處理跨系統矛盾、identity 漂移與需要理解脈絡之非機械性裁決的主管角色；仍不得繞過安全 gate 或憑猜測 mutation | agent-team | 2026-08-26 |
| Reconciliation | 重新 read-back Linear 與 GitHub 的權威現況，依封閉規則補齊部分成功或遺漏步驟，使外部狀態重新一致；不是反向撤銷已成功操作 | agent-team | 2026-08-26 |
| Sent-unknown | mutation 已送出但因 timeout／連線中斷而無法知道 provider 是否成功接收的狀態；必須 read-back，不得直接假定成功或失敗 | agent-team | 2026-08-26 |

## 澄清清單

- [x] 問題：Linear 的「所有狀態」是否指所有影響交接與人類判斷的狀態，而純內部執行細節仍留本機？
  回答：是。Linear 與 GitHub 都是權威來源，也供人與 Agent 閱讀並作為未來可複查的開發紀錄。
  影響前提：Identity 與動機被強化；local-first 原方案需重寫。
- [x] 問題：Linear 的目前狀態與完整歷史要用何種最小呈現方式？
  回答：原生 workflow／既有 Labels 顯示目前粗粒度狀態；append-only lifecycle event 留言保存七類重要轉換的歷史與詳細 identity。
  影響前提：不建立另一張可覆寫狀態卡，也不把高頻執行 log 寫入 Linear。
- [x] 問題：是否要為 Linear-first authority 再新增狀態 Labels？
  回答：不可直接新增；必須先盤點現有內容，避免 Label 持續膨脹。
  影響前提：新增 Label 不再是預設方案，需先完成 taxonomy 裁決。
- [x] 問題：是否採用「凍結現有 Label schema；只沿用現有粗粒度群組，新增細節一律進 lifecycle event 留言」？
  回答：若現有 Label 結構能滿足就同意；盤點確認現有結構已足夠，因此採用且本次零新增 Label。
  影響前提：縮小實作範圍，不改 provisioning／Label schema；Linear-first 方向不變。
- [x] 問題：哪些狀態轉換應成為公開開發紀錄？
  回答：採用七類有效狀態轉換；heartbeat、重複 poll 與內部 retry 等噪音不公開。
  影響前提：Linear 保存可複查的重要歷史，但不成為高頻執行 log sink。
- [x] 問題：Lifecycle event 是否採同一則留言內「白話摘要＋封閉結構資料」的雙層格式？
  回答：同意；白話供人閱讀，隱藏 closed-schema JSON 供 Agent 解析，append-only 且以穩定 event ID 去重。
  影響前提：Linear 同時滿足人機溝通與歷史稽核，不需另一張可覆寫狀態卡。
- [x] 問題：是否採「欄位分權」而非 Linear／GitHub 全域優先序？
  回答：同意；Linear 決定工作意圖，GitHub證明程式碼事實，本機不覆蓋外部權威；衝突時停止並 reconciliation。
  影響前提：Linear-first 不是 Linear 取代 GitHub，而是兩個外部權威依欄位分工。
- [x] 問題：同一工單因 process crash、額度或模型 session 更換而換 Agent 執行時，是否保持同一 Job identity？
  回答：是。Job 是工單一次工作的持久實例，Controller 根據 Job 分派 Agent；換 Agent／session 只更換執行者與 Lease，不建立新 Job。
  影響前提：日常 recovery 不再需要跨 Job 搬移業務狀態；新 Job 僅用於明確取消、重大需求變更或正式取代。
- [x] 問題：舊 Job 被新 Job 正式取代時，是否必須關閉舊 PR 並重開？
  回答：否。PR 表示工單目前的程式碼與審查歷史；預設由新 Job 經明確 handoff 接管原 PR，僅終止舊 Job 的操作權。取消、放棄、不相容或 identity 衝突時才關閉 PR。
  影響前提：PR ownership 改為工單工作線；Job 只持有排他的暫時自動化控制權，handoff 後所有 merge gates 必須重新驗證。
- [x] 問題：部分成功／sent-unknown 應由 Controller 自動處理，還是直接交 Team Lead？
  回答：分級處理。Controller 先做一次 read-back，僅在封閉條件成立時最多一次安全重試並再次 read-back；仍未收斂或超出職責範圍時，帶權威證據包升級 Team Lead，類似員工發現職責外異常交主管決斷。
  影響前提：兼顧無人值守與權責邊界，並以固定上限避免無限驗證／重試。
- [x] 問題：本次是否處理使用者偽造／競爭修改 lifecycle event 的可信作者邊界？
  回答：不處理偽造／手改結構 event，不建立 bot 身分或簽章系統；但使用者正常移動原生 workflow／Labels 可發生於任意時點，仍是既有核心流程並由每個 mutation 前 read-back／fencing 保護。
  影響前提：MVP 保留 closed schema 與 provider read-back，不擴張到對抗性權限設計，也不誤排除正常取消操作。
- [x] 問題：第一輪 Claude spec review 的七項 L0–L2 blockers 是否採納？
  回答：全部採納；補 PR 反向發現、terminal owner 推導、mutation fencing、durable retry budget、per-kind event ID、Linear escalation evidence packet，以及正常 workflow 任意時點介入規則。
  影響前提：不改變外部權威／Job／Agent 分層，只補足 crash 與 handoff 下可客觀驗收的必要不變式；第二輪只驗 blocker 關閉。
- [x] 問題：Controller 升級 Team Lead 是否包含本次建立自動主管模型 pipeline？
  回答：否。LEA-136 先做到安全發布證據包、投影阻塞狀態並停止；由目前對話 Team Lead 或後續輪巡接手。自動 Team Lead model pipeline 是獨立後續功能。
  影響前提：不以不存在的 production pipeline 作完成宣稱，也不讓相鄰主管自動化延誤孤兒 PR 修正。

## 現有 Label inventory（2026-08-26 read-back）

- Agent 角色：5（團隊管理者、開發工程師、代碼審查者、視覺審查者、整合工程師）。
- 審查需求：3（代碼審查、視覺審查、雙重審查）。
- Agent 狀態：5（排隊中、執行中、等待中、已暫停、已阻塞）。
- 阻塞原因：9（等待依賴、週額度不足、5 小時額度限制、額度資訊無法確認、等待危險操作核可、整合異常、合併衝突、變更請求已關閉、未知錯誤）。
- 人類驗收：2（需要、不需要）。
- 驗證強度：3（輕量、標準、嚴格）。
- 類型：3（Bug、Feature、Improvement）。

盤點結論：Job ID、branch、PR、Head、CI/review 細階段都不適合新增 Label；現有 Agent 狀態只表達粗粒度活動狀態，詳細原因與歷史應由結構化 lifecycle event 留言承載。「阻塞原因」未來也不得因新增 error code 自動長 Label。
