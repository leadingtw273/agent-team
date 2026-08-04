# S005：GitHub／gh 可行性 Spike

## 裁決

GitHub／`gh` 的 Branch、Draft PR、Actions Checks、Commit Status 與 Squash Merge 能力可採用；但目前 private Repo 的帳號方案不能使用 Rulesets／Branch Protection，Auto-merge 設定也無法啟用，因此第一版「required `agent-team/review` status＋GitHub Auto-merge」Gate 在現況下是 Block。必須升級支援 private protection 的 GitHub 方案，或改用可支援的公開／其他 Repo；不得用 Controller 自行 merge 冒充 GitHub enforced gate。

| 能力                | 裁決                    | 證據與限制                                                                                                                                                       |
| ------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gh 登入與 Repo 權限 | Adopt                   | 真 Probe 確認 active account、HTTPS Git、Repo admin／maintain／pull／push；Fixture 不保存 login 或 Token。                                                       |
| Branch／Push        | Adopt                   | S005 使用獨立 `task/S005-github-spike` Branch 與 worktree 真 Push。                                                                                              |
| Draft PR            | Adopt                   | PR 初始 read-back 為 `OPEN`＋`isDraft=true`；Checks 完成後仍保持 Draft，`gh pr ready` 後才轉 false。                                                             |
| Actions Checks      | Adopt                   | Draft PR 的 `Quality gates` 從 `IN_PROGRESS` 轉 `COMPLETED/SUCCESS`，可和 Head SHA read model 一起判讀。                                                         |
| Commit Status       | Adopt with read-back    | 對完整 Head SHA POST `agent-team/spike=success` 成功；POST response 沒有可直接核對的 SHA 欄位，必須再 GET combined status，確認 context、state 與 combined SHA。 |
| 同帳號原生 Approval | Block／known limitation | `gh pr review --approve` 真回 `cannot_approve_own_pull_request`，read-back reviews 仍空。第一版沿用結構化 Review Comment＋`agent-team/review` Commit Status。    |
| Rulesets            | Block on current plan   | Private Repo API 回 `requires_paid_plan_or_public_repo`，不是 Token 權限不足；目前不能建立／read-back required status rule。                                     |
| Branch Protection   | Block on current plan   | main protection API 同樣回方案限制；不能在 GitHub 端強制 PR／CI／Review Gate。                                                                                   |
| Auto-merge setting  | Block on current plan   | 原值 false；PATCH true exit 0 但 response 與再次 GET 仍 false，無設定漂移。不得把 silent no-op 當啟用成功。                                                      |
| Squash Merge        | Adopt                   | 既有 Phase 0／S001-S003 PR 已真 squash merge；S005 完成後仍以同路徑合併並驗 main CI。這不等於 Auto-merge queue。                                                 |
| Ruleset read-back   | Guardrail               | Registration／Doctor 必須先讀 capability，再建立規則、再 GET read-back；403／silent no-op 都讓專案保持設定未完成。                                               |

## 重要發現

### Admin 權限不等於功能方案可用

Repo response 顯示 admin=true，但 Rulesets 與 Branch Protection 都回需要升級或公開 Repo。Controller 不得把 403 簡化為 generic permission retry；這是使用者方案／可見性決策，必須在 UI 顯示明確 blocker。

### Commit Status 一定要二次 read-back

Status POST 成功只證明 API 接受請求；本次 POST response 沒有可直接比對的 `sha`。安全 Gate 必須再讀 combined status，確認：

1. combined SHA 等於目前 PR Head SHA；
2. context 精確等於 `agent-team/review`；
3. state 是 success；
4. Review Digest 與需求快照仍有效。

任何新 Push 都會換 Head SHA，舊 Status 不得沿用。

### Auto-merge PATCH 可能 exit 0 但完全沒生效

本次把 `allow_auto_merge=true` 的 PATCH 回應仍是 false，再次 GET 也是 false。這和模型 Job 的 outcome 原則相同：exit 0 是傳輸結果，不是狀態證據；設定型操作必須 read-back。

## 可重跑指令

```bash
node spikes/github/gh-probe.mjs repo
node spikes/github/gh-probe.mjs status <FULL_HEAD_SHA>
node spikes/github/gh-probe.mjs pr <PULL_NUMBER>
```

Status mode 會寫入隔離 Head SHA 的 `agent-team/spike` context；不得對未知 SHA 或使用者未置於 Probe 範圍的 Repo 執行。PR／SHA／帳號與 URL 不寫入共享 Fixture。

## A007／A008 採用邊界

1. Transport 可使用 `gh api`／REST／GraphQL，但 Domain 只接收去識別、型別化 capability 與 outcome。
2. Project Registration 在 required status／ruleset／auto-merge 三項 read-back 前維持 `setup_incomplete`，Dispatcher 不啟動全自動開發。
3. 單帳號 Reviewer 用結構化 Comment 表達 finding，再由 Controller 對已驗 Digest 的 Head SHA 寫 `agent-team/review` status；不得偽造 GitHub Approval。
4. Auto-merge 未啟用時不能退化為「Controller 看起來都綠就直接 merge」；這會繞過需求中鎖定的 GitHub merge Gate。
5. 所有 PR mutation 後再 GET read-back；未知 check、缺 Head SHA、403、silent no-op 或 schema 漂移都 fail-closed。
