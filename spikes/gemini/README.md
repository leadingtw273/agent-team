# S003：Gemini CLI 可行性 Spike

## 裁決

Gemini CLI 可進入第一版「視覺審查者」候選，但不能進 Implementer／整合工程師候選。視覺 Job 使用 `--output-format json`、`--approval-mode plan` 與額外的 supplemental admin policy；不得使用 `--yolo`。第一版只維護 available／unavailable，不推算 Provider 額度。

| 能力               | 裁決                         | 證據與限制                                                                                                                                                                                        |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安裝與可用性       | Adopt                        | 本機 `0.52.0` 真 headless Probe 成功呼叫已登入 Provider，stream result 為 success 且回 `GEMINI_PROBE_OK`。CLI 沒有可採用的結構化 auth status；成功 Probe 只證明當下 available，不保存帳號身分。   |
| 非互動執行         | Adopt                        | `-p` 與 JSON／stream-json 都能機械判讀。錯誤路徑仍要同時看 process exit、top-level error、tool stats 與必要 Artifact。                                                                            |
| 視覺輸入           | Adopt                        | 真 `read_file` 讀取去識別 96×96 PNG；JSON stats 顯示一次成功 tool call、檔案增刪為 0，回答正確辨識左上紅色與右下藍色。                                                                            |
| 視覺輸出格式       | Adopt JSON／Block stream     | `0.52.0` 的 stream-json 在 tool call 後曾只輸出 `.`、`jpeg` 等截斷 chunk，卻仍 result success；同請求 JSON 模式提供完整 response 與 tool stats。R005 的視覺路徑不得用 stream message 當完成證據。 |
| 模型選擇           | Degrade                      | Probe 以 `model=auto` 啟動，實際 JSON stats 為 `gemini-3.1-pro-preview-customtools`。R005 必須保存實際 model；若角色配置指定模型，需另跑該型號 Probe，不能把 auto 的結果套用。                    |
| 唯讀安全           | Adopt with admin policy      | `--approval-mode plan` 自身仍允許 plans 目錄寫入，不能單獨當沙箱。Probe 額外傳 `--admin-policy read-only-review.toml`：只 allow `read_file/read_many_files`，其餘工具 deny。                      |
| Headless 核可      | Adopt fail-closed            | supplemental policy 把 `write_file` 設為 `ask_user`；headless 真 Probe 的 tool stats 為 fail=1、marker 不存在。注意外層仍 exit 0 且沒有 top-level error。                                         |
| 動態危險操作       | Not applicable for v1        | Gemini 第一版只做視覺 Reviewer，不執行寫入／Shell。若未來要升級角色能力，必須另做 Implementer Spike，不能沿用本裁決。                                                                             |
| SIGTERM            | Block as graceful interrupt  | 精確 PID 真 Probe 中 `child.kill(SIGTERM)` 成功送出，但 CLI 繼續完成 Turn；SIGTERM 不能當可靠中斷或 Checkpoint。                                                                                  |
| SIGKILL escalation | Adopt with data loss warning | 重新 `pgrep -af` 核對同 PID 後，SIGKILL 才得到 signal exit 且沒有 result event。Controller 可用於硬期限，但必須先保存外部 Checkpoint；Provider session 不構成恢復保證。                           |
| Unavailable 判定   | Adopt                        | 刻意不存在的模型得到 exit 1、stderr present、無 response／model／tool；不得因缺 structured error 就重試成成功。                                                                                   |
| 額度               | v1 僅 available／unavailable | JSON stats 是單次請求用量，不是帳號週額度。依需求，Gemini 第一版只使用使用者配置的本機週牆與 availability；不可拿 token stats 猜剩餘帳號額度。                                                    |
| 版本漂移           | Guardrail                    | 每次 Gemini CLI 更新都重跑 exec、visual JSON、visual stream negative、permission、unavailable 與 signal；Policy／JSON schema／auto model 任一漂移即 fail-closed。                                 |

## 重要發現

### Plan Mode 不是完整唯讀沙箱

Plan Mode 的設計允許把 planning artifact 寫到 plans 目錄。Agent Team 的視覺 Reviewer 因此再疊一層 supplemental admin policy，以最高優先規則只 allow 兩個讀檔工具，其他 built-in、MCP、Web、Shell、write／replace、exit-plan 全部 deny。當前主機沒有標準 `/etc/gemini-cli/policies/*.toml`，所以 supplemental admin policy 實際生效；若未來出現標準 admin policy，Registration／Doctor 必須重新 Probe，不可假設疊加順序。

### Gemini 的 success 需要四層證據

1. process exit 必須符合模式預期；
2. JSON 不得有 top-level error；
3. 必要 tool stats 必須 success，任何 fail 優先轉 blocked／failed；
4. 視覺語意與 Artifact／檔案增刪證據必須符合 AC。

只看 exit 0 會同時誤判 headless permission denial 與截斷 stream；只看模型文字也無法證明它真的讀了圖片。

### SIGTERM 只能當通知，不能當停止保證

真 Probe 顯示 CLI 會攔截或延後處理 SIGTERM，仍可正常完成。R001 對 Gemini 的 deadline 流程必須是：先 Checkpoint → 精確 PID SIGTERM → 短 grace → 再列全量 process inventory、核對同 PID → SIGKILL。SIGKILL 後沒有 result event，該 Attempt 一律不是完成。

## 可重跑指令

Probe 只接受 `/tmp/agent-team-gemini-probe.*` 的隔離 Git Repo。測試圖片可用 ffmpeg 產生，不含真人、專案畫面或 Metadata。

```bash
probe_dir="$(mktemp -d /tmp/agent-team-gemini-probe.XXXXXX)"
git -C "$probe_dir" init -q
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=white:s=96x96:d=1 -vf drawbox=x=8:y=8:w=32:h=32:color=red:t=fill,drawbox=x=56:y=56:w=32:h=32:color=blue:t=fill -frames:v 1 "$probe_dir/visual-probe.png"

node spikes/gemini/cli-probe.mjs exec "$probe_dir"
node spikes/gemini/cli-probe.mjs visual "$probe_dir"
node spikes/gemini/cli-probe.mjs permission "$probe_dir"
node spikes/gemini/cli-probe.mjs unavailable "$probe_dir"
node spikes/gemini/cli-probe.mjs signal "$probe_dir"
```

`signal` 會先以 `pgrep -af` 全量列舉並核對精確 child PID；只在同 PID 仍存活時先送 SIGTERM、再於 grace 後重查並升級 SIGKILL。Fixture 不保存 PID 或完整 process inventory。

## R005 採用邊界

1. 只提供視覺 Reviewer 能力，工具 allowlist 固定為 `read_file/read_many_files`；角色配置不得把 Gemini 排進寫碼或整合模型順序。
2. 視覺 Job 使用 JSON 模式，保存實際 model、read tool stats、零檔案變更與 AC 語意證據；Provider response 的內部前綴須先正規化。
3. supplemental admin policy 是 Runtime 參數，不信任專案內 `.gemini/policies`；Registration／Doctor 必須真 Probe policy 是否生效。
4. 任一 tool fail、top-level error、非零 exit、缺 response、缺 read evidence、未知 model 或 schema 漂移都不是成功。
5. SIGKILL 後的 Attempt 一律 failed／checkpointed；不得用殘留 session 或模型自述補成完成。

## 官方介面依據

- Gemini CLI Headless mode：<https://geminicli.com/docs/cli/headless/>
- Gemini CLI Policy engine：<https://geminicli.com/docs/reference/policy-engine/>

官方文件用來確認 JSON／stream schema、exit code 與 headless `ask_user`→deny 語意；能力裁決仍以本機 `0.52.0` 真 Probe 為準。
