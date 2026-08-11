# T02A：Codex／Claude 額度能力重驗

日期：2026-08-11  
基準：`main@441a76b`  
結論：**目前兩個 Provider 都不具備可投入 production admission 的完整額度訊號；新工作必須 fail-closed。**

## 1. 本次裁決

Agent Team 目前已具備額度樣本格式、三態政策與 parser，但沒有 concrete `QuotaPort`，也沒有 durable production collector。CLI 可執行、已登入或 `--version` 成功都不等於 quota-ready。

T03A 必須在 `admission.claim`、lease 與 Job 建立前檢查額度。任一候選 Provider 缺少同帳號、同 CLI 版本、未過期的週額度與短窗額度時，回傳 `quota_unknown`；不得建立 Job、取得 lease 或啟動 Provider。

## 2. 去敏能力矩陣

| 能力 | Codex | Claude Code | Production 判定 |
|---|---|---|---|
| CLI／登入 | `codex-cli 0.146.0`；ChatGPT auth 已登入 | `2.1.223`；first-party Team 已登入 | 只證明 CLI 與登入狀態，不證明額度可用 |
| 帳號 identity | 本次無穩定 runtime fingerprint | 本次無穩定 runtime fingerprint | `providers.json.account` 只是 operator label，不得當驗證身份 |
| 週額度 | App Server 有唯讀 `account/rateLimits/read`；本次 probe 被 sandbox launcher 的 PATH alias 寫入限制阻斷，未取得 fresh JSON | `/status` print probe 沒有 quota event 或 reset timestamp | `unknown` |
| 5h／短窗 | 舊 fixture 的 secondary 為 `null`；本次未取得 fresh sample | 本次沒有 five-hour event | `unknown`；不得以 0% 或週額度代替 |
| freshness | domain contract 可保存 source、observedAt、CLI version、account fingerprint | 同左 | 只有純函式；沒有 production sample collector |
| 帳號切換 | policy 可因 fingerprint mismatch 失效 | 同左 | 缺可信 production identity source |
| 手動 reset | 不得把 reset-credit mutation 當 refresh | 無安全結構化 reset collector | 現有 local reset 只標 stale；不得自動消耗 reset credit |

## 3. 可重現的去敏證據

- `codex --version`：`0.146.0`。
- `codex app-server --help`：本機仍標示 experimental。
- `codex login status`：exit 0；只記錄 ChatGPT auth，不保存帳號或 token。
- Codex `account/read`／`account/rateLimits/read` safe probe：exit 1、無 JSON；原因是唯讀 sandbox 不允許 launcher 建立 PATH alias，不能推論帳號沒有額度。
- `claude --version`：`2.1.223`。
- `claude auth status --json`：exit 0；只記錄 Team／first-party／已登入，不保存 identity 或憑證。
- Claude print `/status`：exit 0；3 個結構化事件、0 quota event、0 reset timestamp，原始文字未保存。
- 聚焦測試：

  ```text
  pnpm exec vitest run \
    tests/unit/quota-policy.test.ts \
    tests/unit/dispatch-claude-observation.test.ts \
    tests/contract/codex-spike.test.ts \
    tests/contract/claude-spike.test.ts

  4 files passed / 30 tests passed
  ```

## 4. 現有程式邊界

- `src/application/ports/quota.ts`：樣本 contract 已包含 CLI version、source 與 `observedAt`。
- `src/application/quota/policy.ts`：新工作需要 weekly 與 five-hour 都 confirmed；CLI、帳號或 freshness 不符會失效。
- `src/application/quota/parsers.ts`：Codex 缺 bucket 即 unknown；Claude 只有收到 `rate_limit_event` 才能建立 bucket。
- `src/cli/dispatch/claude-observation.ts`：production observation 目前只執行 `claude --version`，刻意不產生 quota ready。
- `src/cli/dispatch/composition.ts`：目前 route decision 前會先 `admission.claim`，因此在 Dispatcher 內加 gate 已經太晚。
- `src/cli/dispatch/provider-config-store.ts`：production provider config 目前只有 Claude／Gemini，尚無 Codex composition。

## 5. T03A 最小實作約束

1. pre-admission gate 必須位於任何 `admission.claim` 之前。
2. 每個候選 Provider、每次 admission 最多 refresh 一次；仍缺任一必要 bucket 就停止該候選。
3. identity 必須來自 Provider 的去敏 opaque fingerprint；禁止用 operator label 冒充。
4. CLI 版變更、帳號切換、未來時間、過期、格式漂移與未知 window 都回 unknown。
5. Codex collector 可採官方唯讀 `account/rateLimits/read`；未取得可驗證 fresh sample 前維持 unknown。
6. Claude 沒有 fresh structured five-hour event 時維持 unknown，不為 Sandbox happy path 放寬。
7. 不接自動 reset-credit mutation；本地「手動重置」只讓舊 sample stale。

## 6. T03A 必要驗收

- unknown、stale、CLI mismatch、account mismatch、只有週額度、只有短窗、refresh error：`0 admission.claim`、`0 lease`、`0 Job`、`0 provider start`。
- 有效雙 bucket 才能 claim，且每候選最多 refresh 一次。
- account switch 先失效再刷新，不沿用舊 sample、不顯示 raw identity。
- Codex `secondary=null`、未知 window、非 JSON／protocol drift 都是 unknown。
- Claude 無 event、只有 weekly event、rejected five-hour event 都維持 fail-closed。
- production composition 不得因 `claude --version` 成功而回 ready。
- 不得出現自動 reset-credit consume 呼叫。

## 7. 已知未知

- 本次沒有取得 Codex App Server 的 fresh rate-limit JSON，因此不能宣稱 Codex production collector 已驗證。
- Claude Code 本次沒有提供可採信的 5h 結構化訊號，因此 Claude 不能單獨通過新 Job admission。
- 第一輪 Sandbox 若兩個 Provider 都維持 unknown，T10 preflight 應誠實阻塞；後續可透過可信的人工刷新／注入測試訊號完成受控 canary，但不得把 fixture 當真實 production 額度。

官方參考：Codex App Server API 的 `account/read`、`account/rateLimits/read` 與 `account/rateLimits/updated`；reset-credit consume 是 mutation，必須與唯讀 refresh 分離。
