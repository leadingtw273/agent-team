# Agent Team Core：人類主導交付工作流實作計畫

狀態：已核可；Claude Opus 初審 5 個 blocker 已修正，定向複驗 PASS  
日期：2026-08-21  
規格：`docs/spec-human-directed-workflow.md`  
決策者：leadi

## 1. 交付目標

在所有 Agent Team 專案預設提供：

- 白話工單標題與三句人類摘要。
- `人類驗收: 需要|不需要` 與 `驗證強度: 輕量|標準|嚴格`。
- 工程完成後仍可等待產品負責人驗收，不占用 Job、Lease 或下游工程依賴。
- 可冪等接受或要求多輪 adjustment，不 reopen 原工程 Job。
- UI／Team Lead 可列出待人類驗收項目。
- 新單立即生效、舊單按需遷移、歷史零批次重寫。

本計畫不修改 Tank Skirmish 程式碼。最後 rollout 只處理 Linear 工單 metadata／狀態；遊戲功能另成下一批工單。

## 2. 實作基線與隔離

### 2.1 現況

- 規格 branch：`core/human-directed-workflow`，隔離 worktree `/tmp/agent-team-human-directed-workflow`。
- 規格起點：`a3c7257`。
- 最新權威主線 read-back：`origin/main=f21e4cc`。
- Linear Work Status Lifecycle（LWS）候選基線：`agent-team/linear-work-status-lifecycle=a406898`，其中功能 commit `83df064`、qualification evidence commit `a406898`。
- LWS PR #170 已於 `2026-08-18T05:54:40Z` squash merge 為 `3a4996813ca6f21c9f59e33dfda8eefb684d91a6`；該 merge commit 是目前 `origin/main=f21e4cc` 的祖先。原 branch commits `83df064`／`a406898` 因 squash merge 不是 main 祖先，權威整合 identity 改採 GitHub merge receipt＋`3a499681` ancestry。
- LWS qualification 文件記載 local release gates、fresh validation 與 Claude review 均 PASS；截至 HDW00 read-back，公開 PR／repo 證據仍沒有獨立標記 LWS live canary 已收斂，因此它保留為 Core 最終合併前置，不冒稱完成。
- 共享 `/home/markchou/project/agent-team` 仍有另一 session 的 dirty worktree，不得 stash、reset、commit、覆蓋或作本功能基底。

### 2.2 接合策略

1. 先提交本 branch 的 spec／plan，不碰 dirty main。
2. Core code branch 必須同時包含最新 `origin/main` 與 exact LWS 功能基線，因本功能直接依賴 LWS 的 work-status coordinator、durable ledger 與 UI projection。
3. 只在本隔離 worktree 建立 stacked integration；不得修改或 force push LWS branch。
4. 若 LWS PR 在 Core 開碼前已合併，直接 rebase Core 到新 `origin/main`。
5. 若尚未合併，從 `origin/main` 建立新的 integration commit，把 LWS commits 合入本 branch並保存 provenance；Core PR 標明依賴 LWS PR，不先合併。
6. 若合入時出現語意衝突，不以「選 ours/theirs」機械解決；先比對 LWS spec、Core spec 與最新修復 commit，只有可客觀保留兩邊不變式才繼續。
7. 若 LWS 在 HDW01～06 期間才合併：暫停 Core code，read-back 新 `origin/main`；建立 safety branch保存目前 Core commits；以 rebase `--onto`／等價非破壞流程移除本 branch 攜帶的 LWS commits；用 patch-id、LWS focused suite與behavior probes證明 main 已包含LWS；重跑HDW00後才續作。不得在共享LWS branch改歷史。
8. Core PR 可合併的硬前置：權威 `origin/main` 已包含合格LWS功能、LWS live canary已依其規格收斂、本Core branch已重基且不再攜帶重複LWS commits。Core PR不得成為把未完成LWS帶進main的載具。

停止條件適用HDW00～07全程：LWS exact head改變、qualification／canary失效、或latest main改變work-status／merge authority時，立即停在當前安全commit，重新執行§2.2.7與HDW00，不默默沿用舊前提。

## 3. 目標架構

### 3.1 不新增第三套工作狀態

- Linear 仍只有既有主要狀態。
- LWS durable Job lifecycle 仍是工程階段權威。
- 新增 `HumanAcceptanceRecord` 作產品接受權威；Linear `審查中` 只是其 `pending／adjustment_pending` 的可讀投影。
- `需人工` 維持故障／安全介入語意。

### 3.2 新增的 domain 值

```text
HumanAcceptanceRequirement = required | not_required
VerificationLevel = light | standard | strict
HumanAcceptanceState = pending | adjustment_pending | accepted | invalidated
HumanDecision = accept | request_adjustment
```

所有 enum 使用 closed union／Zod strict schema，provider-origin unknown 值 fail closed。

### 3.3 Durable acceptance store

新增 project-scoped private store；record identity為 `projectId + issueId + jobId + mergeCommit + requirementDigest`，另有 `projectId + issueId` bounded index 找當前世代。Record至少包含spec §6.4欄位。Store必須提供：

- read
- create-after-merge CAS
- append-decision CAS
- attach-adjustment CAS
- record-adjustment-completion CAS
- invalidate-generation CAS
- list-pending bounded projection

不可把完整 record 塞進 Job progress；Job 只保存 acceptance requirement／verification level 的核可快照與 acceptance record identity。這讓工程 Job 可完成並釋放 Lease，而產品 acceptance 獨立延續。

### 3.4 Lifecycle 接點

- AutoMergeGate 前所有既有檢查不變。
- exact merged read-back 後：
  - `not_required`：沿用 LWS completed path。
  - `required`：先 CAS 建 pending acceptance record，再完成 Job、釋放 Lease／claim，最後投影 Linear 保持 `in_review` 並留下單一通知。
- pending record 成功以前不得完成 Job；crash 後 reconcile 可從 merge receipt補建 record，不重跑 Reviewer／merge。
- generic dispatch 在 admission 最前面查 active／completed Job 與當前有效 acceptance generation；只有 identity完全相符的pending／adjustment_pending會阻擋重派，accepted／invalidated舊世代不阻擋合法reopen新Job。

### 3.5 人類裁決入口

第一版新增明確 CLI／application use case，供 Team Lead 或受信任 localhost UI 呼叫：

```text
agent-team project acceptance list [--project <id>]
agent-team project acceptance accept --project <id> --issue <id> --decision-receipt <opaque>
agent-team project acceptance request-adjustment --project <id> --issue <id> --decision-receipt <opaque> --summary-file <path>
```

- `--decision-receipt` 是受信任 Team Lead／UI interaction 產生的一次裁決冪等鍵，不是新的授權token；權限仍只來自owner／designated-decider capability。Receipt opaque且不可從Linear comment推導。
- mutation command 都有 `--dry-run`：只做 owner、identity、current state、預計 mutation read-back；零 mutation，合法 exit 0、阻擋 exit 3。
- 真 command 需 registration owner／指定裁決者 capability；沿用既有 localhost confirmation／authorization pattern，不另建遠端 auth。
- adjustment command 使用 WorkManagement port 建一張 Backlog linked issue，填入新 Template、來源 issue relation與新的 acceptance／verification labels；同 receipt replay只 read-back既有 issue。

### 3.6 人類修改收件邊界

Core v1 不自動掃描並提交任意 working tree。Team Lead的host operation先建立private human-owned-region reservation；保存後read-back diff、產生adjustment summary file並呼叫request-adjustment建單；接著現有dispatch處理該新Job，收件完成或放棄後釋放reservation。Repo dirty diff的意圖判斷仍由Team Lead完成，Core只確保ownership admission與adjustment issue／Job／PR／merge lifecycle有正式綁定。

## 4. Task dependency graph

```text
HDW00 exact baseline integration
  └─ HDW01 Linear/template/domain contracts
       ├─ HDW02 admission + validation policy
       └─ HDW03 durable acceptance/ownership stores
       {HDW02,HDW03}
            ├─ HDW04 merge/lifecycle split
            └─ HDW05 decision + adjustment commands
       {HDW04,HDW05}
            └─ HDW06 dependency release + reminders/UI
                 └─ HDW07 qualification + project rollout
                      └─ HDW08 Tank issue migration + next batch
```

HDW02與HDW03只依賴HDW01，可分開實作；HDW04／05必須等兩者完成，因其同時需要核可snapshot與durable store。本session由單一code writer依序提交，避免相同adapters／schemas的共享worktree競態。

## 5. 封閉 Task packets

### HDW00 — Exact baseline integration

範圍：

- 保存 spec／plan commit。
- read-back LWS PR/head 與 origin/main。
- 在隔離 branch 建立可重現的 stacked baseline。
- 只解決 LWS 與 main 的直接編譯／測試衝突，不新增 Core 行為。

驗收：

- 以開始HDW00時read-back並記錄的exact origin/main SHA執行`git merge-base --is-ancestor <sha> HEAD`，不以浮動ref作證據。
- LWS `83df064` 的patch identity可由ancestry／`git patch-id`證明；若因必要conflict resolution導致patch-id變化，LWS focused suite與behavior probes必須全綠作等價證明。
- `pnpm run typecheck`、LWS focused suite、`git diff --check` PASS。
- HDW00開始／結束各記錄共享main worktree的`rev-parse HEAD`與`status --porcelain=v1` digest，兩者完全相同才算dirty main零mutation。
- 產出並寫回§6.2的focused suite檔名清單。

升級條件：任何 conflict 需要改寫 LWS lifecycle 語意。

### HDW01 — Linear／Template／domain contracts

範圍：

- 在 Linear provision catalog 新增 `人類驗收` 與 `驗證強度` 單選群組。
- Template 在 Agent Packet 前新增固定三句人類摘要。
- Parser 新增 deterministic human-summary parser：只接受三個固定欄位、拒絕空值、重複 Packet Heading 與 duplicate field。
- WorkManagement read model 帶回兩個新 label 值；缺少／重名／多選 fail closed。
- 核可快照綁定 human summary digest、acceptance requirement、verification level。
- Domain closed unions、serialization 與 public-safe display names。

主要檔案：

- `src/application/registration/linear-provision-model.ts`
- `src/adapters/linear/requirement-template.ts`
- `src/adapters/linear/{model,read}.ts`
- `src/application/ports/work-management.ts`
- `src/domain/workflow/*` 或新的 `src/domain/acceptance/*`
- 對應 unit／contract／browser tests

驗收：

- 既有 Agent Packet parser fixtures全綠。
- 人類摘要 valid／missing／empty／duplicate／偽造 Packet Heading矩陣。
- 新 label provisioning preview→confirm→read-back→rerun unchanged。
- completed／canceled 歷史不在 provisioning mutation scope。

實作證據（2026-08-21）：

- focused unit／contract：8 files、128 tests PASS。
- Linear provisioning UI：5 tests PASS（先前已於非 sandbox localhost 驗證）。
- `pnpm run typecheck`、`pnpm run format:check`、`git diff --check` PASS。
- legacy project 只有兩組新 label 都缺席時可讀；任一群組半套／重名／缺值、多選均 fail closed。
- 第二模型 code review 因讀取範圍失控，在 4 分半仍未交付結論時依 bounded-review 原則中止；沒有將未完成審查冒稱 PASS。

### HDW02 — Admission 與驗證政策

範圍：

- Ready candidate 必須帶兩個新 label與valid human summary。
- approved snapshot 持久化後，任一 summary／Packet／label漂移走 `requirements_changed`。
- 新增唯一 `VerificationPolicy`：共同工程 Gate 下限＋light／standard／strict額外命令選擇。
- 實作者不能降低等級；Reviewer升級只能綁本 Job／snapshot並附 closed reason。
- rollout switch只在project provisioning read-back成功後啟用；不是project opt-in。
- 新增private `HumanOwnedRegionReservationStore`：Team Lead建立／釋放exact repo＋canonical regions＋baseline identity；admission以deterministic path overlap檢查，重疊／無法canonicalize時在Job／Lease／claim前fail closed。

驗收：

- 缺任一新欄位：零 provider、零 Job／Lease／claim。
- digest drift：零 provider，回既有 requirements_changed path。
- 三級 policy命令集合與不可降低矩陣。
- human-owned region overlap或reservation identity漂移時零provider、零Job／Lease／claim；不重疊工單仍可正常派工。
- LWS off／observe／enforce既有測試不退化。

### HDW03 — Durable acceptance／ownership stores

範圍：

- 實作 strict schema、private atomic persistence、CAS revision與bounded list。
- 實作 state transition：
  - create `pending`
  - new request receipt：`pending → adjustment_pending`
  - linked adjustment completed：`adjustment_pending → pending`
  - new accept receipt：`pending → accepted`
- cancel／reopen／requirement identity drift：`pending | adjustment_pending → invalidated`；一次冪等drift finding，不自動回改Linear。
- `decisions[]`、`adjustments[]` sequence monotonic；同 decisionReceiptId replay回原結果。
- 禁止 receipt重用於不同issue／decision／sequence。
- adjustment completion以`adjustmentIssueId + exact merge receipt`為冪等鍵。
- 實作HDW02所需的human-owned-region reservation strict store／CAS；完整diff與summary不進store。
- public projection只含安全欄位，不含summary file path、raw diff、secret或模型輸出。

驗收：

- CAS race單一winner。
- crash injection於每個append／attach階段可重啟收斂。
- 同receipt重放不重複；不同receipt可開第二輪adjustment。
- corrupted／unknown schema fail closed且不自動覆寫。
- bounded list與跨project隔離。
- reopen新Job可建立新generation；舊accepted／invalidated record不被覆寫也不阻擋。

### HDW04 — Merge／Job／Linear completion分流

範圍：

- 在既有 exact merged lifecycle唯一接點加入 requirement分流。
- required path先建 acceptance checkpoint，再 Job completed與release，Linear保持in_review。
- not_required與legacy in-flight沿用existing Done path。
- reconcile從merge receipt補建checkpoint，所有 mutation冪等。
- generic dispatch／resume／reconcile命中identity相符的pending／adjustment_pending generation或已完成engineering Job時跳過；invalidated／accepted舊generation不誤擋合法新Job。
- Linear手工Done不推導accepted，只建立一次drift finding；不自動回改。
- external merge沿用既有 provenance與project auto-merge pause。
- Legacy Job缺acceptance snapshot仍可strict read，固定走legacy Done path；不回填、不猜label。

驗收：

- required happy path五項一致：GitHub merged、Job completed、Lease／claim released、Linear in_review、pending record。
- not_required existing happy path完整不退化。
- checkpoint前／後crash、duplicate webhook、timer/reconcile併發。
- checkpoint後取消／reopen／identity drift會invalidated舊record；不列pending、不解除依賴、不重派舊Job。
- C035取消、head drift、BEHIND、CI非綠、review status不符、external merge、direct-squash前取消逐條負向測試。
- acceptance pending不得成為新的merge入口。
- 等待產品驗收本身永不投影`需人工`；真實integration failure仍沿用既有block路徑。

### HDW05 — Owner decision與adjustment issue

範圍：

- application use cases與CLI：list、accept、request-adjustment、各自dry-run。
- owner／designated decider capability read-back。
- accept：exact issue／merge identity read-back→CAS accepted→Linear Done→單一稽核留言；crash後由同command或reconcile依accepted record冪等補完Linear／留言。
- adjustment：CAS reserve sequence→以decisionReceiptId衍生safe SHA-256 marker→create前bounded search/read-back marker與來源relation→必要時建立Backlog linked issue→權威read-back→attach id→留言。零或一match可收斂，多match fail closed。
- 新adjustment issue使用新Template、白話title、兩個label與Agent Packet；固定`人類驗收=不需要`，驗證強度不得低於原單且Team Lead可顯式提高。子單exact engineering merge receipt觸發父單回pending，不等待子單產品acceptance。
- adjustment完成只把原單回pending；不得自動accepted。

驗收：

- unauthorized／wrong project／wrong merge／not pending／receipt collision：零mutation、exit 3。
- dry-run零WorkManagement mutation、零store mutation。
- 同receipt連跑兩次只一張issue／留言。
- crash注入於provider create已成功但本機attach前；replay以marker找回同一issue，仍只有一張issue／一則留言。
- 第二個新receipt合法建立sequence 2。
- accept在CAS後、Linear Done後、留言後各點crash可由reconcile收斂；replay只一個Done mutation／留言。
- 任意Linear留言不能觸發decision。

### HDW06 — Dependency release、提醒與 UI

範圍：

- dependency resolver新增engineering-complete proof，條件必須是effective completed Job、exact merged receipt、release receipts、無active Job／Lease／claim、未取消／reopen／identity drift。
- Linear Done不再是required acceptance前置的唯一解除條件；只對具有valid pending record的前置使用新proof。
- `pending`與`adjustment_pending`都維持既有engineering-complete依賴解除；`invalidated`與identity漂移record不得解除也不得列pending。
- Team Lead project read model與CLI status加入pending acceptance摘要。
- production UI顯示pending／adjustment_pending count與清單。
- Linear merge後通知與drift finding使用stable marker，無每日spam。

驗收：

- 缺任一proof時下游不解除。
- 只有Linear in_review／留言時不解除。
- valid required前置可解除；原工單仍未Done。
- adjustment_pending仍維持工程依賴已解除；invalidated／cancel／reopen／identity drift均fail closed。
- 零pending顯示0，不誤列一般in_review。
- reconcile／UI reload不重複留言。

### HDW07 — Qualification 與全專案 rollout

範圍：

- 更新 requirements／operator文件與migration runbook。
- Runbook固定人類修改收件：不明變更停止並問最小澄清、reservation建立／釋放、不得直接寫protected branch；以演練紀錄作AC18證據。
- 完整 release gates。
- 以 Agent Team Sandbox 做新專案／舊Backlog／legacy in-flight三種fixture canary。
- 逐專案先provision read-back，再啟用新admission；不做workspace-wide issue rewrite。
- provisioning切換窗口先以project scope pause新admission，確認零legacy Ready被舊路徑接走；in-flight依legacy收斂後再啟用新admission。此pause是migration操作，不是長期project opt-in／kill switch。
- fresh-context驗收；若上位指令仍禁止subagent，以獨立、只依AC的驗證pass代替並揭露。

驗收：

- format、typecheck、lint、build、full tests、browser tests、diff-check全綠。
- spec AC 1～20逐條evidence matrix。
- Sandbox canary：required與not_required各一張；不得碰Tank程式碼。
- completed／canceled歷史mutation count=0。
- release前in-flight fixture沿舊路徑Done。

### HDW08 — Tank 工單遷移與下一批建單

前置：HDW07全部通過、Core已合併、Tank project零legacy in-flight Job／active Lease／claim，且project provisioning read-back成功。

範圍：

- read-back LEA-42、LEA-83～88當前狀態與內容；任何identity變化先停。
- LEA-83～88逐張留相同語意但含各自ID的取消原因，再移已取消。
- LEA-42零mutation。
- 一次建立完整下一批：坦克移動、鏡頭平移跟隨、基本碰撞、手感驗收。
- 白話title、三句導演摘要、完整Agent Packet、acceptance／verification labels、native dependencies全部read-back。
- 依dependency只把第一波安全工單移待執行；其餘留Backlog。

驗收：

- 只 mutation LEA-83～88與新工單。
- Tank repo、branch、PR零mutation。
- 新批次範圍不含射擊、砲塔、AI、血量、HUD、音效。
- `run --dry-run`只會選中依賴已解除且已移Ready的第一波。

## 6. 測試策略與收束

### 6.1 驗證強度

Agent Team Core 自身固定為嚴格：

- 每個 Task跑focused tests。
- HDW04／05／06跑完整race／negative invariants。
- HDW07才跑一次完整release gate，不在每個小改重跑全套。
- 實作review一輪；若有直接blocker，修一次並定向複驗原blocker。
- 第三層仍不收斂就啟動驗收範圍熔斷，不新增假想future fixtures。

### 6.2 必跑命令

```text
pnpm run format:check
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm test
pnpm test:browser
git diff --check
```

具體focused test檔名在HDW00完成baseline後依現有test boundaries確定，不預先創造重複suite。

HDW00確定的focused suite如下；後續Task依直接變更邊界取其子集，HDW07才跑完整release gate：

```text
tests/unit/dispatch-bootstrap-reconciliation.test.ts
tests/unit/dispatch-issue-scope-lock.test.ts
tests/unit/dispatch-once-admission.test.ts
tests/unit/dispatch-pre-pr-implementation-coordinator.test.ts
tests/unit/dispatch-work-status-capability-store.test.ts
tests/unit/dispatch-work-status-orphan.test.ts
tests/unit/dispatch-work-status-recovery.test.ts
tests/unit/project-read-model.test.ts
tests/unit/ui-production.test.ts
tests/unit/work-status-lifecycle-coordinator.test.ts
tests/integration/ui-production.test.ts
tests/browser/ui-production.browser.ts
```

HDW00證據：`HEAD=49ab2b6`時，`origin/main=f21e4cc`與LWS squash merge `3a499681` ancestry PASS；typecheck PASS；上述Vitest 103 tests PASS；Playwright 1 test PASS。localhost UI probes在sandbox內因禁止bind立即失敗，依相同build在非sandbox重跑一次即PASS；這是執行環境分類，不是code retry。

## 7. Commit／PR策略

- 一個stacked feature branch，一張Core PR，依HDW00～07保留可review commits。
- HDW08是live Linear rollout evidence，不修改Core PR code；以docs evidence commit或Linear/GitHub既有稽核來源記錄，不在Tank造filler commit。
- Core PR描述必須標出LWS dependency、exact base/head與dirty main隔離證據。
- 禁止force push、禁止繞過branch protection、禁止手動merge。

## 8. 完成定義

只有以下全部成立才稱 Core 完成：

1. Spec與plan跨模型review通過。
2. HDW00～07 code與docs已在GitHub由既有gate合併。
3. Spec AC 1～20均有可重跑證據。
4. Sandbox required／not_required canary收斂且零歷史批次重寫。
5. 所有Lease／claim釋放，無pending migration mutation。

HDW08完成後，才宣布工作流已在Tank生效，接著開始坦克玩法工單。
