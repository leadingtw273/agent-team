# S006：GitHub／Linear Webhook Ingest Spike

## 裁決

Webhook 驗證、Delivery 去重、亂序保存與快速 ACK 合約可採用，而且不需要把 HTTP Server 或 Tunnel 放進 Agent Team 核心。外部 HTTPS Runtime 負責收 Raw Body／Headers，呼叫核心 verifier 並在 durable Inbox 成功後回 200；後續 Projection／Dispatcher 非同步處理。

| 能力                      | 裁決                 | 證據與限制                                                                                                                                                                  |
| ------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Raw Body Signature | Adopt                | Node Probe 對官方 HMAC-SHA256 測試向量完全吻合；`X-Hub-Signature-256` 必須含 `sha256=`，使用 `timingSafeEqual`。多一個換行、缺 prefix、非 hex 都拒絕。                      |
| Linear Raw Body Signature | Adopt                | `Linear-Signature` 是 raw bytes 的 hex HMAC-SHA256；同一 JSON 重新排版／加空白會讓原簽章失效。驗簽前不得經 body parser 或 JSON stringify。                                  |
| 驗簽後 JSON Parse         | Adopt fail-closed    | 有效簽章但 JSON 壞掉分類 `invalid_json`；不會在驗簽前 parse，也不把 parser exception 當 500 無限重試。                                                                      |
| Delivery ID               | Adopt                | GitHub 使用 `X-GitHub-Delivery`，Linear 使用 `Linear-Delivery`；缺失即拒絕。Dedupe key 必須含 Provider，避免跨來源 UUID 碰撞。                                              |
| Linear Replay Window      | Adopt                | 驗簽後讀 body `webhookTimestamp`，與接收時間相差超過 60,000ms 即 `stale_timestamp`。Clock 可注入，不能直接散落 `Date.now()`。                                               |
| Duplicate                 | Adopt                | 相同 Provider＋Delivery 只保存一次；重送回 200，避免 Provider 繼續 retry，但不重跑副作用。                                                                                  |
| Out-of-order              | Adopt                | 新 Delivery 即使 timestamp 較舊仍寫 Inbox，標 `accepted_out_of_order`；不得直接回寫 Projection，由 replay 依因果／權威 read-back 收斂。                                     |
| 快速 ACK                  | Adopt                | 1000 次本機驗簽＋Envelope benchmark 的 p95 在 1ms bucket；內部目標 100ms。這不是外部網路 SLA，只證明核心 hot path 足夠小。                                                  |
| Provider Timeout          | Adopt async boundary | Linear 超過 5 秒會視為失敗並重試。核心要求 durable Inbox 先於 HTTP 200，模型／GraphQL／Git／Projection 都在 ACK 後跑；6 秒後處理失敗不依賴 Provider 重送，從 Inbox replay。 |
| HTTP Runtime／Tunnel      | Out of scope         | 第一版只定 verifier／Envelope／Inbox 合約與 URL 設定。外部 Runtime 如何取得 HTTPS URL、綁哪個框架／Tunnel，Agent Team 不知道也不管理。                                      |
| Secret                    | Guardrail            | Secret 只由 Runtime 注入，Fixture／Log／Linear 留言不得保存；錯誤只回 normalized reason。                                                                                   |

## 驗證順序

```text
Raw bytes + normalized headers
  → 必填 Signature／Delivery／Event header
  → HMAC timing-safe verify
  → JSON parse
  → Linear timestamp window（GitHub 無相同欄位）
  → Provider:Delivery dedupe
  → 原子寫 durable Inbox
  → HTTP 200
  → 非同步 ordered replay／Projection／Dispatcher
```

順序不可交換。尤其不能先 JSON parse 再 stringify 驗簽，也不能等 Linear／GitHub API read-back 或模型工作完成才 ACK。

## HTTP 狀態映射

| 分類                                      | 建議 HTTP | 行為                                     |
| ----------------------------------------- | --------- | ---------------------------------------- |
| `invalid_signature`／`stale_timestamp`    | 401       | 不落 Inbox、不洩漏驗證細節               |
| `missing_required_header`／`invalid_json` | 400       | 不落 Inbox，留下遮罩後診斷 counter       |
| `duplicate`                               | 200       | 不重複保存／投影，終止 Provider retry    |
| `accepted`／`accepted_out_of_order`       | 200       | durable Inbox 成功才回；處理在 ACK 後    |
| Inbox 無法 durable write                  | 500       | 不回假 200，讓 Provider 依自身策略 retry |

## 可重跑指令

```bash
node spikes/webhook/probe.mjs github
node spikes/webhook/probe.mjs linear
node spikes/webhook/probe.mjs ordering
node spikes/webhook/probe.mjs latency
node spikes/webhook/probe.mjs timeout
```

Probe 使用官方 GitHub test vector 與 synthetic Linear payload；輸出只含 boolean／normalized reason／performance bucket，不輸出 Secret、Signature、Raw Body 或 Delivery ID。

## A009／S007 採用邊界

1. HTTP framework adapter 必須把未修改的 bytes 傳給 verifier；若 Runtime 只給 parsed JSON，Registration 驗證直接失敗。
2. Header lookup 大小寫不敏感，但轉成核心輸入前只保留白名單欄位。
3. Delivery dedupe 是 durable Inbox 的 unique constraint／原子鎖，不可只用程序記憶體 Set；本 Spike 的 Set 只驗狀態語意。
4. Out-of-order 不等於丟棄；先保存，再由 A010 Reconcile／Event replay 對權威服務收斂。
5. ACK latency 只包含驗簽、最小 parse、dedupe 與 durable append；任何外部 API／模型呼叫都禁止進 hot path。

## 官方介面依據

- GitHub webhook 簽章驗證：<https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries>
- Linear webhook headers、簽章、timestamp 與 retry：<https://linear.app/developers/webhooks>

官方文件用來固定 Header、HMAC、timestamp 與 5 秒 retry 邊界；Fixture 只保存去識別的本機可重跑結果。
