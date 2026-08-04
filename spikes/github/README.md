# S005：GitHub／gh 可行性 Spike

## 裁決

GitHub／`gh` 的 Branch、Draft PR、Actions Checks、Commit Status、Rulesets API、Auto-merge capability 與 Squash Merge 可採用。Repo 經 Secret 歷史掃描與 leadi 明確授權後已改為 public；原 private plan blocker 已解除。現況仍是「capability 可用、required merge gate 尚未配置」：Rulesets 可讀但為 0 條，main Branch Protection 尚未設定，因此不能宣稱 `agent-team/review` 已由 GitHub 強制。

| 能力                | 裁決                         | 證據與限制                                                                                                                            |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| gh 登入與 Repo 權限 | Adopt                        | 真 Probe 確認 Repo public、admin／maintain／pull／push；Fixture 不保存 login 或 Token。                                               |
| Branch／Push        | Adopt                        | S005 使用獨立 Branch／Worktree 真 Push。                                                                                              |
| Draft PR            | Adopt                        | PR 初始 read-back 為 `OPEN`＋`isDraft=true`；Checks 完成後仍保持 Draft，`gh pr ready` 後才轉 false。                                  |
| Actions Checks      | Adopt                        | Draft PR 的 `Quality gates` 從 `IN_PROGRESS` 轉 `COMPLETED/SUCCESS`，可和 Head SHA 一起判讀。                                         |
| Commit Status       | Adopt with read-back         | 對完整 Head SHA POST status 後再 GET combined status，確認 context、state 與 combined SHA。                                           |
| 同帳號原生 Approval | Block／known limitation      | `gh pr review --approve` 真回 `cannot_approve_own_pull_request`。第一版沿用結構化 Review Comment＋`agent-team/review` Commit Status。 |
| Rulesets API        | Adopt／configuration pending | Public Repo API exit 0、read-back count=0；O004 可做差異預覽與 provision，但目前沒有 required status rule。                           |
| Branch Protection   | Not configured               | API 回 `not_found_or_not_configured`，不再是 plan 403；不得把 404 當 capability 不可用或已配置。                                      |
| Auto-merge setting  | Adopt with read-back         | 初始由 false 啟用後 read-back true；重跑 PATCH 前後皆 true、無 configuration drift。這只開 capability，不會自行合併 PR。              |
| Squash Merge        | Adopt                        | Phase 0／S001-S006 PR 均真 squash merge並驗 main CI；在 Ruleset provision 前仍屬已驗流程，不等於 GitHub enforced gate。               |

## 重要發現

### Capability 與 Configuration 必須分開

Rulesets endpoint 現在可用，只證明 O004 能建立規則；count=0 與 Branch Protection 404 代表 required merge gate 仍未配置。Registration 必須依序做：讀 capability → 產生差異預覽 → 使用者確認 → provision → GET read-back。任何一步缺失都維持 `setup_incomplete`。

### Commit Status 一定要二次 read-back

Status POST 成功只證明 API 接受請求；POST response 未提供可直接核對的 SHA。安全 Gate 必須再讀 combined status，確認：

1. combined SHA 等於目前 PR Head SHA；
2. context 精確等於 `agent-team/review`；
3. state 是 success；
4. Review Digest 與需求快照仍有效。

任何新 Push 都會換 Head SHA，舊 Status 不得沿用。

### 設定 mutation 一律 read-back

Private 時曾觀測 Auto-merge PATCH exit 0 但 read-back false；Public 後才真正變成 true。兩次結果共同證明 Process exit 0 不是狀態證據，設定型操作一定要 GET read-back，且 capability 條件改變後必須重驗舊 Fixture。

## 可重跑指令

```bash
node spikes/github/gh-probe.mjs repo
node spikes/github/gh-probe.mjs auto-merge
node spikes/github/gh-probe.mjs status <FULL_HEAD_SHA>
node spikes/github/gh-probe.mjs pr <PULL_NUMBER>
```

`auto-merge` 會連續執行兩輪相同的 Repo setting PATCH＋read-back，據此驗證冪等性；它不建立 Ruleset、不改 Branch Protection，也不合併 PR。Status mode 會寫入隔離 Head SHA 的 `agent-team/spike` context；不得對未知 SHA 執行。PR／SHA／帳號與 URL 不寫入共享 Fixture。

## A007／A008 採用邊界

1. Transport 可使用 `gh api`／REST／GraphQL，但 Domain 只接收去識別、型別化 capability 與 outcome。
2. Project Registration 在 required status／Ruleset／Auto-merge 三項 read-back 前維持 `setup_incomplete`；Rulesets API 可用不等於已 provision。
3. 單帳號 Reviewer 用結構化 Comment 表達 finding，再由 Controller 對已驗 Digest 的 Head SHA 寫 `agent-team/review` status；不得偽造 GitHub Approval。
4. Auto-merge setting 已啟用，但沒有 required Ruleset 前仍不能讓 Controller 直接排入 merge queue。
5. 所有 PR 與設定 mutation 後再 GET read-back；未知 check、缺 Head SHA、403、404、silent no-op 或 schema 漂移都 fail-closed。
