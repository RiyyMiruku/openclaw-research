# 📬 給 Butler(main)的信 — Blueprint v2.0 Review

> **收件人:Butler(main agent)**
> 撰寫:2026-04-24
> 審閱對象:`notes/dc-automation-blueprint.md`(v2.0,你剛提交的版本)
> 用途:這份是審閱者給你的回饋。看完請逐條回應或修正,改完更新 blueprint 的 changelog 並標 v2.1。

---

## TL;DR

架構方向正確。有**一項要更正**(審閱者先前給錯的指引)、**兩項內部矛盾必改**、**一項修法偏弱建議強化**、**三項次要補漏**。

---

## ✅ 先更正審閱者的錯誤(感謝修正)

### Session key 格式是 4 段,審閱者先前說 6 段錯了

你們 §1.4 的格式 `agent:<agentId>:discord:channel:<threadId>` 是**正確的**。

根源:[src/routing/session-key.ts:173](../src/routing/session-key.ts#L173) 的 `buildAgentPeerSessionKey()` 預設路徑是:

```ts
return `agent:${normalizeAgentId(params.agentId)}:${channel}:${peerKind}:${peerId}`;
```

只有 `dmScope === "per-account-channel-peer"` 才會插入 accountId。Channel 類型的 session key 就是 4 段。這點不用改,維持現狀。

---

## 🔴 必改:兩處內部矛盾

### 1. `sessions_send` vs `message` tool 寫法不一致

blueprint 內部互相矛盾:

| 段落 | 寫法 | 主張 |
|---|---|---|
| §1.5 | 「**不走 `sessions_send`**,改用 Discord thread 訊息」「每個 agent 用 `message` tool」 | 方案 3 |
| §2.2 | 「`sessions_send` 會 timeout」 | 方案 2 |
| §6.1 | 「`sessions_send` 派發給 Dev」 | 方案 2 |
| §6.2 | 「`sessions_send` 派發 CICD」「`sessions_send` 回報 PM」 | 方案 2 |

**決議**:依 §1.5 的聲明(方案 3)為準。請把 §2.2、§6.1、§6.2 所有 `sessions_send` 字樣改成 `message` tool + 指定 target thread。

改寫範例:

```diff
- sessions_send 派發給 Dev
+ message tool → target: "<dev-threadId>"(由 Dev bot 收到後自動喚起其 session)
```

理由:方案 3 的整個前提是「Discord thread 就是 transport,agent 不直接呼叫彼此」。混用 sessions_send 等於偷跑 A2A RPC,繞過 Discord,失去觀測性,也讓 routing 行為複雜化。**如果真的需要 A2A,請另開 RFC,不要在這份 blueprint 裡混兩種**。

### 2. §1.2「top-level agent」vs §7.2 `spawnSubagentSessions: true` 矛盾

- §1.2 明確聲明 pm/dev/cicd 是 top-level agent,與 main 同級,不是 subagent
- §7.2 卻在 pm/dev/cicd 的 Discord account 設定 `spawnSubagentSessions: true`

這兩個概念衝突。`spawnSubagentSessions` 是 subagent spawn 路徑的開關,跟 top-level agent 的 ACP session 建立機制不同。

**決議**:

- 若真的走 top-level agent + thread-binding(`targetKind: "acp"`):**`spawnSubagentSessions` 應設 `false`**。Session 由 `ensureConfiguredAcpBindingSession()` 在 binding 路徑上建立,不需要 subagent spawn 介入。
- 若實際上你們是用 subagent spawn 路徑在做(這樣 session lifecycle 會不同),就要修 §1.2 的聲明,明說 pm/dev/cicd **是** main 的 subagent,並調整 §1.1 說法。

請二擇一,**不要兩個並存**。我傾向前者(top-level + ACP binding),因為這符合「多專案 session 隔離、長期並行」的目標。

---

## 🟡 建議強化:Echo Loop 修法(§4.2)

現況:在 `pm-workflow/SKILL.md` 加 `"若發現 sender_id 是自己,立即回 NO_REPLY"` 的 prompt guard。

**問題**:這是 LLM-level 的軟過濾,不是 deterministic filter。缺點:

- 靠模型自行判斷 sender_id,context 變長或模型退化時可能失效
- 每次 echo 都會吃一次 LLM 呼叫(token + 延遲成本),即使最終 NO_REPLY
- 模型切換(新版本、不同供應商)可能重現問題,沒有 regression 保護

**建議主防線**:改 intro text 不自 mention,用 @user 或 @main 的 mention。

```diff
- <@pm> 專案「{projectName}」已建立。這是 [User-PM] 溝通頻道,後續訊息將由 pm agent 處理。
+ <@{userId}> 專案「{projectName}」已建立。PM 將在此 thread 接收你的需求討論。
```

效果:intro text 不包含 pm bot 的 mention → PM bot 收到時,`allowBots: "mentions"` 判斷為「沒被 mention」→ 直接被 preflight drop,根本不會進 LLM。

**NO_REPLY guard 保留為最後一道防線**(應付未來 agent 間互相誤判的場景),但不再是主防線。

若前述改法不足以解決(例如其他情境下仍會 echo),再考慮在 openclaw preflight 層面加硬過濾:`message.author.id === botAccount.userId` 就 drop。這需要動 [preflight.ts](../extensions/discord/src/monitor/message-handler.preflight.ts),是 feature gap,優先度次於 intro 改寫。

---

## 🟡 補漏:三件被省略的事

### A. 同名專案處理

原 spec §5.2 要求拒絕或自動加序號,新 blueprint 省略了。請明寫策略並實作。推薦**拒絕** + 明確錯誤訊息給 main agent(「已有同名 Forum,請換名稱或先封存舊專案」)。

### B. 部分失敗 cleanup

原 spec §5.1 要求建 Forum 後若 thread 或 binding 建立失敗,要 cleanup(刪 Forum + 已建的 thread)。新 blueprint 沒寫。這是必須實作的,否則失敗會累積孤兒 Forum 汙染 guild。

請在 `project-orchestrator` 加 try/finally cleanup stack,參考原 spec §5.1 程式範例。

### C. §3.1 Step 3 intro 訊息是「誰」發的

blueprint 只寫「建立 3 個 thread(REST + intro message 含 @mention)」,沒說用哪個 bot token 發。這關鍵:

- 若用 **main bot token** 發 intro:intro 的 `author.id = main-bot`,pm/dev/cicd bot 收到時不是自己,echo 風險低
- 若用**各 agent 自己的 bot token** 發:就會踩上 echo 問題(§4.2 的來源)

請明確寫入 blueprint:**intro 由 main bot 代發**(推薦),或各 agent 自己發(需搭配上面「intro 不自 mention」的修法)。

---

## 🔵 次要疑點(待釐清,不一定要改)

### D. §2.2 `idleHours: 168`(7 天)來源

審閱者先前看到 ACP session 的 `DEFAULT_IDLE_TTL_MS = 24h`([src/acp/session.ts:22](../src/acp/session.ts#L22))。你們寫的 168h 是在哪裡設定的?是 agent-level override 還是 account-level?請補檔案路徑/設定欄位名稱。

### E. §3.3 `resolveToken(config, agentId)` 函式是哪個?

請補 import 路徑與檔案位置,方便後續維護。

---

## 實作檢核清單(給實作 agent 照著做)

- [ ] §2.2、§6.1、§6.2:把所有 `sessions_send` 改成 `message` tool + target thread
- [ ] §7.2:pm/dev/cicd 的 `spawnSubagentSessions` 改成 `false`(若維持 top-level 架構)
- [ ] §3.4 或新增段落:intro text 改成 mention user / main,不 mention 自己
- [ ] §4.2:說明 NO_REPLY guard 是第二道防線,主防線是 intro 改寫
- [ ] §3.1 Step 3:明寫 intro 由 main bot 代發
- [ ] 新增段落「錯誤處理」:同名拒絕 + 部分失敗 cleanup
- [ ] §2.2 補 `idleHours: 168` 設定來源
- [ ] §3.3 補 `resolveToken` 檔案位置
- [ ] 改完在 blueprint 的「變更記錄」加一筆 v2.1

---

## 驗收標準

改完 blueprint v2.1 後,跑一次端到端測試:

1. Main agent 在 #general 執行 `project_init` 建專案 `test-echo-fix`
2. 確認 Forum + 3 thread 建好,intro 文**不含** agent 自 mention
3. 在 pm thread 發 `@pm ping`,觀察 log:
   - `agentId=pm`(不是 main)✅
   - **沒有** echo(PM 不會對自己的回覆再回一次)✅
4. 在 pm thread 指示 pm 用 `message` tool 發到 dev thread,確認 dev bot 被喚起
5. 刪掉 `test-echo-fix` Forum,重建同名專案,預期收到「已存在」錯誤
6. 模擬建 thread 中途失敗(例如權限不足),確認 Forum 和已建 thread 都被清掉

通過以上 6 項 = v2.1 可簽收。

---

## 附註

這份 review 是單向溝通(審閱者 → 實作 agent)。若有不同意見或發現審閱者誤判,直接在 blueprint 的 changelog 標註並給出程式碼依據,不用另開檔案回信。
