# T04 systemd 隔離喚醒 Live Proof（2026-08-11）

狀態：PASS（Roadmap 定義的「五分鐘內喚醒並誠實阻塞」）  
基準：`main@32e2a4b2f63da6d5e40a5b196ee894e50ba44cfc`  
Canary units：`agent-team-t04-wfznbarz.service`／`agent-team-t04-wfznbarz.timer`  
隔離狀態：`/tmp/agent-team-t04-live-wfzNBArZ/home`

## 驗證邊界

本輪只驗證 production `SystemdManager`、真實 `systemd --user` timer、production durable
Job／Lease／Progress stores，以及 production `reconcile --all`。Canary 故意不建立 registration
draft，因此 composition 在建立 Linear、GitHub 或模型 adapter 前即 fail closed。

本輪沒有呼叫 Linear／GitHub API，沒有啟動 Claude、Codex 或 Gemini，也沒有建立新 Job、PR 或留言。
它不宣稱 `implementing` 階段的 provider process 已可自動恢復；目前該階段仍會誠實阻塞，且
`process_inspect`／`process_resume` 仍列在 CLI 的 `unwiredCapabilities`。

## 安全基線

安裝前四個 unit 都是 `LoadState=not-found`、`ActiveState=inactive`：

- canonical：`agent-team-reconcile.service`／`.timer`
- canary：`agent-team-t04-wfznbarz.service`／`.timer`

`pgrep -af 'agent-team-t04-wfznbarz|agent-team-reconcile|dist/cli/index.js'` 只命中當次檢查
shell，沒有既有 Agent Team process。Canary 使用真 user unit directory 與唯一 unit 名稱；沒有把
isolated `XDG_CONFIG_HOME` 誤當成獨立 systemd namespace。

## 空狀態首發

production manager 安裝成功：

```json
{"operation":"install","state":"installed","timer":"agent-team-t04-wfznbarz.timer"}
```

timer 於 `2026-08-11 15:09:45 CST` 自動首發；journal 的 CLI payload 為：

```json
{"operation":"manual_reconcile","state":"completed","evidenceCode":"manual_reconcile_completed","reclaimedLeaseCount":0,"jobProgressCounts":{"resumable":0,"blocked":0,"terminal":0,"total":0},"modelResumeAttempts":0}
```

這先證明 unit 可執行 production CLI，並排除 fixture 建立與首次 timer 啟用互相競跑。

## Fixture read-back

fixture 只透過 production `FileJobRepository`、`FileLeaseRepository`＋`LeaseCoordinator`、
`FileJobProgressStore` 建立，沒有手寫 store JSON：

- Job：`job_c37a62fc-a971-461d-9ea0-7f1785299f0b`
- Project：`project_51315a74-faf4-4ba7-a390-eb55f9291488`
- Lease：`lease_21002cd6-4461-416b-9e02-0a317c908e4f`
- Progress：`revision=0`、`stage.kind=ci_waiting`
- Lease：`acquiredAt=2020-01-01T00:00:00.000Z`、`expiresAt=2020-01-01T00:01:00.000Z`、
  尚無 `releasedAt`
- registration draft：不存在

建立 harness 最後的 cardinality assertion 曾把 production store 留下的 `.json.lock` 一併計數而
非零退出；正式 Job／Lease／Progress 都已在該 assertion 前成功 read-back。現場沒有重跑 fixture，
並另外以 JSON 內容、ID 關聯與 `*.json` 數量確認資料恰好各一筆。

觸發前 SHA-256：

- `jobs.json`：`bee9abd1c2efed2b4652bba8aadf99b74f0fbfbd910524c3bb4ed5974b682873`
- `leases.json`：`ed02fe939670d848d66facd820efa0f1a0c20e552e1c761280a75aa065e4e0e6`
- progress：`78b34af78869a4f3bb67872fde2e12cbd997aa9c576048b0866f5505ca3ee5bc`

## 第一個五分鐘 tick

timer 排定 `15:14:47`，systemd 於 `2026-08-11 15:14:49 CST` 自動啟動 service：

```json
{"operation":"manual_reconcile","state":"degraded","evidenceCode":"manual_reconcile_degraded","reclaimedLeaseCount":1,"targetCounts":{"healthy":0,"resumed":0,"blocked":0,"failed":0},"jobProgressCounts":{"resumable":1,"blocked":0,"terminal":0,"total":1},"jobProgressResume":{"outcomes":[],"blocked":[{"projectId":"project_51315a74-faf4-4ba7-a390-eb55f9291488","jobId":"job_c37a62fc-a971-461d-9ea0-7f1785299f0b","reason":"dispatch_composition:draft_unavailable"}]},"jobProgressBlocked":[],"modelResumeAttempts":0}
```

service 以 exit code 3 結束並顯示 failed，符合 CLI 對 degraded／blocked 的既有 exit contract；本輪
PASS 依據是固定 evidence code 與 durable read-back，不把 service 綠燈當成功證據。

觸發後 Job 與 Progress SHA 完全不變；Lease 仍只有同一筆，只新增
`releasedAt=2026-08-11T07:14:49.908Z`，SHA 變為
`6633a6f5036594e6cf89f3f4542c2101a2d0838755ef99e031c6cb342735e7ef`。

## 第二個五分鐘 tick（冪等重播）

前一輪 service 為 failed 後，timer 仍排定下一次執行，並於
`2026-08-11 15:19:54 CST` 再次自動啟動：

```json
{"operation":"manual_reconcile","state":"degraded","evidenceCode":"manual_reconcile_degraded","reclaimedLeaseCount":0,"jobProgressCounts":{"resumable":1,"blocked":0,"terminal":0,"total":1},"jobProgressResume":{"outcomes":[],"blocked":[{"projectId":"project_51315a74-faf4-4ba7-a390-eb55f9291488","jobId":"job_c37a62fc-a971-461d-9ea0-7f1785299f0b","reason":"dispatch_composition:draft_unavailable"}]},"jobProgressBlocked":[],"modelResumeAttempts":0}
```

第二輪沒有重複回收 Lease、沒有新 Job、沒有 Progress revision 變化，也沒有模型 resume。

## 清理 read-back

production manager 回傳：

```json
{"operation":"uninstall","state":"uninstalled"}
```

卸載後 custom unit 檔案不存在；再對唯一 canary service 執行 `reset-failed` 清除 systemd 記憶狀態。
最終 custom 與 canonical 四個 units 全部為 `LoadState=not-found`、`ActiveState=inactive`、
`SubState=dead`；兩個 service 的 `MainPID=0`、`ExecMainPID=0`，timer 類型不提供這兩個
property。相關 `pgrep` 仍只命中檢查 shell。

隔離 home 暫留在 `/tmp` 供 PR 驗收期間 read-back，不屬於 production runtime 狀態。

## Code gate

- `systemd-installer.test.ts`：48/48 PASS
- `systemd-template.test.ts`：sandbox 因 `spawnSync EPERM` 無法執行；sandbox 外同命令 3/3 PASS
- `typecheck`／`lint`／`format:check`／`git diff --check`：PASS
- fresh-context 高風險驗收第一輪抓到空 stem／leading dot／`..` 漏驗；修補後 focused
  revalidation：PASS

## T04 判定

Roadmap T04 的窄出口「timer 五分鐘內復航專屬 canary或誠實阻塞」已由真 user timer 證明。
後續第一輪 Sandbox happy path 可以繼續；provider 正在 `implementing` 時的 process-level crash recovery
仍是明列能力缺口，不得把本證據擴張解讀為該能力已完成。
