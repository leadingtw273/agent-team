# S004：Linear GraphQL 可行性 Spike

## 裁決

Linear Personal API Key、GraphQL read/write、Issue／Comment、Label Group、Issue Template 與檔案上傳可採用。正式專案註冊仍有一項明確前置：目前可見 1 個 Team、0 個 Project，因此 Controller 不得宣稱 Linear Project 已完成設定。

| 能力                 | 裁決                           | 真 Probe 證據與限制                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer／Workspace    | Adopt                          | HTTP 200、GraphQL 無錯誤；Fixture 只留可讀布林值，不保存使用者或 Workspace 身分。                                                                                                                                                                                            |
| Team／Canceled state | Adopt                          | 可見 Team 且具有 `canceled` workflow state；Probe Issue 最後轉取消，不永久刪除。                                                                                                                                                                                             |
| Project              | Adopt with prerequisite        | `projects` query 成功但結果為 0；Phase 7 註冊前仍須建立或選擇 Project。                                                                                                                                                                                                      |
| Issue／Comment       | Adopt                          | 真建立、讀回 Label／Comment，Comment 清除、Issue 轉取消均 read-back 成功。                                                                                                                                                                                                   |
| Label Group          | Adopt                          | `isGroup=true` 的 Group、帶 `parentId` 的子 Label 與 Issue 綁定均成功；子 Label 與 Group 最後刪除。                                                                                                                                                                          |
| Issue Template       | Adopt                          | `type=issue`、Team 綁定與 Template payload 成功；最後刪除。                                                                                                                                                                                                                  |
| File upload          | Adopt with cleanup degradation | 官方兩階段流程成功：取得 signed URL、複製回傳 headers 後 PUT 200、嵌入 Comment。`fileUploadDangerouslyDelete` 對目前帳號回 `FEATURE_NOT_ACCESSIBLE`。本次完整 Probe 的 Comment 已刪，但留下 1 個無引用的純文字 Asset；Fixture 明確保留 `uploadDeleted=false`，不宣稱已清除。 |

## 可重跑指令

Secret 預設只從 `~/.agent-team/secrets/linear-api-key` 讀取，並驗證一般檔案、目前使用者擁有及 mode 0600；輸出不含 Key、帳號、名稱、ID 或 URL。

```bash
node spikes/linear/graphql-probe.mjs inventory
node spikes/linear/graphql-probe.mjs roundtrip
```

`roundtrip` 的安全預設只驗 signed URL，不 PUT bytes，也不呼叫破壞性的 Asset delete mutation；這能重跑且不增加無法刪除的檔案內容。只有在隔離 Workspace 且明確接受殘留時，才使用：

```bash
node spikes/linear/graphql-probe.mjs roundtrip --with-upload
```

完整上傳模式的輸出名稱是 `roundtrip-with-upload`。因刪除能力不可用，它會誠實回 `success=false` 並以非零 exit 結束；這是 cleanup degradation 的證據，不是上傳失敗。

## 上傳邊界

Linear 官方流程是 `fileUpload` 取得 `uploadUrl`／`assetUrl`／headers，再由 Server 對 signed URL PUT；回傳 headers 必須完整複製。正式產品上傳的是 Linear 工單驗收證據，本來就需要持續存在，因此刪除 API 不可用不阻擋 A004；但 Registration Probe、測試與清理 UI 必須顯示此限制，不能自述已刪。

參考：

- [Linear GraphQL authentication](https://linear.app/developers/graphql)
- [Linear file upload guide](https://linear.app/developers/how-to-upload-a-file-to-linear)

## A001～A004 採用邊界

1. Key 只從專案外 0600 Secret 載入，不寫入 Repo、Fixture、Log 或 Linear Comment。
2. GraphQL HTTP 200 仍須檢查 `errors[]`；partial error 不得當成功。
3. 401、429 與 HTTP 200 partial error 有 synthetic Fixture 直接測分類器；所有 mutation 以 response `success` 加 query read-back 判定，不以 HTTP 或 Process exit code 單獨判定。
4. Project 數量為 0 時維持 `setup_incomplete`；不得自行把 Team 當 Project。
5. Label Group／Template provisioning 先做差異預覽，再以 ID 建立及 read-back；不依賴顯示名稱。
6. Upload 必須複製 signed headers；證據 Comment 建立失敗時不得通過視覺 Gate。
7. `FEATURE_NOT_ACCESSIBLE` 是 capability degradation，不得無限重試或假裝 Asset 已刪。
8. 每個網路請求有 15 秒 timeout；SIGINT／SIGTERM 會中止目前請求並進入精確 ID cleanup，而不是直接跳過 `finally`。
9. Team／Project／Workflow state 查詢會檢查 `hasNextPage`；截斷的 inventory 不能宣稱 capability 完整。
10. GraphQL introspection 只證明 mutation 存在，不證明目前 Key 可呼叫；`fileUploadDangerouslyDelete` 就是 schema present、access unavailable 的真實案例。
