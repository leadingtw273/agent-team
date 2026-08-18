# Agent Team Linear 工作狀態生命週期規格

狀態：已採用  
日期：2026-08-18  
決策者：leadi  
適用專案：Agent Team

## 1. 背景與目標

目前 production dispatch 只把 Linear「待執行」當作新 Job admission 訊號。Job 被接走後，Linear
仍停在「待執行」，直到 GitHub merge 後才直接進「已完成」。`進行中`、`審查中` 與 Agent 狀態雖
已存在於 domain、Linear catalog 與 adapter，卻沒有完整接入 dispatch／review／reconcile 主流程。

結果是 Linear 無法誠實呈現 Agent Team 是否已接單，使用者必須查本機 Job 或 GitHub PR。本功能
讓 Linear 成為可讀控制面板，同時維持 durable Job、claim、lease 與 GitHub merge evidence 的既有
權威邊界。

目標：

1. Job 與 claim 成功持久化後，先確認 Linear 已進入「進行中」，才允許建立 worktree 或啟動模型。
2. CI 綠且 review intent 已持久化後，先確認 Linear 已進入「審查中」，才允許啟動 Reviewer。
3. Linear 主要狀態與 Agent 狀態可由 durable Job stage 確定性重建。
4. 暫時性外部失敗有界等待；確定性安全失敗立即 Block。
5. 任一 crash、重試或並行 cycle 不得重複 Job、模型、留言、PR 或 merge。

## 2. ADR：Linear 工作狀態由 durable Job lifecycle 驅動

### 狀態

已採用。

### 背景

涉及四個相互依賴的子系統：Linear workflow／labels、dispatch admission／claim、durable Job／reconcile，
以及 CI／Reviewer／merge lifecycle。只在 implementer handler 補一個 `setWorkStatus` 會留下 crash
窗口、人工狀態漂移與 resume 不一致，因此狀態 mutation 必須納入持久化協調流程。

### 決策

1. Durable Job progress 是執行階段權威；Linear 主要狀態是對人可讀的 workflow mirror。
2. `Job + admission claim` 持久化完成後，Controller 寫入 work-start intent，將 Linear 從「待執行」
   切成「進行中」，並做權威 read-back。確認成功前禁止 worktree、模型與 PR 副作用。
3. CI 綠且 review intent 持久化後，將 Linear 切成「審查中」並 read-back；成功前禁止 Reviewer。
4. Reviewer 要求修改時，先切回「進行中」並 read-back，才允許 fix round。
5. GitHub exact-Head merge 證據成立後，沿用既有 lifecycle 將 Linear 切成「已完成」。
6. 狀態 mutation 使用durable intent／receipt、CAS與穩定本機dedupe key；Linear沒有外部CAS／idempotency，
   Webhook只作wakeup hint。
7. Project-level rollout 採 `off | observe | enforce`，預設 `off`。

### 被否決的替代方案

- 建立 PR 後才切「進行中」：接單到 PR 之間仍不可見，provider 長任務與前置等待會被誤認為未接單。
- 第一個檔案變更後才切「進行中」：無法為 crash-safe checkpoint 提供明確邊界，且把 UI 狀態綁到
  非權威 working tree diff。
- Job 建立後非同步 best-effort 更新 Linear並繼續模型：Linear 寫入失敗時會產生「仍待執行但已在
  開發」的假狀態，可能誤導人類重派。
- 手動 `進行中` 沒有 Job 時直接退回待辦：可能覆蓋真人正在執行的工作。
- 所有專案立即啟用：外部 workflow mutation 缺少可回滾的 live rollout 邊界。

### 影響

- Dispatch 需新增 work-start checkpoint 與 Linear mutation/read-back gate。
- Resume／reconcile 需能從 intent／receipt 重建狀態，不重跑 provider。
- Reviewer／fix round需增加 in-review／in-progress gate。
- Project config、health／project projection與測試需支援 rollout mode。
- Ready Gate 自動回退規格保持獨立；兩者共用 mutation receipt／transition evidence語意，不互相覆蓋。

## 3. 名詞與權威

- **Work-start checkpoint**：Job 與 claim 已持久化，但 worktree／模型尚未啟動；包含預期 Linear
  `進行中` mutation intent與 receipt。
- **Work-status reconciliation**：依 durable Job stage、Linear read-back與 Controller receipt，確定性
  修復或阻擋主要狀態／Agent標籤漂移的流程。
- **Orphan in-progress**：Linear 顯示「進行中」，但沒有可唯一對應的 active Job與 claim。
- **Confirmed Provider產出**：具Controller confirmed receipt且綁定Job／epoch／identity的外部收斂點，
  包含可稽核commit、PR或review result；process啟動次數不是此定義。
- **Controlled work-status recovery**：只由operator顯式CLI觸發、將authority ambiguity安全收斂的流程；
  timer／Webhook不得自動觸發，也不得把`sent_unknown`偽裝成Controller mutation成功。
- **C035**：既有`cancellation_after_merge` provenance；取消落在merge競態窗時不標Done、不自動revert，
  暫停auto-merge並交人工。基準測試位於`tests/unit/dispatch-status-merge-composition.test.ts`、
  `tests/unit/dispatch-resume-composition.test.ts`與`tests/unit/lifecycle-pipeline.test.ts`。
- **主要狀態**：Linear原生 workflow state；向人呈現工單生命週期。
- **Agent狀態**：Linear單選 Label Group；呈現自動化目前正在執行、等待、暫停或阻塞。
- **執行權威**：durable Job progress、admission claim與lease；Linear狀態不能憑自身創造 Job。
- **合併權威**：GitHub exact-Head merge evidence與既有 AutoMergeGate。

## 4. 範圍

### 4.1 範圍內

- Dispatch work-start intent／receipt與 `進行中` gate。
- CI waiting、Reviewer、fix round、requires-manual、completed／canceled的狀態與Agent標籤投影。
- 暫時性失敗的durable有界等待。
- `work_start_pending`、`blocked_pending_mutation`與 orphan／drift reconciliation。
- 獨立的project-level `workStatusLifecycleMode: off | observe | enforce` rollout。
- Enforce前的Linear workflow／label capability pre-flight。
- CLI/project/UI的安全化read-back、冪等留言與測試。
- Sandbox live canary及Tank Skirmish啟用read-back。

### 4.2 範圍外

- 改變Ready Gate內容完整性或native dependency政策。
- 改變Provider quota政策或Reviewer report contract。
- 新增merge入口、人工merge approval或force／bypass merge能力；本功能只為既有
  `AutoMergeGate.enable` 增加取消／work-status fail-closed輸入。
- 讓Linear狀態取代Job／claim／lease。
- 自動判斷沒有Job的手動「進行中」究竟由哪位真人負責。

## 5. 狀態投影矩陣

| Durable情境 | Linear主要狀態 | Agent狀態 | 模型／mutation權限 |
|---|---|---|---|
| Ready且尚未claim | 待執行 | 排隊中 | 可進admission，尚不可啟動模型 |
| Job＋claim已落盤，work-start mutation待確認 | 待執行 | 等待中 | 主要狀態未confirmed前禁止worktree／模型；label失敗本身不gate |
| Implementer／CI recovery／fix round執行 | 進行中 | 執行中 | 依既有policy允許 |
| 等CI、GitHub恢復或retry window | 進行中 | 等待中 | 只允許確定性read／retry |
| CI綠，review intent待確認 | 進行中 | 等待中 | 禁止Reviewer |
| Reviewer執行 | 審查中 | 執行中 | 允許Reviewer，禁止merge直到既有gate成功 |
| Reviewer限流／transport retry | 審查中 | 等待中 | 依既有／本規格有界retry |
| Reviewer要求修改 | 先確認回進行中 | 執行中 | 確認後才允許fix round |
| Safety checkpoint／等待核可 | 保持當前非終態 | 已暫停 | 禁止後續副作用 |
| Controller-owned狀態上的確定性失敗或retry耗盡 | 需人工 | 已阻塞 | 禁止模型與merge |
| Active Job遭人工主要狀態drift | 保持人工選擇 | 已阻塞 | 禁止模型與merge；零主要狀態覆寫 |
| Agent Team-managed真orphan | 需人工 | 已阻塞 | 隔離自動化工單；一般真人工單不在掃描範圍 |
| GitHub exact-Head已merge | 已完成 | 清除 | 只允許冪等lifecycle收尾 |
| 使用者取消 | 已取消 | 清除 | 禁止模型與merge |

阻塞原因標籤只在存在阻塞時保留；完成、取消或成功復原後，清除Controller擁有的Agent狀態與
阻塞原因標籤，不得清除真人或其他整合擁有的label。「成功復原」是對應durable incident已有
confirmed收斂receipt，且Job已安全推進到後續stage或終態。

Project／CLI／UI的安全投影至少包含以下穩定欄位；不得投影raw adapter回應或provider內容：

- `workStatusLifecycleMode: off | observe | enforce`
- `workStatusPhase: idle | work_start_pending | working | review_start_pending | reviewing | fix_pending |
  blocked_pending_mutation | requires_manual | completed | canceled`
- `expectedLinearStateId`、`observedLinearStateId`、`transitionInstance`
- `pendingMutation: { jobId, step, transitionInstance, targetKind, targetId, consecutiveFailureCount,
  lastClosedReason, lastAttemptAt } | null`；只投影目前pending instance，完整ledger仍保存在private store。
- `authority: { jobId, claimId, leaseExpiresAt } | null`
- `incident: { kind, reasonCode, state, attemptCount } | null`
- `capability: { checkedAt, workflowStatesReady, agentLabelsReady, reasonCodesReady }`

## 6. Work-start protocol

1. 權威重讀候選、eligibility與project capability inventory。
2. 取得per-issue readiness／admission lock。
3. CAS建立Job、claim與lease；不得先改Linear為進行中。
4. 持久化 `work_start_pending` intent。至少綁定project、team、issue、Job、claim revision、transition
   instance／epoch、pre-state ID、observed `updatedAt`、current stateHistory span／cursor及target state ID；
   `updatedAt`只作重讀證據，不放入本機dedupe key。
5. `off`維持既有dispatch；`observe`只持久化預測decision／inventory，不做外部mutation、不冒稱已進行中，
   且不得作為Provider gate。相同fixture下，兩者的Provider啟動行為必須一致。
6. `enforce`在mutation送出前立即再次權威read：issue仍在原team／project、未archive／trash、目前仍為
   待執行，且Job、claim、lease、取消與identity皆一致。任何不符先重新分類，禁止送mutation。
7. 送出具穩定transition-instance本機dedupe key關聯的mutation，隨即權威read-back。只有「外部呼叫已確認
   成功＋read-back target state與transition evidence相符」可CAS寫confirmed receipt。若回應為
   `sent_unknown`，即使看到target state也只能記authority ambiguity；不得授權Provider，交受控recovery
   或需人工收斂。
8. Confirmed receipt後再重讀Job、claim、lease、取消／drift、team／project與Linear狀態；全部一致才
   冪等建立worktree並啟動Provider。

Enforce任一步失敗都不得啟動Provider。Crash後reconcile從intent／receipt接手，不建立第二個Job。
若Controller mutation在最後重讀競態中覆蓋了人工取消／需人工，只有完整history與confirmed receipt能唯一
證明「人工轉移先發生、Controller轉移後覆蓋」時，才可做受控補償：還原為該人工狀態並留一則冪等說明；
證據不唯一時維持fail-closed，不猜測、不自動還原。

## 7. Review-start與fix-round protocol

1. CI exact Head全綠後先持久化review intent。
2. 將Linear改為審查中並權威read-back。
3. 確認Job／Head／requirement／CI與receipt identity未漂移，才啟動Reviewer。
4. Claude限流或retryable transport failure保持審查中，Agent改等待中。
5. Reviewer要求修改時，先持久化帶fix round／epoch的fix intent並將Linear改回進行中；read-back成功後
   才執行fix round。每一輪是不同transition instance，同一輪重試仍使用同一key。
6. Review success不直接完成Linear；仍須既有AutoMergeGate與lifecycle。

### 7.1 Agent狀態label mutation協定

1. 主要狀態是Provider／Reviewer／merge的gate；Agent狀態與阻塞原因label是可視性投影，寫入失敗不得
   單獨阻擋已由主要狀態confirmed的下一步。
2. 每個label寫入／清除仍須durable intent與confirmed receipt；本機dedupe key為
   `work-status:<job>:<transition-instance>:label:<group-id>:<value-id-or-clear>:<step>`，並保存
   `owner=controller`。只有具此ownership receipt的label可由本功能清除。
3. Label失敗使用獨立計數key `(jobId, label-step, transitionInstance)`，不與主要狀態mutation共用budget。
   未耗盡時投影`work_status.label_projection_pending`；達fallback門檻後投影project visibility degraded並
   留待reconcile，不把已在安全主要狀態的Job改成requires-manual。
4. Label重試同樣先read目前label group；已達target且有confirmed receipt時只補收斂，不重送。若來源
   無法歸因，只保留incident，不刪除或覆寫可能由真人／其他整合設定的label。

## 8. 暫時性與確定性失敗

### 8.1 暫時性

GitHub 5xx、provider retryable transport、Linear mutation/read-back暫時失敗等可恢復情境：

- GitHub、Implementer transport、Reviewer transport／rate-limit沿用各自既有stage-specific budget；本規格
  不覆寫其計數與退避。
- Work-start、review-start、fix-round及merge-preflight的Linear mutation／read-back若沒有既有budget，
  使用fallback：連續失敗計數 `>= 6` 即耗盡；每個canonical五分鐘cycle最多加一。
- 主要狀態計數key為`(jobId, step, transitionInstance)`；label使用§7.1獨立key。新instance從零開始，
  同一instance的完整權威成功只歸零自己的計數。
- 計數durable；重複webhook／同cycle重跑不加計，Controller停機期間不以wall clock補計。因此正常
  輪巡下約30分鐘只是營運描述，不是第二個判定標準。
- Linear provider-wide 429／全域backoff／已知全站事故屬project health事件，不增加任何issue的
  consecutive failure，也不嘗試Block mutation；恢復前只投影degraded與等待。
- 等待期間保持當前主要狀態，Agent為等待中，保存closed reason與attempt evidence。
- 不因等待而重做已有confirmed receipt的Provider產出、Reviewer結果、commit、PR或merge mutation。
- 耗盡後轉自動化Block。

### 8.2 確定性

Identity漂移、policy／protected region、invalid transition、exact-Head不符及capability drift等內部確定性
失敗立即fail closed、不消耗暫時性budget；目前主要狀態可由Controller receipt歸因時才寫需人工＋已阻塞。
取消／人工work-status drift保持人工主要狀態，只讓Job進requires-manual並依ownership receipt投影label／留言。
Orphan依§9.1隔離；issue跨team／project、archive／trash／delete時停止所有舊team mutation並保留本機
requires-manual evidence。若issue已是target state但無法正向歸因於本intent，分類authority ambiguity，零
Provider且不消耗暫時性budget，交§8.4 controlled recovery／需人工。

### 8.3 Linear不可用

Job＋claim已存在但Linear無法確認進行中時：

- 保留Job與claim防重，寫 `work_start_pending`，不建立worktree／不啟動模型。
- 每個canonical cycle先權威read；若target已達且可由confirmed response／receipt歸因，只補receipt，不再
  mutate；否則重新驗證pre-condition後才mutation，再立即read-back。
- Pending期間持續heartbeat既有per-job／per-issue lease。Lease逾期後的接手者必須接續同一Job與intent，
  禁止新建Job。
- 連續失敗計數達六後，本機進namespaced `work_status.blocked_pending_mutation`；Linear恢復後補寫需人工、
  已阻塞與原因留言。
- 未確認外部mutation前不得宣稱已Block或已進行中。

### 8.4 Controlled work-status recovery

1. 唯一入口為operator顯式執行
   `agent-team dispatch work-status-recover --job <jobId> --transition <transitionInstance>`；timer、Webhook與
   generic dispatch不得自動執行。`--dry-run`只做admission／identity／預計mutation檢查，零provider、零mutation；
   合法exit 0、阻擋exit 3。
2. 只接受exact Job、active claim、authority ambiguity／work-status drift cause、未漂移team／project／
   requirement／revision與完整分頁history。任一identity不符維持requires-manual，零mutation。
3. 舊`sent_unknown`只能寫「結果收斂用receipt」，永遠不能升級為Controller confirmed authorization。
   若目前已是target state，operator執行命令本身可建立獨立
   `operator_authorized_continuation` receipt，明示是人工授權續作而非冒稱Controller mutation成功。
4. 若operator已把issue還原到原pre-state，可由同一命令建立新的bounded transition instance並依§6重新
   mutation／read-back；舊intent與attempt audit永久保留，不重設或覆寫。
5. Evidence不唯一、目標／pre-state皆不符或CAS失敗時，維持requires-manual，零新mutation／Provider。
   所有step使用`work-status-recover:<job>:<old-transition>:<recovery-epoch>:<step>`本機dedupe key。

## 9. 人工狀態與漂移

### 9.1 Orphan in-progress

Orphan掃描只涵蓋明確由Agent Team管理的issue：仍有Agent角色，且有approved snapshot／Controller lineage
或其他automation ownership evidence；沒有Agent角色的一般真人工單一律不讀寫。受管issue為進行中但找
不到唯一active Job＋claim時，先查Controller receipt與終態Job。若存在可歸因的confirmed進行中receipt且
Job已終止，這是「收尾未完成」，只冪等補終態投影；Job／receipt保留期必須長於orphan掃描窗。

排除收尾未完成後才分類真orphan：依leadi已裁決的隔離政策，恰一次轉需人工＋已阻塞並留言
`orphan_in_progress`，不自動接單、不退回待辦。這是只針對Agent Team受管工單的明示quarantine例外，
不是對一般「進行中」工單判斷真人歸屬。

### 9.2 Active Job期間的人工變更

- 已取消：保持人工主要狀態，立即走既有取消流程，禁止merge。
- 待辦／待執行／需人工：保持人工主要狀態，Job進 `requires_manual(work_status_drift)`，停止模型與merge，
  保留claim；只在Controller ownership receipt允許時投影Agent已阻塞／原因並留言。
- 已完成但GitHub未合併：保持主要狀態，同樣視為drift，禁止冒稱GitHub已merge。
- 人工drift一律零主要狀態覆寫。只有內部確定性失敗且目前主要狀態可由Controller confirmed receipt歸因
  時，才依§5寫需人工；重新對齊只能走§8.4 controlled recovery。

每個Provider啟動前、Reviewer啟動前、merge前及direct-squash前都必須重讀取消與work-status drift。
僅`workStatusLifecycleMode=enforce`新增work-status merge preflight；off／observe的既有取消read-back仍
維持現況，不增加work-status輸入。Enforce的merge前Linear讀取失敗屬暫時性，走既有stage budget或本規格
fallback，未確認前fail closed。一旦GitHub
exact-Head merge evidence已成立，事實上已無merge可阻止：若最後授權read-back未顯示取消／漂移，後續
Job completion、claim／lease release與lifecycle收尾必須冪等進行，不得因事後一般Linear drift重送merge
或抹消merge事實；Linear仍不可用時另留pending projection incident，恢復後補Done／稽核留言。若merge
競態窗內／merge後出現非取消人工drift（待辦／需人工），不覆寫主要狀態；Job／claim／lease仍恰一次收尾，
留一則「merge已發生」冪等留言與projection incident，零revert、零重送merge。若完整history證明取消落在
merge競態窗，仍沿用C035 `cancellation_after_merge` provenance：不標Done、不自動revert、暫停auto-merge
並交人工，不能被本功能改寫成正常completion。

## 10. 冪等、競態與安全

1. 本機dedupe／receipt關聯key至少包含`work-status:<job>:<transition-instance>:<target>:<step>`；transition
   instance綁定stage與round／epoch，同一次轉移重試不得換key，不同fix round不得共用key。Pre-revision
   只存intent。Linear不提供外部idempotency或CAS；防止重複外部mutation的手段只有durable ledger、§8.3
   先read後mutate與每次重驗pre-condition，不能因key相同就直接重送。
2. Intent／receipt以CAS保存；sent-unknown不得當confirmed，也不得授權Provider／Reviewer／merge。
3. Linear current state、完整分頁history／stateHistory與Controller receipt共同構成transition evidence；
   composite evidence最多支撐結果收斂用receipt。Mutation回應為sent-unknown時，任何history組合都不得升級
   為confirmed授權receipt。
4. Timer、Webhook、手動reconcile並行時，per-issue lock與claim保證最多一個owner。這把lock是與
   `readinessRolloutMode`無關的本機基礎設施，所有mode都使用相同issue key與生命週期；Ready Gate off
   也不得繞過。
5. Active claim或未收斂work-status intent存在時，Ready Gate不得對同一issue做Backlog／Block mutation，
   只記inventory。Claim前由Ready Gate擁有Agent／阻塞標籤；claim後交work-status coordinator；真orphan
   雖無claim，但因automation ownership evidence成立，同樣由work-status coordinator隔離，Ready Gate只記
   inventory。Reason code使用`readiness.*`／`work_status.*`namespace。
6. Requires-manual期間依leadi裁決保留claim，因此不回交Ready Gate。只有terminal completion／cancellation，
   或§8.4受控recovery明確取消並釋放claim、收斂所有intent後，才清除有Controller receipt的`work_status.*`
   label並把擁有權回交Ready Gate；不得以人為移動主要狀態默默釋放claim。
7. Crash後不得重做已有confirmed receipt的外部副作用。Provider／Reviewer process若在尚無confirmed產出
   時死亡，可依既有bounded stage／epoch policy重新叫起；commit、PR、留言、review success與merge仍須
   以receipt／identity保證confirmed結果恰一次收斂；process啟動次數不作exactly-once承諾。
8. 任一external identity、team／project或revision不符即停止，不重新綁定。
9. Public留言白名單為operation、job ID、transition／receipt digest、merge provenance、outcome、closed
   reason、attempt count與安全化操作結果；不含raw provider output、secret、未知值或adapter payload。
10. 唯一merge入口仍是既有AutoMergeGate；work-status preflight是其新增fail-closed輸入，不得另建
   force／skip／bypass路徑。

## 11. Rollout

本功能使用獨立config key `workStatusLifecycleMode`，不得重用Ready Gate的`readinessRolloutMode`：

- `off`：不新增狀態mutation或projection gate，維持現況。
- `observe`：持久化預測decision／inventory，不修改Linear、不gate Provider；相同fixture的dispatch副作用
  必須與off一致。
- `enforce`：啟用完整mutation／read-back／reconcile，confirmed receipt才可放行下一副作用。

兩個mode可獨立組合。Ready Gate在claim前判定admission；active claim或work-status intent成立後，Ready
Gate只能observe該issue，work-status coordinator成為Controller label／status唯一寫入者。即使Ready Gate為
`mutate`且本功能為`enforce`，也不得交錯寫同一issue。

Project進入enforce前必須完成真實capability pre-flight並固定team-scoped ID：待執行、進行中、審查中、
需人工、已完成、已取消workflow state，以及Agent狀態／阻塞原因label group與必要labels。缺少、重名、
無權限或team mapping不唯一時拒絕enable enforce，project health顯示closed reason；不得等建立Job後才讓全
project卡住。Runtime發現已固定能力漂移時視為確定性失敗。

Mode轉換與回滾：

1. 正向發布必須`off → observe → enforce`；不得跳過Sandbox observe／capability evidence直接live enforce。
2. Job admission時持久化`admissionWorkStatusMode`。Project降級只影響新admission；既有enforce Job與未收斂
   intent仍按其snapshot繼續gate／reconcile直到terminal或requires-manual，避免永久卡住或突然放行。
3. 降級不刪intent／receipt、不回捲既有Linear狀態、不做補償性mutation。Project health必須顯示各mode
   in-flight Job與pending intent數；緊急停用外部mutation需另走既有project pause／halt安全機制。
4. 新Job在off／observe下維持現況；off／observe的AutoMergeGate輸入與行為也維持現況，既有C035取消
   read-back不受本功能mode影響。

發布順序：

1. 預設off並完成單元、contract、integration與獨立驗收。
2. Agent Team Sandbox observe，確認預測與durable Job一致。
3. Sandbox enforce live canary：Ready→In Progress→In Review→Done。
4. 負向canary：Linear mutation failure、orphan、manual drift與transient retry。
5. Tank Skirmish enforce並以一張新工單驗證。
6. 其他專案維持off，需顯式啟用。

## 12. 驗收條件

1. Job＋claim未同時durable時零Linear進行中mutation。
2. Capability pre-flight缺任一必要state／label、mapping不唯一或無權限時，拒絕enable enforce，零Job／claim／
   Linear mutation／Provider。
3. 相同fixture下off與observe的Provider／worktree／PR副作用完全一致；observe額外只有安全inventory，零
   Linear mutation。
4. Enforce的work-start intent已寫但Linear mutation／read-back未confirmed時，零worktree、零Provider、零PR。
5. Mutation送出前同窗取消／需人工時零Provider；若Controller已覆蓋，證據唯一才補償回人工狀態且留言
   恰一次，證據不唯一則fail closed。
6. `sent_unknown`後read-back看到進行中仍為authority ambiguity，零Provider、零confirmed receipt。
7. Linear進行中confirmed後，正常路徑的Confirmed Provider產出恰一次；process啟動次數不是斷言點。
8. Provider process在尚無confirmed產出時crash可在同一bounded epoch續作；不得建立第二個Job，且commit／
   PR等confirmed副作用各恰一次。
9. `work_start_pending`期間強制lease逾期再reconcile，仍只接續同一Job／intent，零第二個claim／Job。
10. Mutation實際成功但回應遺失時，下一cycle先read；不得再次送mutation，也不得把sent-unknown提升為
    Provider授權。
11. CI等待時主要狀態為進行中、Agent為等待中。
12. CI綠但審查中read-back未confirmed時，Claude恰為零次。
13. 審查中confirmed後，該review epoch的confirmed review result與公開review留言各恰一次；限流／crash
    可依既有budget重新啟動process，但不得產生第二份confirmed結果或留言。
14. 連續兩輪changes requested各產生不同transition instance、各恰一次confirmed回進行中；每輪都在
    read-back後才啟動fix round。
15. 無既有budget的單一`(jobId, step, transitionInstance)` Linear失敗在第1至5個canonical cycle不Block；
    第6次durable consecutive failure (`count >= 6`)後進自動化Block。重複webhook不加計、該instance成功
    歸零、停機不補計；provider-wide rate limit／全站事故不增加任何issue計數、零Block mutation。
16. Identity／policy、team／project移動、archive／trash及capability drift在Controller-owned主要狀態上立即
    需人工且不消耗暫時性budget；人工取消／work-status drift保持人工主要狀態，零主要狀態mutation。
17. 只對有Agent角色＋automation ownership evidence的真orphan in-progress轉需人工＋已阻塞＋恰一則留言，
    零新Job／模型；一般真人工單零讀寫；可歸因的終態收尾殘留不得誤判
    orphan，只補既有終態投影。
18. Active Job被人工改待辦／待執行／需人工／未合併卻假完成時停止且禁止merge，保持人工主要狀態，
    只對有ownership receipt的Agent／阻塞label寫入且留言恰一次。
19. 僅enforce Job新增的merge前與direct-squash前取消／status drift／Linear讀取失敗逐案阻止merge；不得
    只斷言「有呼叫gate」。Off／observe與現況的merge輸入完全一致，既有C035檢查仍存在。
20. Merge API成功後crash，若無drift則reconcile不重送merge、恰一次收尾；非取消人工drift則零主要狀態
    覆寫、Job／claim／lease恰一次收尾、留言恰一次、零revert；取消落在競態窗則保留既有
    `cancellation_after_merge` blocked provenance，不標Done、不自動revert。
21. Ready Gate reconcile與work-start同窗時，active claim／intent使Ready Gate零Backlog／Block mutation，
    最終Linear state唯一且Agent／阻塞label不交錯；即使readiness rollout為off，同一per-issue lock仍保證
    reconcile／dispatch／Webhook併發零重複Job／claim／mutation。
22. Agent label mutation失敗不改變已confirmed主要狀態的Provider／Reviewer副作用次數，使用獨立incident
    與budget；完成／取消只清除具Controller ownership receipt的Agent／阻塞label，不得刪真人或其他整合label。
23. 同命令重跑、timer／Webhook／reconcile併發不重複mutation、留言、confirmed Provider副作用、merge或
    completion；不同fix round不得被錯誤dedupe。
24. `workStatusLifecycleMode`與`readinessRolloutMode`所有支援組合使用不同config key；新admission在work-
    status off／observe零Linear mutation，enforce只有confirmed receipt才放行下一副作用。存在enforce
    `work_start_pending`時project降級off，該Job仍按admission snapshot安全收斂，零新Job、證據不刪除、
    Linear不回捲；新Job使用off語意。
25. Project／CLI／UI逐欄投影§5列出的mode、phase（含`blocked_pending_mutation`）、observed／expected state、
    transition、pending mutation、authority、incident與capability，且不含raw adapter／provider資料。
26. Sandbox live happy path五項一致：review success、GitHub merged、Linear Done＋稽核留言、Job completed、
    claim／lease released。既有lifecycle留言另含operation、job ID、work／review transition receipt digest、
    merge provenance與outcome；不得另發重複成功留言。
27. Tank Skirmish enable後live ticket完整經過進行中與審查中，不再Ready直跳Done。
28. 全測、typecheck、lint通過，且至少逐條重跑
    `tests/unit/dispatch-status-merge-composition.test.ts`的C035 direct-squash案例、
    `tests/unit/dispatch-resume-composition.test.ts`的取消／merge receipt案例及
    `tests/unit/lifecycle-pipeline.test.ts`的`cancellation_after_merge`案例。
29. `work-status-recover --dry-run`合法exit 0／阻擋exit 3且零mutation／Provider；執行模式只有exact identity
    可建立operator-authorized receipt或新bounded instance。Sent-unknown舊receipt永不升級；證據不唯一時
    維持requires-manual、零mutation、零第二個Job。
30. 相同本機dedupe key重試時，若read-back已達target則adapter mutation呼叫次數仍恰一次；測試不得只
    斷言key字串相同。

## 13. 澄清清單

- [x] 問題：何時切進行中？  
  回答：Job＋claim durable後、worktree／模型前，且Linear read-back成功才可繼續。  
  影響前提：Linear成為誠實控制面板；durable Job仍是執行權威。
- [x] 問題：何時切審查中？  
  回答：CI綠且review intent durable後、Claude前；限流保持審查中，changes requested回進行中。  
  影響前提：審查狀態與Provider啟動有crash-safe邊界。
- [x] 問題：暫時性失敗等待多久？  
  回答：沿用既有budget；無既有budget時六個五分鐘cycle／約30分鐘。  
  影響前提：外部事故不立即Block，也不無限等待。
- [x] 問題：Linear無法切進行中怎麼辦？  
  回答：保留Job＋claim、寫pending checkpoint、零模型；超時進blocked-pending-mutation。  
  影響前提：Linear狀態確認是模型副作用前置。
- [x] 問題：手動進行中但無Job？  
  回答：orphan in-progress立即需人工＋已阻塞，不猜測、不退回待辦。  
  影響前提：不覆蓋真人工作。
- [x] 問題：active Job期間人工改狀態？  
  回答：取消走取消流程；其他漂移requires-manual、保留claim、禁止merge。  
  影響前提：人的外部mutation優先觸發fail-closed。
- [x] 問題：Agent狀態如何映射？  
  回答：排隊／執行／等待／暫停／阻塞依矩陣投影；終態清除。  
  影響前提：主要狀態與自動化處境分層呈現。
- [x] 問題：如何發布？  
  回答：project-level off／observe／enforce，Sandbox先行，Tank次之。  
  影響前提：外部mutation具可回滾rollout邊界。

## 14. 元前提覆核

- 目標使用者：leadi、Agent Team Lead、未來維運與稽核者；維持不變。
- 類似系統：Linear作為自動開發workflow控制面板；維持不變。
- Identity：長期內部自動化基礎設施，不是一次性測試腳本；維持不變。
- 動機：不查本機Job也能從Linear誠實判斷接單、執行、審查、等待與阻塞；維持不變。

本輪澄清未揭露會推翻原方向的新使用者或動機。

## 15. 第二模型復審處置

- Reviewer：Claude Opus；原始結果：`changes_required`。
- 採用：獨立rollout key、observe不gate Provider、mutation前最後重讀、transition-instance key、
  sent-unknown不授權、capability pre-flight、durable retry計數、pending lease、Ready Gate互斥、receipt-aware
  orphan、team／archive邊界、read-before-retry與明確projection／AC。
- 部分採用：GitHub merge evidence成立後，一般crash／Linear不可用不得重送merge或把既成merge當未發生；
  但保留既有C035 `cancellation_after_merge`例外，不接受「任何Linear drift都不得阻擋正常completion」。
- 待實作實證：既有各stage budget、Linear capability adapter與job-progress schema的實際接點；這些屬plan
  discovery，不改變本規格語意。
- 需使用者新裁決：無。所有產品語意沿用第13節已核可答案。
- 第二輪Reviewer：Claude Opus；原始結果仍為`changes_required`。
- 第二輪採用：label mutation receipt但不作模型gate、人工drift零主要狀態覆寫、顯式controlled recovery、
  本機dedupe key權威邊界、provider-wide事故不按issue計次、lock與mode解耦、ownership回交、mode snapshot
  回滾、phase／AC對齊、confirmed result exactly-once、非取消merge後drift與public留言白名單。
- 第二輪保留leadi原裁決：真orphan仍轉需人工隔離；透過「Agent角色＋automation ownership evidence」
  限縮掃描範圍，避免影響一般真人工單，不採Reviewer建議的「所有orphan均保持進行中」。
- 第三輪Reviewer：Claude Opus blocker-only；有效result為`pass`、`findings: []`，規格可進plan discovery。
