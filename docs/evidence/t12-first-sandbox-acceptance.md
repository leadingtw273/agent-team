# T12：第一輪 Sandbox Fresh-Context 驗收

狀態：**PASS**  
日期：2026-08-12  
驗收方式：全新 Claude CLI context，只讀 merged T11 artifact 與 Roadmap PASS 條件；未提供實作過程，禁止執行與修改。  
主要證據：[`t11-first-sandbox-internal-canary.json`](t11-first-sandbox-internal-canary.json)

## 通過理由

- Linear、GitHub、本機 durable state、Git 四個權威來源皆為 `present`。
- Cardinality 為一張 Issue、一個 Job、一個 PR；三個生命週期事件各出現一次。
- 時序為 dispatch → merge → Linear completed → local Job completed，全部落在 capture window 內。
- CI、Review Status、Reviewer、Merge 與 Git effective diff 全部綁定同一個去敏 Head Digest。
- Reviewer Diff Digest 與 Git Effective Diff Digest 完全相同。
- Job 已完成；non-terminal、resumable、blocked、active lease、expired lease 全部為 0。
- Artifact 只有 alias 與 digest，不含 raw Linear／Job／Git ID、URL、repo 名稱、本機路徑或確認字串。
- T09 validator／writer 測試矩陣 8 files／26 tests 通過，artifact 可從檔案重新 replay 為 PASS。

## 非阻塞限制

這些限制不推翻本次 internal canary，但不能被誤說成「v1 所有情境完成」：

1. Artifact 將 CI／Review／Merge 綁到同一 Head，但 CI 與 Review 欄位未保存明確完成時間；本次另由 GitHub live read-back 確認順序。
2. Artifact 沒有保存留言 cardinality；本次 Linear 與 GitHub 留言已另行 read-back，下一版 evidence schema 應直接承載。
3. Reviewer requirements digest 尚無第二個 authority digest 對照點。
4. 去敏後 artifact 本身不揭露 repo 身分；Sandbox 身分由 capture runner 與 GitHub live read-back 確認。
5. 第一輪使用者是否真的只與團隊管理者對話，必須由 T13 使用者親測關閉。
6. UI 是否容易理解不屬於 artifact schema；T13 前另以 production localhost UI smoke 驗證頁面可讀且 axe violation=0。

## 裁決

T11 internal canary 與 T12 fresh acceptance 已關閉。可以進入 T13 使用者第一輪測試；測試範圍限安全、小型、代碼審查型 Happy Path。

