# Agent Team Linear 工作狀態生命週期實作計畫

狀態：已核可，可實作  
日期：2026-08-18  
規格：`docs/spec-linear-work-status-lifecycle.md`  
決策者：leadi

## 1. 交付目標

把已核可的Linear主要狀態與Agent狀態接入production dispatch／resume／review／merge／lifecycle，讓
Agent Team受管工單可誠實顯示待執行→進行中→審查中→已完成，且任何Linear mutation、crash、重試、
人工漂移或並行cycle都不能重複Job、Provider、PR、留言或merge。

本計畫不修改Tank Skirmish遊戲程式碼；只在最終rollout以獨立PR修改其
`.agent-team/project.json` trusted config。本計畫也不修改另一個session尚未提交的Ready Gate規格／計畫／
fixture；會先建立唯一共享per-issue lock contract，Ready Gate實作只能import此模組，不得另建第二把lock。

## 2. 現況盤點與實作約束

1. `dispatchOnce`已在`src/cli/dispatch/composition.ts:399-439`先建立durable admission claim，但selected
   claim的`attachJob`仍是best-effort；Job progress則到`src/cli/dispatch/handlers.ts:1096`啟動Implementer
   後才依outcome落盤。必須先建立初始progress checkpoint，不能只補Linear mutation。
2. `FileJobProgressStore`已有private CAS／read-back、immutable checkpoint慣例，適合承載
   `workStatusLifecycle`；現有record schemaVersion維持1，新欄位對legacy record optional。
3. `LinearWorkManagementAdapter.setWorkStatus`目前只支援completed／requires_manual／in_review；需加入
   in_progress的cause mapping，並新增正式`clearAgentCondition`port。
4. `LinearMutationClient`沒有外部CAS／idempotency；所有key只可作Controller本機ledger／comment marker。
5. `resumeUnderLease`在任何stage前先假設PR存在；work-start checkpoint沒有PR，必須在此假設前分流到
   共用的pre-PR implementation coordinator。
6. `resumeReview`目前在`ReviewStatusCoordinator.begin`後直接建立證據並呼叫Reviewer；changes requested
   也在record review後直接呼叫ReviewerRecovery。兩者都缺Linear confirmed gate。
7. `ReviewerWaitPublicationCoordinator`目前才在限流後寫in_review；導入正式review-start gate後，它只能
   負責waiting label／安全留言／GitHub pending，不得重複擁有主要狀態。
8. `AutoMergeGate`與direct-squash已具C035取消雙重read-back；新work-status preflight只能在enforce Job
   增加fail-closed輸入，不能另建merge路徑或弱化`cancellation_after_merge`。
9. Manual reconcile已會讀`FileJobProgressStore`並依`isResumeCandidate`派回production resume；新增stage與
   checkpoint必須進同一條路，不另建timer engine。
10. Trusted project config是default-branch authority；新增optional mode、undefined解析為off，避免現有
    `.agent-team/project.json`與大量fixture失效。Job admission時另存mode snapshot，後續config降級不改寫
    in-flight語意。

## 3. 目標架構

### 3.1 單一協調器

新增application層`WorkStatusLifecycleCoordinator`，只接受窄port：

- Job progress CAS／read-back
- issue admission claim read／attach
- per-issue lock／job lease heartbeat
- WorkManagement get/list/set/clear/comment
- project capability inventory
- clock與project-health observation

協調器輸出closed union：`confirmed | observe_only | pending_retry | requires_manual |
authority_ambiguous | already_terminal`。CLI composition只映射結果，不自行重寫狀態政策。

Per-issue lock是獨立於任何rollout mode的本機基礎設施：唯一模組
`src/adapters/dispatch/issue-scope-lock.ts`，canonical key與admission store一致為
`${projectId}__${issueId}`，實體路徑固定在`$AGENT_TEAM_HOME/state/dispatch/issue-scope-locks/`，底層重用
`acquireRecoverableFileLock`的逾期回收語意。Dispatch、resume、reconcile、Webhook與未來Ready Gate都只能
import同一factory／port；不得各自建立readiness lock與work-status lock。

### 3.2 Durable checkpoint

`JobProgressRecord.workStatusLifecycle?`至少保存：

- `admissionMode`與capability digest
- `phase`
- current transition instance／step／target
- main-state intent、confirmed／settlement receipt
- Agent／blocking label intent、ownership receipt
- `(jobId, step, transitionInstance)`連續失敗計數
- safe incident／reason code
- recovery epoch與operator-authorized receipt

新Job在Provider前先寫`stage.kind = work_start_pending`與checkpoint；Linear confirmed後、Provider啟動前
CAS為既有`stage.kind = implementing`的新版variant並保存pre-PR execution epoch。新版`implementing`只有在同Job lease已逾期、
無confirmed Provider產出且domain `Job.attempts.processRecoveries`尚未達既有上限時可resume；legacy bare
`implementing`或缺checkpoint record保持blocked。Legacy records欄位缺席時依off處理，不得偷偷回填enforce。

### 3.3 寫入順序

所有主要狀態mutation共用：

1. CAS intent。
2. 取得同一per-issue lock、heartbeat lease。
3. immediately-before-send權威read與pre-condition重驗。
4. mutation。
5. immediate read-back。
6. CAS confirmed receipt。
7. 再次重讀取消／identity／drift。
8. 才啟動下一個Provider／Reviewer／merge副作用。

重試永遠read-first。`sent_unknown`只能形成settlement receipt；timer不得升級授權。

## 4. Task dependency graph

```text
LWS00 contracts/config/capability
  └─ LWS01 durable ledger/coordinator
       ├─ LWS02 work-start admission gate
       │    └─ LWS03 pre-PR resume/reconcile
       ├─ LWS04 review/fix lifecycle
       └─ LWS05 merge/lifecycle invariants
       {LWS02,LWS04,LWS05}
            └─ LWS06 orphan + controlled recovery
       {LWS02,LWS03,LWS04,LWS05,LWS06}
            └─ LWS07 projections/operations
                 └─ LWS08 qualification + live rollout
```

LWS02／LWS04／LWS05在LWS01完成後可分支開發；LWS06／LWS07不得在其receipt／phase前置未合併時宣稱
客觀驗收完成。所有分支合併前必須共同通過LWS08 race matrix。

## 5. 封閉 Task packets

### LWS00 — Config、port與Linear capability contract

範圍：

- 在`src/application/projects/schema.ts`加入optional
  `workStatusLifecycleMode: off | observe | enforce`，提供唯一resolver把undefined解成off；serialisation不得
  自動改寫legacy file bytes。
- 擴充registration draft／setup／trusted-config read-back與tests，讓新project明示off、舊project仍合法。
- 擴充`WorkManagementPort`與`LinearWorkManagementAdapter`：支援`in_progress`、既有`in_review`、正式
  `clearAgentCondition`；`WorkManagementIssueSnapshot`保留Linear的agentRole／reviewRequirement，並實作
  bounded `listIssues`（先list state IDs、再逐張read-back），供orphan分類使用。
- 擴充`src/domain/workflow/transition.ts`的封閉矩陣：允許Controller policy將in_progress／in_review轉
  requires_manual，允許waiting→executing；completed／canceled終態、人工drift零主要狀態覆寫仍不可放寬。
- 建立canonical capability snapshot／digest：team、project、六個workflow state、Agent status group、
  blocking reason group及必要label IDs；缺少／重名／漂移回closed reason。
- 新增project-levelprivate capability evidence store，observe／enforce都可更新；off零network probe。

主要檔案：

- `src/application/projects/schema.ts`
- `src/application/ports/work-management.ts`
- `src/domain/workflow/transition.ts`
- `src/adapters/linear/model.ts`
- `src/adapters/linear/read.ts`
- `src/adapters/linear/write.ts`
- `src/cli/dispatch/work-management-adapter.ts`
- `src/application/registration/*`、`src/adapters/registration/*`
- 新增`src/adapters/dispatch/work-status-capability-store.ts`

不變式：

- Undefined mode永遠是off；不得因loader parse把舊trusted config digest改掉。
- Linear state／label name只在catalog resolution存在；runtime只使用固定ID／digest。
- `clearAgentCondition`只清Controller controlled Agent status／blocking reason labels，保留Agent role、review
  requirement與other labels。
- 只有`policy_requires_manual`可做in_progress／in_review→requires_manual；requirements_changed與人工drift
  不得借此覆寫。Agent waiting→executing為顯示恢復，不授權任何Provider。

客觀驗收：

- Legacy config fixture parse＋serialize byte/digest不變。
- Missing／duplicate state、missing label group、permission failure各自拒絕enforce，零Job／claim／mutation。
- in_progress／in_review／clear condition contract tests均做authoritative read-back。
- Work transition合法／非法全矩陣、waiting→executing，以及completed／canceled終態拒絕測試。
- listIssues分頁／read budget、Agent role保留、無Agent role的一般In Progress fixture可被分類為out-of-scope。

驗收命令：

- `pnpm vitest run tests/integration/trusted-project-config.test.ts tests/unit/project-registry.test.ts`
- `pnpm vitest run tests/contract/linear-read-model.test.ts tests/contract/linear-mutations.test.ts`
- `pnpm vitest run tests/unit/dispatch-work-management-adapter.test.ts`
- `pnpm vitest run tests/unit/workflow-state.test.ts`

升級條件：若Linear catalog無法唯一取得team-scoped ID，或trusted config backward compatibility需改
schemaVersion，改code前回決策層。

### LWS01 — Durable lifecycle ledger與Coordinator

範圍：

- 在`job-progress-store.ts`加入optional、strict、bounded的`workStatusLifecycle`checkpoint與新
  `work_start_pending`stage；擴充既有`implementing`variant可保存optional execution epoch／restart evidence，
  讓legacy bare record仍可讀但不自動resume。加入`bootstrap_incomplete`requires-manual reason、immutable
  identity、monotonic counter、confirmed receipt不可回退的CAS invariants。
- 實作唯一shared `IssueScopeLock` adapter／port；canonical key、path、recoverable timeout與release evidence
  固定，所有mode都必須取得。另留明確contract：Ready Gate RG02／RG04／RG06只能import同一模組。
- 新增`WorkStatusLifecycleCoordinator`與model；實作off／observe／enforce、main-state與label獨立ledger、
  read-before-mutate、sent_unknown settlement、fallback counter與project-wide outage豁免。
- 使用穩定本機dedupe key；Linear adapter呼叫次數而非key字串作冪等證據。
- 定義namespaced reason codes、safe projection與public comment formatter。

主要檔案：

- `src/adapters/dispatch/job-progress-store.ts`
- 新增`src/adapters/dispatch/issue-scope-lock.ts`
- 新增`src/application/pipelines/work-status-lifecycle-{model,coordinator}.ts`
- `src/application/pipelines/index.ts`

不變式：

- Legacy record無checkpoint仍可讀；不得自動升成enforce。
- Confirmed receipt、admission mode、capability digest與transition identity一旦寫入不得刪改。
- `sent_unknown`永不成為confirmed authorization。
- Main-state與label failure budget分離；provider-wide outage零per-issue increment。
- 同issue跨dispatch／resume／reconcile／Webhook只使用同一lock；不同路徑不得以不同prefix形成第二把lock。
- `work_start_pending`只續作Linear；`implementing`只在lease逾期、無confirmed output且
  `processRecoveries`未耗盡時重啟，超限requires-manual。

客觀驗收：

- Same transition重試N次，target已達時adapter mutation恰一次。
- CAS conflict零confirmed receipt、零下一Provider。
- Label失敗不gate已confirmed主要狀態，且只清ownership receipt對應label。
- Counter第1–5次pending、第6次耗盡；duplicate webhook不加計、成功只歸零該instance。
- 三路併發競逐同issue時lock winner恰一；claim與Linear mutation各一。Ready Gate production端整合在
  RG落地前標為外部依賴，但以第二個fake lock client證明同模組互斥。
- Implementing process crash：bounded restart至既有上限後requires-manual，confirmed commit／PR仍各一。

驗收命令：

- `pnpm vitest run tests/unit/dispatch-job-progress-store.test.ts`
- `pnpm vitest run tests/unit/work-status-lifecycle-coordinator.test.ts`
- `pnpm vitest run tests/unit/dispatch-issue-scope-lock.test.ts`

升級條件：若單一Job progress CAS無法表達跨Linear mutation crash window，先停下調整ADR，不新增第二套
無關store規避。

### LWS02 — Fresh dispatch work-start gate

範圍：

- Claim時同步保存bounded `externalIssueId`，讓jobless bootstrap可被安全診斷；selected claim `attachJob`從
  best-effort改為必須confirmed，非selected claim仍安全reconcile。
- 在`dispatchOnce`內加入post-dispatch bootstrap port：Dispatcher回傳job.id後，先以CAS寫初始
  `work_start_pending`progress，再attach selected claim，兩者都confirmed才可回到handler進Linear gate。
  Branch／worktree path可用純函式先計算，但不得建立directory／worktree或啟動Provider。
- Attach失敗不釋放claim；因progress已存在，後續reconcile只補attach。Initial progress store失敗時保留
  active jobless claim，LWS03以claim external ID＋唯一domain Job寫`requires_manual(bootstrap_incomplete)`
  escape hatch；不得release後重派。
- 在enforce模式呼叫Coordinator完成Ready→In Progress與Agent Waiting／Executing投影；confirmed後才進
  pipeline composition、worktree directory、Implementer。
- Observe只寫預測inventory，副作用序列與off一致。
- 所有pre-pipeline failure仍留下可由`dispatch resolve`處理的progress record，不再重覆create。

主要檔案：

- `src/cli/dispatch/composition.ts`
- `src/cli/dispatch/handlers.ts`
- `src/cli/dispatch/implementer-request.ts`
- `src/adapters/dispatch/issue-admission-store.ts`

不變式：

- Job＋attached claim＋initial progress三者未confirmed前，零Linear in_progress mutation。
- In Progress未confirmed前，零worktree directory、零worktree、零Codex、零PR。
- Pre-send取消／需人工競態按spec補償或fail closed；不得覆寫無唯一證據的人類狀態。
- Partial bootstrap任何順序都保守保留claim；沒有可讀progress時仍不得因修復而建立第二個Job。

客觀驗收：

- Crash injection逐點覆蓋claim、attach、progress intent、Linear send、read-back、receipt、Provider前。
- off／observe相同fixture的worktree／Provider／PR call trace完全一致。
- enforce happy path Provider confirmed產出恰一次。
- Attach失敗注入：Job 1、claim 1、progress 1、Linear mutation 0；下一輪只補attach。
- Initial progress寫入失敗：當輪Linear／Provider 0；修復後產生一筆bootstrap_incomplete requires-manual
  progress，仍是原Job且claim未釋放。

驗收命令：

- `pnpm vitest run tests/unit/dispatch-once-admission.test.ts tests/unit/dispatch-cli-handlers.test.ts`
- `pnpm vitest run tests/unit/dispatch-run-pipeline.test.ts tests/integration/dispatch-run-end-to-end.test.ts`

升級條件：若mandatory attach需要改`Dispatcher`domain選擇演算法或Job identity，改code前回決策層。

### LWS03 — Pre-PR resume、lease與reconcile

範圍：

- 抽出共用pre-PR implementation coordinator，fresh handler與resume都使用同一份pipeline outcome→progress
  邏輯，避免兩套Provider路徑。
- `resumeUnderLease`在`changeRequestId`前辨識`work_start_pending`；先接續同Job／claim／intent，status
  confirmed後才啟動Implementer。
- 掃描active jobless／attached-but-no-progress claim：只有claim external ID與唯一domain Job完全相符時可補
  attach／bootstrap requires-manual；有多個或零個Job時保持blocked並留private incident，絕不重派。
- 加入while-lease-held heartbeat；lease逾期後新的holder只能接續同Job，不能重新claim／建Job。
- In Progress confirmed後CAS進`implementing`再啟動Provider；lease未逾期時第二holder零Provider。逾期且
  未有confirmed output時使用`Job.attempts.processRecoveries`既有上限，legacy bare implementing保持blocked。
- `isResumeCandidate`、manual reconcile inventory、cycle resume支援work-start與pending mutation。
- Linear全域backoff投影degraded但不累加每張工單。

主要檔案：

- 新增`src/cli/dispatch/pre-pr-implementation-coordinator.ts`
- `src/cli/dispatch/resume-composition.ts`
- `src/cli/dispatch/resume-existing.ts`
- `src/cli/reconcile/{active-job-inventory,composition}.ts`

不變式：

- Resume不需要PR也能處理work-start；其他stage仍要求exact PR identity。
- Crash後可重啟未產生confirmed output的process；commit／PR等confirmed output不可重覆。
- Requires-manual保留claim；只有terminal／explicit resolve釋放。

客觀驗收：

- Pending期間lease過期＋timer／manual reconcile／Webhook併發，Job／claim／mutation各一。
- Provider crash前後逐點測試，confirmed commit／PR各一。
- Jobless claim／attached-no-progress bootstrap repair各自收斂，duplicate／ambiguous domain Job零自動修復。
- Controller downtime不補failure count。

驗收命令：

- `pnpm vitest run tests/unit/dispatch-resume-composition.test.ts tests/unit/reconcile-active-job-inventory.test.ts`
- `pnpm vitest run tests/unit/reconcile-composition.test.ts tests/integration/cycle-projects.test.ts`

升級條件：若現有Job repository無法重建pre-PR request的權威資料，先停下補spec identity，不從local
worktree猜測。

### LWS04 — Review-start、waiting與fix-round gate

範圍：

- `ReviewStatusCoordinator.begin`與CI exact-Head green後，先持久化review-start intent，enforce確認Linear
  In Review後才建證據／呼叫Reviewer。
- `ReviewerWaitPublicationCoordinator`依Job admission mode分流：off完整保留現行
  setWorkStatus(in_review)＋waiting label＋Linear留言＋GitHub pending；observe只寫預測inventory與GitHub
  pending，所有Linear mutation為零；enforce由lifecycle coordinator唯一擁有主要狀態，wait publication只寫
  waiting label／安全留言／GitHub pending並沿用同一review transition receipt。
- Changes requested在`reviewStatus.record`後先寫fix intent、確認回In Progress，再呼叫ReviewerRecovery；
  每個fix round有不同transition instance。
- 限流／transport failure沿用現有reviewer budget；confirmed review result／公開留言恰一次，process啟動
  次數不作exactly-once承諾。

主要檔案：

- `src/cli/dispatch/resume-composition.ts`
- `src/cli/dispatch/reviewer-wait-publication.ts`
- `src/cli/dispatch/reviewer-replay-coordinator.ts`與
  `src/cli/reconcile/reviewer-replay-reconcile.ts`（只接共用gate，不改replay identity語意）

不變式：

- In Review未confirmed時Claude零次。
- 限流保持In Review＋Waiting；retry不重覆主要狀態mutation。
- Fix回In Progress未confirmed時Codex recovery零次。
- Reviewer replay success checkpoint仍須重新驗證status／CI／identity，不免除gate。
- Off不得因本功能改變legacy限流publication；observe雖抑制Linear publication，但Provider／worktree／PR
  副作用call trace與off相同；enforce不得由wait coordinator重覆寫In Review。

客觀驗收：

- First review、限流、transport retry、兩輪changes requested、replay checkpoint逐案call trace。
- Off／observe／enforce三組wait-publication call trace：off保持現況、observe零Linear、enforce主狀態零重寫。
- Review result／comment各一；不同fix round mutation各一，同round retry外部mutation仍一。
- CI waiting→fix round、限流waiting→Reviewer續作的Agent label皆可waiting→executing且receipt完整。

驗收命令：

- `pnpm vitest run tests/unit/dispatch-resume-composition.test.ts`
- `pnpm vitest run tests/unit/dispatch-reviewer-wait-publication.test.ts`
- `pnpm vitest run tests/unit/reviewer-replay-coordinator.test.ts tests/unit/reviewer-replay-reconcile.test.ts`

升級條件：若review intent無法在Claude前由現有identity資料完整固定，停下補identity contract，不降低
Reviewer strictness。

### LWS05 — Merge preflight與Lifecycle收尾

範圍：

- Enforce Job在`AutoMergeGate.enable`與direct-squash前新增expected work-status／drift read-back；off／observe
  完全維持現況，既有C035取消檢查永遠存在。
- 擴充merge request／port資料流，把per-Job
  `{ admissionMode, expectedWorkStatus, transitionInstance }`一路傳到
  `buildMergeGateSourceControl.enableAutoMerge`與direct-squash send boundary；off／observe傳undefined，
  enforce才驗expected status。不得以caller早一步的read取代send-boundary read。
- Work-status preflight failure走既有stage budget或fallback；zero merge mutation before confirmation。
- GitHub exact-Head merged後分三路：無drift正常Done；非取消人工drift保留主要狀態、Job／claim／lease
  收尾＋恰一留言；取消競態維持C035 blocked provenance。
- Terminal清除只有Controller ownership receipt的Agent／blocking labels；Linear不可用保存pending projection
  incident，不重送merge。

主要檔案：

- `src/application/pipelines/merge-gate-model.ts`
- `src/application/pipelines/merge-gate.ts`
- `src/cli/dispatch/status-merge-composition.ts`
- `src/application/pipelines/lifecycle-model.ts`
- `src/application/pipelines/lifecycle.ts`
- `src/cli/dispatch/lifecycle-*`
- `src/cli/dispatch/resume-composition.ts`

不變式：

- 唯一merge入口仍是`AutoMergeGate.enable`；無force／skip／bypass。
- C035 canceled、final read failure、direct-squash before-send cancel逐案不退化。
- Off／observe的work-status preflight參數必為undefined，既有C035 canceled／completed檢查順序不變。
- Merge receipt成立後不抹消事實、不revert、不重送。

客觀驗收：

- Canceled、status drift、BEHIND、CI非綠、review status mismatch、external merge、direct-squash cancel逐案
  斷言真GitHub mutation call count。
- Merge後crash、非取消drift、C035取消競態三路收斂。

驗收命令：

- `pnpm vitest run tests/unit/merge-gate.test.ts tests/unit/dispatch-status-merge-composition.test.ts`
- `pnpm vitest run tests/unit/lifecycle-pipeline.test.ts tests/unit/dispatch-lifecycle-cancellation-adapter.test.ts`
- `pnpm vitest run tests/unit/dispatch-resume-composition.test.ts`

升級條件：任何修改會改變C035`cancellation_after_merge`、external merge provenance或新增merge入口時停止。

### LWS06 — Orphan quarantine與Controlled recovery CLI

範圍：

- 以LWS00的bounded WorkManagement list/read（底層沿用`LinearReadModel.listIssueIdsInState`＋readIssue）與
  admission/progress inventory掃描「Agent角色＋automation ownership evidence」的In Progress issue；沒有
  Agent角色的ID在初次列表過濾後不再逐張執行額外mutation／comment。
- Receipt-aware區分terminal收尾殘留與真orphan；真orphan依裁決轉Needs Manual＋Blocked＋恰一留言。
- 新增`agent-team dispatch work-status-recover --job --transition [--dry-run]`；dry-run exit 0／3且零
  mutation／Provider。
- 執行模式只接受exact Job／claim／identity／history；可建立operator-authorized receipt，或在issue已回
  pre-state時開新bounded transition instance。舊sent_unknown永不升級。
- 與dispatch resolve整合ownership回交；requires-manual預設保留claim。

主要檔案：

- 新增`src/cli/dispatch/work-status-recovery-{handlers,coordinator}.ts`
- `src/cli/program.ts`、`src/cli/index.ts`、`src/cli/dispatch/index.ts`
- `src/cli/reconcile/composition.ts`
- `src/adapters/dispatch/issue-admission-store.ts`
- `src/adapters/linear/read.ts`、`src/cli/dispatch/work-management-adapter.ts`（只使用LWS00已建立能力）

不變式：

- Timer／Webhook／generic run不得自動執行recovery。
- Identity／history不唯一時零mutation、零Provider、零第二Job。
- Orphan quarantine只限automation-owned issue；沒有Agent角色的一般In Progress工單零副作用。

客觀驗收：

- sent_unknown target已達、pre-state還原、identity drift、CAS conflict、雙命令併發逐案。
- Orphan、terminal residue、真人ticket三分類各自mutation／comment call count。
- 真orphan測試必須讓domain transition與Linear read-back實際成功到requires_manual，不接受只斷言adapter
  method被呼叫；一般真人工單零mutation／零comment／零額外getIssue。

驗收命令：

- `pnpm vitest run tests/unit/dispatch-work-status-recovery.test.ts`
- `pnpm vitest run tests/unit/reconcile-composition.test.ts tests/integration/webhook-reconcile.test.ts`

升級條件：若Linear history無法提供規格要求的完整分頁evidence，recovery只能維持requires-manual，不得
放寬成timer自動確認。

### LWS07 — Project／CLI／UI projection與營運證據

範圍：

- 擴充project read model／schema，逐欄投影spec §5：mode、phase、expected／observed state、transition、
  pending mutation、authority、incident、capability與in-flight mode counts。
- Runtime status UI只顯safe closed fields；不讀raw adapter／provider payload。
- Lifecycle audit comment沿用既有成功留言，加入operation、job ID、work／review receipt digest、merge
  provenance、outcome；不新增第二則成功留言。
- Project降級只影響新admission；projection顯示仍依舊mode收斂的in-flight Job／pending intent數。

主要檔案：

- `src/cli/project/read-model.ts`
- `src/cli/project/schema.ts`
- `src/ui/features/runtime-status/*`
- `src/application/pipelines/lifecycle*`

不變式：

- Secret、raw output、unknown received value、adapter payload不得進CLI／UI／Linear／PR。
- `blocked_pending_mutation`不能冒稱Linear已Blocked。

客觀驗收：

- Schema exact-field tests、redaction fixtures、mode downgrade projection、lifecycle comment dedupe。

驗收命令：

- `pnpm vitest run tests/unit/project-read-model.test.ts tests/browser/ui-production.browser.ts`
- `pnpm vitest run tests/unit/lifecycle-pipeline.test.ts`

升級條件：若UI必須新增外部網路讀取才能顯示欄位，停下改以private snapshot，不在request path探測Linear。

### LWS08 — Qualification、Sandbox canary與Tank rollout

範圍：

- 建立跨Task race／negative matrix，完整映射spec AC1–AC30；不接受只驗「有呼叫gate」。
- 全repo quality gate與獨立驗證pass。
- Sandbox依序off baseline→observe→enforce，先happy path再負向canary；每案串行、遇錯即停。
- Sandbox收斂且`run --dry-run`不再選中測試單後，才由Agent Team Lead在Tank repo建立獨立config-only
  branch／PR，只修改`.agent-team/project.json`為enforce；經既有review／CI／merge後，以
  TrustedProjectConfigLoader read-back驗證Head、content digest與mode，再建立一張全新低風險測試單驗證
  In Progress／In Review。不得重用LEA-46／53或修改既有PR觸發。
- Sandbox enforce前先實測既有project pause／halt可阻止新admission。Rollback runbook：pause project→以
  config-only PR把新admission mode改回off→read-back default-branch digest／mode→reconcile既有Job仍按其
  persisted enforce snapshot收斂→四來源確認後才解除pause；不回捲既有Linear狀態或刪receipt。

全域驗收：

- Happy path五項一致：review success、GitHub merged、Linear Done＋單一稽核留言、Job completed、claim／
  lease released。
- Negative：取消、人工drift、sent_unknown、mutation 5xx、provider-wide outage、lease expiry、orphan、
  external merge、C035、direct squash、mode downgrade。
- 收斂後零active lease、零orphan claim、零duplicate Job／PR／comment；dry-run無殘留candidate。
- Readiness production實作尚未落地時，以共享lock的第二個fake client完成互斥驗收並明標RG integration
  pending；任何project若啟用readiness mutate，必須等RG改用同一IssueScopeLock後才可啟用work-status
  enforce。

驗收命令：

- `pnpm run format:check`
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run build`
- `pnpm test`
- 精準重跑spec §12列出的C035測試檔
- Sandbox／Tank四來源read-back：Job store、Linear、GitHub、claim／lease inventory
- Sandbox rollback演練：pause／halt、enforce→off config read-back、in-flight snapshot收斂

升級條件：

- 任一AC失敗、live identity漂移、GitHub／Linear事故、unexpected candidate或duplicate artifact立即停止。
- Live失敗不自動revert、不補filler commit、不手工拼receipt；先保存safe evidence並回決策層。

## 6. 合併與發布策略

1. LWS00、LWS01先各自小commit，建立兼容contract與durable base。
2. LWS02＋LWS03形成work-start vertical slice；在Sandbox仍保持mode off。
3. LWS04、LWS05接入review／merge，持續off下跑全回歸。
4. LWS06、LWS07完成營運與recovery後才允許observe。
5. LWS08先Sandbox observe對照off call trace，再enable Sandbox enforce。
6. Tank只在Sandbox完整收斂與fresh-context等價獨立驗證通過後顯式enable。

每個commit都必須保持legacy config與legacy Job可讀；不得批次修改`~/.agent-team/state`既有檔案。

## 7. 驗收方式與限制揭露

- 實作者：Codex主代理。
- 第二意見：spec與plan各用Claude Opus只讀review。
- 驗收：平台目前禁止再spawn新subagent，因此無法使用fresh-context subagent；完成實作後另開一個只依
  spec AC／git diff／測試命令、不依實作敘事的獨立驗證pass，並在回報明確標示此限制。
- 外部live canary只在全本機AC與第二模型code review通過後執行。

## 8. 完成定義

只有以下全部成立才可說完成：

1. LWS00–LWS08客觀AC全通過。
2. Claude plan review與code review沒有未處理blocker。
3. format／typecheck／lint／build／全測通過。
4. Sandbox observe與enforce happy／negative canary收斂。
5. Tank新工單顯示進行中→審查中→已完成，四來源一致。
6. 無duplicate Job／claim／lease／PR／comment，generic dry-run不再選中已完成工單。
7. 所有untracked其他session檔案保持原樣；Tank只允許獨立config-only PR，不得修改遊戲程式碼。

## 9. 第二模型復審處置

- Reviewer：Claude Opus；第一輪有效result為`changes_required`。
- 採用blocker：LWS00加入in_progress／in_review→requires_manual與waiting→executing封閉domain矩陣；
  LWS01成為唯一IssueScopeLock owner，Ready Gate只能import同一模組。
- 採用major：progress-before-attach與bootstrap escape hatch、pre-PR implementing bounded recovery、
  WorkManagement Agent role/list contract、off／observe／enforce wait-publication分流、direct-squash per-Job
  mode資料流、Task依賴修正、Tank config-only PR與rollback runbook。
- 採用minor：project projection schema只由LWS07擁有，merge／lifecycle主要檔案改列真實檔名。
- 不改產品語意：observe仍零Linear mutation；off保留現行限流publication。兩者只要求Provider／worktree／
  PR副作用一致，不要求Linear call trace一致。
- Ready Gate外部依賴：其production實作尚未落地；本計畫先交付共享lock與競爭client測試。RG若未改用
  同一模組，禁止在同project同時啟用readiness mutate與work-status enforce。
- 需使用者新裁決：無。
- 第二輪blocker-only Reviewer：Claude Opus；有效result為`pass`、`findings: []`。
- 非阻擋實作提醒：shared lock持鎖範圍不得造成reentrant自鎖；LWS00確認stateHistory完整分頁接點；
  LWS02與LWS03以同一vertical slice驗bootstrap recovery。
