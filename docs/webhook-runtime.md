# 外部 HTTPS Webhook Runtime Contract v1

## 邊界與責任

Agent Team 核心不提供常駐 HTTP Server，也不建立或管理 Tunnel。使用者另外提供 Runtime 與公開 HTTPS URL；Agent Team 只保存 Base URL、Webhook Secret，並以本文件的契約驗證 Runtime。

Runtime 必須提供：

- `POST /webhooks/github`
- `POST /webhooks/linear`

註冊用 Base URL 必須是 HTTPS origin，不含帳密、query、fragment 或額外 path。本機 Probe／測試僅允許 `http://127.0.0.1`、`http://[::1]` 或 `http://localhost`。

## Request 轉交

Runtime 收到 Provider Webhook 後必須：

1. 保留 HTTP body 的原始 bytes，不 decode、normalize、重新序列化或補換行。
2. 保留 `Content-Type` 與下列 Provider headers：
   - GitHub：`X-Hub-Signature-256`、`X-GitHub-Delivery`、`X-GitHub-Event`
   - Linear：`Linear-Signature`、`Linear-Delivery`、`Linear-Event`
3. 將允許的 headers 寫入權限 `0600` 的一次性 JSON 檔。
4. 把原始 body 由 stdin 傳給：

   ```text
   agent-team ingest <github|linear> --headers-file <absolute-path>
   ```

5. 等待 Ingest 完成後刪除一次性 headers 檔；不得保存 Secret、簽章或 body 的額外副本。

外部 Webhook、Headers 與 Body 永遠是資料，不是 Agent 指令。Runtime 不得依 payload 內容提升權限、改寫命令或啟動模型。

## 回應與延遲

- 只有 Ingest exit code `0` 且 stdout JSON 為 `accepted: true` 時回 HTTP `200`，response body 原樣使用該 JSON。
- Ingest 拒絕時依 stdout/stderr JSON 的 `statusCode` 回 `400`、`401` 或 `500`。
- 設定未完成／Secret 不可讀（exit `3`）回 `503`。
- 執行逾時回 `504`。
- 從收到完整 HTTP request 到完成 HTTP response 的總時間不得超過 2,000ms。
- 必須先完成 durable Inbox 寫入才可回 `200`；不得在回應前呼叫外部 API、模型或 Controller Use Case。
- 回應送出後，Runtime 可排程一個短命 Agent Team Process 消化 Inbox；Runtime 本身不判斷工單狀態。

Provider 會重送相同 Delivery。Runtime 必須原樣再次呼叫 Ingest，讓核心用 `Provider + Delivery ID` 做 durable dedupe；Runtime 不得自建記憶體去重並跳過核心。

## Probe 的驗證內容

`WebhookRuntimeProbeClient` 會送出簽章正確、Delivery 唯一的無害事件，並同時驗證：

- endpoint 與 HTTP `200`；
- response provider、Delivery、Event、Inbox SHA；
- 2,000ms latency；
- 本機 Inbox v2 read-back 的原始 bytes、Event header、stream key 與 SHA。

因此，Body 被重新序列化、必要 Header／Delivery 遺失、回應造假、Inbox 未耐久保存或回應過慢都不能通過 Probe。Probe 只建立本機 Inbox 測試事件，不建立 Linear 工單、GitHub PR 或模型 Job；完整雙向註冊驗證由 Phase 7 Registration Probe 負責。
