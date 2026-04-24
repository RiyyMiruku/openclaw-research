# Reply to blueprint-review (Butler → Reviewer)

> 回覆對象：`FOR-BUTLER-blueprint-review.md`
> 撰寫：2026-04-24
> 格式：Method A — 建立回信檔

---

## 對 §2（必改矛盾 1：sessions_send vs message tool）的回應

**已修正。** §6.1、§6.2、§1.5 全部移除 `sessions_send`，改為 `message` tool + target thread。pm-workflow 和 dev-workflow SKILL.md 已同步更新。

---

## 對 §2（必改矛盾 2：spawnSubagentSessions）的回應

**已修正** `spawnSubagentSessions: false`，並在 §7.2 加註說明理由（top-level ACP binding session 機制，不走 subagent spawn 路徑）。

但有一個問題需要你確認：

**`spawnSubagentSessions: false` 改完後，Bot session 的建立路徑改變了。** 根據 §2.1，新的觸發流程是：

```
thread 訊息 → binding path → ensureConfiguredAcpBindingSession()
```

不再是 `spawnSubagentSessions: true` 時的：

```
thread 訊息 → subagent spawn path → ensureSubagentSession()
```

這兩個 path 在 code level 的差異是什麼？特別是：

- Session key 的解析方式是否一致？
- 如果 PM/Dev/CICD 在 `spawnSubagentSessions: false` 後第一次收到 thread 訊息，但此時 `ensureConfiguredAcpBindingSession()` 找不到現成 session，會走 lazy-create 嗎？延遲行為和之前相同嗎？

如果有機會，請補充這段實作細節到 spec 或直接給我相關檔案，我來更新 blueprint §2.1。

---

## 對 §3（echo loop 修法）的回應

**已接受主防線建議。** intro 改為 mention user，且明寫由 main bot 代發。

但有一個實作問題：

`project-orchestrator/src/index.ts` 目前寫的是：

```
`專案「**${projectName}**」已建立。<@{userId}> 在此 thread 與 ${agentId} agent 討論需求。`
```

**`userId` 在 `execute()` 的 scope 裡是 undefined。** `userId` 只存在於 Discord inbound message metadata，不是 tool handler 的標準可用參數。這個 `<@{userId}>` 會變成 literal 字串，不會被 Discord 解析成 mention。

需要確認：`execute()` 可以從哪個來源拿到實際的 user id？是 `ctx.config`、thread starter message、還是 `discordContext`？

---

## 對 §3.B（同名專案）的回應

**已修正。** §3.5 同名拒絕已加入。

---

## 對 §3.C（部分失敗 cleanup）的回應

**已接受，並已實作。** `project-orchestrator` 已有 cleanup stack，但我在閱讀原始碼時發現還有一個問題：

目前 `execute()` 的 try/catch cleanup 只在「論」錯誤時觸發。如果 `bindTarget()` 在 for 迴圈內部失敗，已建好的 thread 不會被清理（因為整個迴圈是一次性 transaction，中間失敗等於整個失敗）。建議 reviewer 確認這個實作是否正確。

---

## 對 §4.D（idleHours: 168 來源）的回應

**已補。** 說明這是 `openclaw.json` 的 account-level `threadBindings.idleHours` 設定，但尚未確認是否有 agent-level override 或 global default。需要你提供 `src/acp/session.ts:22` 的 `DEFAULT_IDLE_TTL_MS = 24h` 和 `168h` 之間的關聯。

---

## 對 §4.E（resolveToken 檔案位置）的回應

**已補。** 說明這是 `project-orchestrator/src/index.ts` 內部 helper，從 `openclaw.json` 的 `channels.discord.accounts.<agentId>.token` 讀取。

---

## 新問題 / 卡點

### 問題 1：Echo 的 delivery path 尚未確認

你說 echo 是 webhook echo，所以 `webhookId === binding.webhookId` 可以比對過濾。但實際上：

- PM Bot 用 bot token 直接回（不走 webhook）：inbound 的 `webhookId` 是 `null`
- 這種情況下 echo 過濾器失效，但 `NO_REPLY` guard 有用
- 我們目前無法確認 PM 回覆時究竟走 bot token 還是 webhook

這個影響：

- 如果 PM 永遠走 bot token，echo 過濾器無論如何都失效，但這不是問題（因為 `NO_REPLY` guard 有效）
- 如果 PM 走 webhook，`webhookId` 比對有意義，但需要確保 `bindTarget` 時 `webhookId` 有正確寫入

建議：有機會的話提供 `reply-delivery.ts` 的 delivery flow 說明。

### 問題 2：`spawnSubagentSessions: false` 需要端到端驗證

目前 config 仍是 `true`，`false` 只是文件層級的變更。需要一次真正的測試（驗收標準第 3 項）才能確認行為符合預期。

---

## 已執行 checklist（v2.1 變更）

- [x] sessions_send → message tool
- [x] spawnSubagentSessions: false
- [x] intro 改 mention user
- [x] NO_REPLY guard 降為第二道防線
- [x] 明寫 intro 由 main bot 代發
- [x] 同名拒絕
- [x] cleanup 說明
- [x] idleHours 補來源
- [x] resolveToken 補位置
- [x] pm/dev SKILL.md 全面改用 message tool
