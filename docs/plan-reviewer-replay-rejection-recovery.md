# Reviewer-replay 負評修正 MVP 實作計畫

1. 抽出既有 GitHub review evidence 的 strict parser，支援由 status target 精確讀取留言。
2. 為既有 `ReviewerRecoveryPipeline` 增加窄旗標：只略過已滿的 review counter，仍正常消耗一次 fixer counter。
3. `reviewer-replay --fix-rejected-review` 驗證同 Job／PR／Head／evidence 後，呼叫一次既有 fixer。
4. fixer push 後把 Job 接回 `ci_waiting`；既有 resume 在辨識此新 Head 後 fresh review 一次。
5. fresh review 通過沿用既有 merge/lifecycle；再次負評直接回需人工，不再 fixer。
6. 跑 targeted tests、typecheck、lint 與完整測試；再建立 PR、合併、部署並救回 LEA-139。

允許的 Tank live 修正只限 LEA-139 blocking finding 所需的 `scripts/quality.mjs`，不得處理 advisory 或另建 PR。
