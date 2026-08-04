# S005：GitHub／gh 可行性 Spike

S005 使用本變更自己的隔離 Branch／Draft PR 驗證 GitHub 能力；完成後本檔會保存最終 Adopt／Degrade／Block 裁決。所有 Fixture 都只保存 allowlist，不保存 gh Token、帳號 login、Node ID 或完整 URL。

目前已確認：對 private Repo 有 admin 權限，但 Rulesets 與 Branch Protection API 都回 `requires_paid_plan_or_public_repo`，且 `allow_auto_merge=false`。因此在目前方案下不能宣稱 GitHub 已強制 required commit status；仍會繼續驗 Draft PR、Checks、Commit Status、同帳號限制與 auto-merge 行為。
