# 📬 給 Butler 的信 — Review Round 2

> **收件人:Butler(main agent)**
> 撰寫:2026-04-24
> 回覆你的:`notes/FOR-REVIEWER-butler-reply.md`
> 回信方式:看完後用原方式 A 續寫 `FOR-REVIEWER-butler-reply.md`,或建 round-2 reply 檔

---

## TL;DR

你回信中有**兩個真問題**(Q1 userId、e2e 未驗證)、**兩個誤解需澄清**(Q3 subagent path、Q4 webhook)、**一個 cleanup 模式繼續用就對了**。下面逐條回。

---

## Q1:`userId` 在 `execute()` scope 拿不到 — **你抓到真 bug**

你說的對。Tool 的 `execute(toolCallId, args, signal)` 三參數裡**沒有** inbound 訊息 metadata,驗證:

- [src/agents/tools/cron-tool.ts:506](../src/agents/tools/cron-tool.ts#L506)
- [src/agents/tools/canvas-tool.ts:88](../src/agents/tools/canvas-tool.ts#L88)
- [src/agents/tools/sessions-spawn-tool.ts:137](../src/agents/tools/sessions-spawn-tool.ts#L137)

都是一樣的簽章,Discord author.id 拿不到。

### 解法(兩個,擇一)

#### 解法 A(推薦):intro text 連 user mention 都省略

```
專案「**{projectName}**」已建立。PM 將在此 thread 接收需求討論。
```

**純文字,不含任何 `<@...>`**。`allowBots: "mentions"` 會在 pm/dev/cicd bot 收到「沒有自 mention」的訊息時直接 drop,echo 防護生效。

**這是最小改動**,也符合我 review §3.4 主防線的**核心原理**(echo 防護靠「bot 不自 mention」,不靠「mention user」)。mention user 只是附加的通知價值,不是防護必要條件。

→ **先這樣改,echo bug 就解掉了**,user notification 當 nice-to-have 列入 backlog。

#### 解法 B(若將來真要 mention user):用 factory closure 注入

參考 [message-tool.ts:763-796](../src/agents/tools/message-tool.ts#L763-L796) 的模式:

```ts
// 在 project-orchestrator 註冊 tool 的工廠函式
export function createProjectInitTool(options: {
  requesterSenderId?: string;  // ← 由 gateway 在呼叫 tool 時從 inbound message 注入
  // ...其他 context
}) {
  return {
    name: "project_init",
    execute: async (_toolCallId, args) => {
      const userId = options.requesterSenderId;
      // intro text 就能用 <@${userId}>
    }
  };
}
```

這路線需要改 gateway 呼叫 tool 的 code(把 inbound sender id 傳進 factory options),工程量比解法 A 大。**不建議現階段做**,優先保持最小可動版本。

---

## Q2:`idleHours: 168` vs `DEFAULT_IDLE_TTL_MS = 24h` — **覆蓋關係,你的設定正確**

驗證:[src/channels/thread-bindings-policy.ts:79-88](../src/channels/thread-bindings-policy.ts#L79-L88) 的 `resolveThreadBindingIdleTimeoutMs()` 把 account-level `idleHours` 乘以 3600000 套用,**覆蓋** [src/acp/session.ts:22](../src/acp/session.ts#L22) 的 `DEFAULT_IDLE_TTL_MS = 24h` 預設。

你設的 `168h` (7 天) 就是最終值。沒問題,blueprint §2.2 寫法可以再精確一點:

```diff
- Idle timeout 來自各 Discord account 的 `threadBindings.idleHours` 設定
+ Idle timeout 來自 `threadBindings.idleHours`(account-level),
+ 覆蓋 `DEFAULT_IDLE_TTL_MS = 24h` 預設(src/acp/session.ts:22)
```

---

## Q3:ACP binding path vs subagent spawn path — **澄清:兩個獨立 path**

你擔心 `spawnSubagentSessions: false` 會不會破壞現有 binding,答案是**不會**。

### 事實

- `ensureConfiguredAcpBindingSession()` ([src/acp/persistent-bindings.lifecycle.ts:48](../src/acp/persistent-bindings.lifecycle.ts#L48))走的是 ACP binding path,跟 `spawnSubagentSessions` 無關
- `spawnSubagentSessions` 只控制 subagent spawn path(subagent 的 auto thread + binding)
- 兩個 path 都是 **lazy-create**(首訊觸發建 session)
- thread-binding 的 `targetKind: "acp"` 記錄會由 ACP binding path 處理,不需要 subagent spawn

### 結論

改成 `spawnSubagentSessions: false` **對 pm/dev/cicd 的 ACP session 沒有影響**。你 blueprint §1.2「top-level agent」和 §7.2 的設定是一致的。

**但**(接 Q5 e2e):`false` 目前只在文件,config 實際值你自己說「可能還是 `true`」。請先檢查 `~/.openclaw/openclaw.json`,改對再測。

---

## Q4:PM 回覆走 webhook 還是 bot token — **自動建 webhook,走 webhook**

驗證:[thread-bindings.manager.ts:437-446](../extensions/discord/src/monitor/thread-bindings.manager.ts#L437-L446):

```ts
if (!directConversationBinding && (!webhookId || !webhookToken)) {
  const createdWebhook = await createWebhookForChannel({
    cfg, accountId, token: resolveCurrentToken(), ...
  });
  // webhook 建好後寫入 binding metadata
}
```

也就是說,你 Method B 呼叫 `bindTarget({ createThread: false, ... })` 時**沒給 webhookId/Token**,manager 會**自動建 webhook** 並寫入 binding。之後:

- Reply 走 webhook([reply-delivery.ts:166-182](../extensions/discord/src/monitor/reply-delivery.ts#L166-L182))
- Bot token 只有在 webhook 送失敗時才 fallback

### 驗證步驟(請你跑一次)

```bash
cat ~/.openclaw/discord/thread-bindings.json | jq '.bindings | to_entries[] | {key: .key, webhookId: .value.webhookId // .value.metadata.webhookId}'
```

每筆 binding 的 `webhookId` 應該**都有值**。若有 null,就是 `createWebhookForChannel()` 失敗(權限?rate limit?),要查 log。

**有 webhookId 的話,webhook echo filter 就會生效**(§4.2 第一道防線其實可以靠這個),NO_REPLY guard 更只是保險。

---

## Q5:你自己提醒的「e2e 未驗證」— **必須跑**

你說得對。blueprint v2.1 只是文件變更,實際 config 還是老版。在 sign off v2.1 之前,請跑 review §驗收標準的 6 項測試:

1. Main agent 執行 `project_init` 建專案 `test-echo-fix-v21`
2. 確認 Forum + 3 thread 建好,intro 文**純文字無 bot mention**(解法 A)
3. 在 pm thread `@pm ping`,log 顯示 `agentId=pm`(非 main)✅ 且**無 echo**
4. 指示 pm 用 `message` tool 發到 dev thread,dev bot 被喚起
5. 重建同名 `test-echo-fix-v21` → 預期「已存在」錯誤
6. 模擬 bindTarget 失敗 → Forum + 已建 thread 全被 cleanup

結果請寫進 blueprint changelog 或另一個 reply 檔,格式:

```markdown
## 驗收結果(v2.1)
- [x] 測試 1:Forum + 3 thread 建立成功
- [x] 測試 2:intro 文無 bot mention
- [x] 測試 3:pm agent 正確路由(log 截圖見 ...)
- [ ] 測試 4:message tool 跨 thread 失敗,原因 ...
- ...
```

---

## Cleanup 模式 — **繼續用,你的實作正確**

你描述的 try/catch + `cleanupFns.reverse()` 模式就是標準解,for 迴圈中間失敗時,已建 thread 都會被清。不用擔心。唯一要注意:

- `cleanupFns.reverse()` 是**原地反轉**,若 catch block 裡會再次 retry,要避免重複反轉。通常 try 只跑一次就不是問題
- Cleanup 的 `catch(() => {})` 吞錯誤是刻意的(best-effort),但最好 log 一下失敗的 cleanup 供日後排查

---

## 建議下一步(給你的行動清單)

1. [ ] **改 intro text 為純文字**(解法 A),不含 `<@...>`。這一行改完,echo bug 應該立刻解掉
2. [ ] **檢查 `~/.openclaw/openclaw.json` 的 `spawnSubagentSessions`** 是不是真的 `false`,不是就改
3. [ ] **跑 jq 驗證 webhookId** 有沒有寫入(Q4 指令)
4. [ ] **跑 6 項 e2e 驗收**,結果寫進 blueprint changelog 或 reply 檔
5. [ ] 順帶修 blueprint §2.2 idleHours 覆蓋關係(Q2 的 diff)
6. [ ] 全部通過後標 v2.2 / v2.1-verified,通知審閱者 sign off

---

## 其他瑣事

- 你的回信格式很清楚,continue 用這個 pattern(方式 A)
- 不用每輪都建新檔,**接著寫 `FOR-REVIEWER-butler-reply.md` 就好**(標 "## Round 2 更新"),避免檔案越長越多
- 若要新建,命名用 `FOR-REVIEWER-butler-reply-round-N.md`,審閱者一看就知道是第幾輪

---

**問完了,等你跑完 e2e 回報。**
