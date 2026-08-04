# S002：Claude CLI 可行性 Spike

## 裁決

Claude Code CLI 可進入第一版 Provider 候選。非互動 Job 與唯讀 Reviewer 採 `claude -p --output-format stream-json`；每次必須使用 `--safe-mode`、明確工具清單與非互動權限模式。不得使用 `--dangerously-skip-permissions`。

| 能力                   | 裁決                      | 證據與限制                                                                                                                                                                                        |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安裝與 Team 帳號辨識   | Adopt                     | `claude auth status --json` 在 `2.1.221` 回傳已登入、first-party、Team subscription。Probe 只保存 allowlist，不保存 email、Organization ID／名稱或 Token。                                        |
| 非互動執行             | Adopt                     | Haiku 真 Probe exit 0，`stream-json` 含 assistant 與 result event，最終結果為 `CLAUDE_PROBE_OK`。stdin 固定關閉，無工具 Job 使用 `--tools ""` 與 `--no-session-persistence`。                     |
| 結構化成功判定         | Adopt                     | 成功至少要求 process exit 0、result event、`is_error=false`、沒有 permission denial，以及任務必要 Artifact。模型最後一句不能單獨當證據。                                                          |
| 唯讀 Review            | Adopt                     | 只開放 `Read` 的真 Probe 產生 `tool_use(Read)`／`tool_result`，目標 SHA-256 與 Git status 前後相同。Reviewer 不開放 Bash、Write、Edit。                                                           |
| 權限模式與危險操作攔截 | Adopt with guardrails     | `dontAsk` 真 Probe 確實發出 Bash tool event、permission denial，marker 未建立。注意 CLI 仍 exit 0 且 `is_error=false`；任何 denial 都必須優先分類為 blocked。                                     |
| 動態核可               | Degrade                   | 本版 CLI help 沒有穩定的非互動 permission callback 旗標。第一版遇 denial 後先 Checkpoint／結束 Turn；使用者在 Agent Team UI 核可固定危險類別後，以收窄的工具規則續開新 Turn，不得切 bypass mode。 |
| Signal／Interrupt      | Degrade                   | CLI 沒有等同 Codex app-server 的結構化 interrupt API。Controller 只能對精確 child PID 做期限／signal 管理，停止前後仍以外部 Checkpoint 為準。                                                     |
| Resume                 | Adopt                     | 持久化 Review session 的真 Probe 可用 `--resume` 開新 Turn，回傳 `CLAUDE_RESUME_OK`；Session ID 不得成為唯一工作狀態，也不得寫入共享 Fixture。                                                    |
| 週額度                 | Adopt                     | 真 `stream-json` 送出 `rate_limit_event`：`rateLimitType=seven_day`、`status=allowed_warning`、`utilization=0.93` 與 reset timestamp，可機械判讀。                                                |
| 5h 額度                | Degrade／fail-closed      | 本次結構化事件只有 seven-day；互動 `/status` 顯示 current session 5%，但 `/status` 在 print mode 明確不可用。沒有新鮮 5h event／可信手動刷新時必須標 unknown，不可當 0%。                         |
| 手動刷新               | Degrade                   | 互動 `/status` Usage tab 可顯示 current session／week，但它是 ANSI TUI 而非穩定 API。若 R007 提供 TUI 解析器，必須鎖 CLI 版本、保存原始資料於記憶體後只輸出 allowlist，格式漂移即 unknown。       |
| 額度撞牆               | Adopt with event evidence | `rate_limit_event` 是事件式訊號；warning／rejected 類狀態必須先於一般 result 判讀。沒有對應 bucket 時仍維持 unknown，不能從其他模型或本機貢獻比例推算。                                           |
| 版本漂移               | Guardrail                 | 每次 Claude CLI 更新都要重跑 auth、exec、review、permission、status 與 Fixture Contract，尤其檢查 event schema、permission denial 與 TUI 格式。                                                   |

## 重要發現

### Process exit 0 不代表工具已獲准

權限反向 Probe 的完整外層結果是 exit 0、`is_error=false`，但 stream 中同時存在 `tool_use(Bash)`、tool result 與 `permission_denials=[Bash]`，而 marker 不存在。Outcome 判定順序必須先看 denial，再看一般 result；否則會把「等待核可」誤判成功。

### 週額度有事件，5h 平時仍可能未知

互動 TUI 不是唯一訊號：模型 Turn 的 stream 會在接近週牆時提供結構化 `rate_limit_event`。這可直接支援 weekly warning；但本次沒有 five-hour event，所以不能假定同一 Turn 永遠能讀到兩個窗口。R007 必須按 bucket 各自維護 fresh／stale／unknown。

### 唯讀 Review 要驗事件與工作樹

Prompt 說「只讀」不構成邊界。第一版 Reviewer 必須同時收窄 `--tools Read`、使用 `dontAsk`、驗 `tool_use(Read)`，並在 Turn 後比對 Head SHA／Git status／目標 Artifact。`--safe-mode` 用來停用專案自訂指令、Hook、Plugin、MCP 與 CLAUDE.md，不取代工具權限。

## 可重跑指令

Probe 只接受 `/tmp/agent-team-claude-probe.*` 的隔離 Git Repo。先建立 `review-target.txt`，內容只能是一行 `CLAUDE_REVIEW_TARGET_V1`。

```bash
probe_dir="$(mktemp -d /tmp/agent-team-claude-probe.XXXXXX)"
git -C "$probe_dir" init -q
printf '%s\n' CLAUDE_REVIEW_TARGET_V1 > "$probe_dir/review-target.txt"

node spikes/claude/cli-probe.mjs auth
node spikes/claude/cli-probe.mjs exec "$probe_dir"
node spikes/claude/cli-probe.mjs review-resume "$probe_dir"
node spikes/claude/cli-probe.mjs permission "$probe_dir"
node spikes/claude/cli-probe.mjs status "$probe_dir"
```

Probe 輸出已做 allowlist projection，不輸出 session、message、帳號或 Organization 識別資料。`review-resume` 會在本機 Claude session store 建立可續作 session；共享 Fixture 不保存 ID。

## R004／R007 採用邊界

1. R004 的一般 Job、Reviewer、恢復 Turn 必須使用不同的工具 allowlist；不得把 Implementer 的工具集合帶入 Reviewer。
2. 任一 permission denial、未知 event、缺 result、`is_error=true`、逾時或非零 exit 都不是成功。
3. R007 逐 bucket 保存 Provider、CLI 版本、帳號指紋、窗口、擷取時間與 provenance；本 Fixture 不保存真帳號指紋。
4. 週額度可採結構化 event；5h 缺 event 時保持 unknown。TUI parser 只能作版本鎖定的手動刷新降級路徑。
5. Stop／Resume 不能取代 Agent Team Checkpoint：Git SHA、有效 Diff、已完成步驟、剩餘工作與下一個安全點仍由 Controller 保存。

## 官方介面依據

- Claude Code CLI reference：<https://docs.anthropic.com/en/docs/claude-code/cli-usage>
- Claude Code subscription usage 說明：<https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan>

官方文件用來確認 CLI 旗標意圖；能力裁決以本機 `2.1.221` 的真 Probe 為準，遇版本差異一律 fail-closed。
