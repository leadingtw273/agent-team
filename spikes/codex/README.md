# S001：Codex CLI 可行性 Spike

## 裁決

Codex 可進入第一版 Provider 候選，但必須使用版本鎖定的雙介面：`codex exec --json` 負責簡單非互動 Job，`codex app-server --stdio` 負責登入、額度、Approval 與 Interrupt 控制。不得使用 `--dangerously-bypass-approvals-and-sandbox`。

| 能力              | 裁決                  | 證據與限制                                                                                                                                                                        |
| ----------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安裝與登入辨識    | Adopt                 | `codex-cli 0.146.0`；`codex login status` 與 app-server `account/read` 均確認 ChatGPT auth。Fixture 不保存 email、Token 或 Account ID。                                           |
| 非互動執行        | Adopt                 | `cli-probe.mjs exec` exit 0，JSONL 依序含 `thread.started`、`turn.started`、`item.completed`、`turn.completed`。stdin 明確設為 ignore，Session 使用 ephemeral。                   |
| 結構化輸出        | Adopt                 | JSONL Event 與 app-server JSON-RPC 可機械判讀；成功至少需要 process exit 0、`turn.completed` 與必要 Artifact。Agent 最後一句不能單獨當證據。                                      |
| OS 沙箱           | Adopt                 | Built-in `:read-only` profile 真執行 `touch` 得 exit 1／Read-only filesystem，檔案不存在。                                                                                        |
| 危險操作攔截      | Adopt with guardrails | app-server 在 `approvalPolicy=untrusted` 發出 `item/commandExecution/requestApproval`；控制端回 `decline` 後命令未執行。Agent Team 仍須先做固定危險類別判定，Sandbox 是最後防線。 |
| Signal／Interrupt | Adopt                 | 在真 `commandExecution(sleep 30)` 開始後呼叫 `turn/interrupt`，Turn 為 `interrupted`；同 Thread 下一 Turn 回 `INTERRUPT_RESUME_OK`。                                              |
| Checkpoint        | Degrade               | Codex Thread 可續作，但 Agent Team 必須另存自己的工作狀態、Git SHA、Diff 與下一步；不得把 Provider 內部 Thread 當唯一 Checkpoint。                                                |
| 週額度            | Adopt                 | `account/rateLimits/read` 回傳 `usedPercent`、`windowDurationMins=10080`、`resetsAt`，可綁定 limit ID。                                                                           |
| 5h 額度           | Degrade／fail-closed  | 本次真回應只有週窗口且 `secondary=null`。缺少 5h bucket 必須標「無法確認」，不可當成 0%；刷新一次仍缺就停止新的 Codex Job，等待使用者確認恢復或後續相容性更新。                   |
| 額度撞牆          | Adopt                 | app-server 有結構化 `UsageLimitExceeded` 錯誤類型；正在執行的 Job 進 Checkpoint，新 Job 不啟動。Synthetic fixture 只驗錯誤分類，不假稱實際耗盡帳號額度。                          |
| 版本漂移          | Guardrail             | app-server 在 CLI 仍標 experimental；每次 Codex CLI 更新必重新產生 protocol schema、跑本 Spike 與 Fixture Contract，再允許派工。                                                  |

## 重要發現：模型自述不是工具證據

一次反向 Probe 中，Agent 回覆「`touch` 被阻擋且 exit 1」，但 JSONL 完全沒有 `command_execution` Event。Marker 不存在只能證明沒有寫入，不能證明它真的呼叫過命令。`exec-unverified-self-report.json` 固化此案例；未來 Outcome 判斷必看 Event、Exit、檔案或 Git，而不是 Agent 敘事。

## 可重跑指令

先建立隔離 Git repo，路徑必須符合 `/tmp/agent-team-codex-probe.*`。Probe 不接受專案主 checkout，避免污染。

```bash
probe_dir="$(mktemp -d /tmp/agent-team-codex-probe.XXXXXX)"
git -C "$probe_dir" init -q

node spikes/codex/cli-probe.mjs exec "$probe_dir"
node spikes/codex/cli-probe.mjs sandbox "$probe_dir"
node spikes/codex/app-server-probe.mjs account
node spikes/codex/app-server-probe.mjs approval "$probe_dir"
node spikes/codex/app-server-probe.mjs interrupt "$probe_dir"
```

Account Probe 刻意讀目前已登入帳號做真能力測試，但 app-server Process 固定從 `/tmp` 啟動以隔離專案設定；輸出只保留 auth mode、plan type 與 rate-limit buckets，不輸出 email、Token、原始 account response 或 Thread ID。

## 採用邊界

1. R003 使用 app-server 控制面承接 Approval、Interrupt 與額度；若改用單純 `codex exec`，危險核可與 5h unknown 必須保持 fail-closed。
2. R007 不得以缺欄位、舊快取或 Agent 文字回覆推算額度；每筆樣本綁定 CLI 版本、limit ID、窗口與擷取時間。
3. R008 的「專案長期允許」由 Agent Team 保存固定危險類別；收到 app-server Approval 時仍要依當前專案、類別與命令摘要重新比對。
4. 任何 `turn.failed`、`UsageLimitExceeded`、缺 `turn.completed`、未知 Event 或 protocol schema 漂移都不是成功。

## 官方依據

- Codex CLI 非互動模式：`codex exec`、JSONL、ephemeral、sandbox 與 output schema。
- Codex App Server：`account/read`、`account/rateLimits/read`、`turn/interrupt`、Approval server request 與錯誤 taxonomy。
- Codex Permissions：built-in `:read-only`／`:workspace` profiles 與 approval policy。

以上依據於 2026-08-04 透過官方 Codex manual helper 更新並對照本機 `0.146.0` CLI help；若文件與實機不同，以實機 fail-closed 並重跑 Spike。
