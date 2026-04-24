# Project Init 實作規格(方案 3:Discord Transport)

> 撰寫日期:2026-04-23
> 目標讀者:實作 `project_init` 工具的 agent / 工程師
> 架構選擇:方案 3 — Discord Forum threads 作為 agent 間 transport,不用 `sessions_send`、不寫 interception plugin

---

## 1. 目標與範圍

### 1.0 Agent 階層定位(必讀)

**pm / dev / cicd 是與 main 同級的「頂層 agent」**,不是 subagent、不是 main 的下屬。它們:

- 在 `cfg.agents.list` 中與 main 平行註冊
- 各自擁有完整的 session 系統
- 只在**職能(role / system prompt / tools allowlist)**上與 main 不同 — 它們是「自動開發專用」的 agent
- Main 負責一般對話與專案生命週期管理(建立 / 列出 / 封存),pm/dev/cicd 負責產品規劃、實作、CI

### 1.1 多專案 session 隔離(架構核心)

每個 agent × 每個專案 = **獨立 session**,隔離鍵是 thread id。

```
專案 A (Forum: openclaw-foo)
  🧵 pm-thread-AAA   → session: agent:pm:discord:<acct>:channel:AAA
  🧵 dev-thread-BBB  → session: agent:dev:discord:<acct>:channel:BBB
  🧵 cicd-thread-CCC → session: agent:cicd:discord:<acct>:channel:CCC

專案 B (Forum: rag-system)
  🧵 pm-thread-DDD   → session: agent:pm:discord:<acct>:channel:DDD  ← 與 AAA 完全獨立
  🧵 dev-thread-EEE  → session: agent:dev:discord:<acct>:channel:EEE
  🧵 cicd-thread-FFF → session: agent:cicd:discord:<acct>:channel:FFF
```

**這是 openclaw routing 的原生行為,不需要額外實作**:
- Session key 由 `buildAgentSessionKey()` 組出 → 包含 channel/thread id
- Thread-binding 把 thread-id → session-key 的映射寫下
- 同一個 `agent:pm` 身份在不同 thread 被呼叫 = 不同 session = 不同 conversation history
- pm 在專案 A 的上下文絕對不會污染 pm 在專案 B 的 session

實作者不需要為「多專案隔離」寫任何特殊邏輯,只要正確套用 `buildAgentSessionKey()` 並確保 thread-binding 成功寫入即可。

### 要實作的行為

- 使用者在**一般文字頻道**對 main bot 說「@main 建立專案 <name>」
- Main agent 呼叫 `project_init` 工具(本規格要實作的東西)
- Tool 完成以下原子操作:
  1. 在同 guild 建立一個 Forum channel(名稱 = 專案名)
  2. 在該 Forum 下建立 3 個 thread:`pm`、`dev`、`cicd`
  3. 把每個 thread 綁定到對應的 agent session(thread-binding)
  4. 每個 thread 的第一篇 PO 文帶 `@bot` mention + 專案上下文
  5. 在原頻道回覆使用者 3 個 thread 的連結

### 刻意**不做**的事

- ❌ 不建立中央「User-PM 討論 thread」(使用者直接到 pm thread 對話)
- ❌ 不寫 interception plugin(方案 3 不需要,agent 自己用 `message` tool 發話即天然可見)
- ❌ 不用 `sessions_send`(方案 3 用 Discord 作 transport,不走 A2A RPC)
- ❌ 不用 subagent spawn(要 3 個長期平行 session,subagent 生命週期不符)
- ❌ 不寫靜態 `openclaw.json` `bindings[]`(改用 runtime thread-bindings,避免 `pickFirstExistingAgentId` 把未註冊 agent 改成 main 的陷阱)

---

## 2. 前置需求(實作前必須確認)

### 2.1 `openclaw.json` 的 `agents.list` 必須將 pm / dev / cicd 註冊為**頂層 agent**

**這是最關鍵的前置**。pm / dev / cicd 與 main 同階,在 `agents.list` 中平行註冊為獨立條目,**不是** main 的 subagent、也不在 main 的 `subagents` 欄位裡。

[src/routing/resolve-route.ts:152-167](../src/routing/resolve-route.ts#L152-L167) 的 `pickFirstExistingAgentId()` 在 agent id 不在 `agents.list` 時會靜默 fallback 成預設 agent(通常 `main`)。雖然 runtime thread-binding 走的 code path 不經過這個函式,但:

- 靜態 binding 路徑會被污染
- Agent session 要能真的啟動,對應 agent 仍需存在於 config
- 若漏註冊,訊息會被接到 main,失去職能分工的意義

範例設定(**四個 top-level agent 並列**):

```jsonc
{
  "agents": {
    "default": "main",
    "list": [
      // main: 一般對話 + 專案管理工具
      {
        "id": "main",
        "systemPrompt": "你是使用者的日常助理。當使用者要求建立專案時,呼叫 project_init。",
        "tools": { "allow": ["message", "project_init", "project_list", ...] }
      },
      // pm: 產品規劃 / 需求分析 / 與使用者對談需求
      {
        "id": "pm",
        "systemPrompt": "你是 PM agent。在此 thread 與使用者討論需求並拆分任務,透過 message tool 把規格送到 dev 的 thread。",
        "tools": { "allow": ["message", ...] }
      },
      // dev: 實作 / 寫 code / 開 PR
      {
        "id": "dev",
        "systemPrompt": "你是 Dev agent。依 PM 指示實作,透過 message tool 把完成的 PR 送到 cicd thread 驗證。",
        "tools": { "allow": ["message", "bash", "edit", "read", "grep", ...] }
      },
      // cicd: 測試 / 建置 / 回報結果
      {
        "id": "cicd",
        "systemPrompt": "你是 CI/CD agent。跑 build / test,把結果以 message 回報到 dev 或 pm thread。",
        "tools": { "allow": ["message", "bash", ...] }
      }
    ]
  }
}
```

**這四個 agent 之間沒有階層關係**,差異只有:
- System prompt(職能指示)
- Tools allowlist(權限範圍)
- 使用者預期綁定到哪種 channel(main → 一般頻道;pm/dev/cicd → 各專案 Forum 下對應 thread)

### 2.2 三個 agent 的 tools allowlist 必須包含 `message`

方案 3 的 transport 機制:每個 agent 用 `message` tool 發到**別的 thread** 來跟別的 agent 對話。

### 2.3 `tools.agentToAgent.enabled` 不需要開啟

方案 3 不用 `sessions_send`,所以這個 flag 與本規格無關。

### 2.4 Main agent 的 tools allowlist 要包含本規格實作的 `project_init`

---

## 3. 對話流程(驗收用)

### 3.1 初始化(本規格實作)

```
[#general]
User: @main 建立專案 openclaw-foo,做一個 RAG pipeline
Main: ✅ 專案 openclaw-foo 已建立:
      • 🧵 <#pm-threadId>     ← 找 PM 討論需求
      • 🧵 <#dev-threadId>    ← Dev 的工作區
      • 🧵 <#cicd-threadId>   ← CI/CD 觀察區
```

### 3.2 工作流(運行期,不在本規格範圍,僅供驗收)

```
[📁 openclaw-foo / 🧵 pm]
User: @pm 先做文件切分
🤖 pm: 收到,我把任務轉給 dev。
       [pm 呼叫 message tool → channel:<dev-threadId>]

[📁 openclaw-foo / 🧵 dev]
🤖 pm: @dev 請實作文件切分 pipeline,規格:...
🤖 dev: 開始實作... [寫 code]
🤖 dev: 完成,請 cicd 測試。
        [dev 呼叫 message tool → channel:<cicd-threadId>]

[📁 openclaw-foo / 🧵 cicd]
🤖 dev: @cicd 請跑測試
🤖 cicd: ✅ 87% coverage
```

關鍵:agent 之間不用 `sessions_send`。**跨 thread 對話 = 呼叫 `message` tool 並指定目標 thread**。每個 thread 的 gateway 收到新訊息 → 根據 thread-binding 喚醒對應 agent session。

---

## 4. 實作步驟

### 4.1 Tool 定義位置

在 `src/agents/tools/` 下新增 `project-init-tool.ts`,仿照其他 tool 的註冊方式。Tool schema:

```ts
{
  name: "project_init",
  description: "Create a new project with a Discord Forum channel and bound pm/dev/cicd threads.",
  input: {
    projectName: string,         // 必填,會作為 Forum 名稱
    description?: string,        // 選填,寫入 Forum topic 與 thread intro
    guildId?: string,            // 選填,預設從 main agent 當前 channel 推斷
  }
}
```

### 4.2 依賴 API 清單

| 功能 | 來源 | 位置 |
|---|---|---|
| 建 Forum channel (REST) | `POST /guilds/{guildId}/channels` type=15 | Discord REST API,用 `extensions/discord/src/monitor/thread-bindings.discord-api.ts` 裡的 request helper |
| 建 thread + bind + 發 intro | `manager.bindTarget({ createThread: true })` | [extensions/discord/src/monitor/thread-bindings.types.ts:47](../extensions/discord/src/monitor/thread-bindings.types.ts#L47) |
| 取得 thread binding manager | `getThreadBindingManager(accountId)` | [extensions/discord/src/monitor/thread-bindings.manager.ts](../extensions/discord/src/monitor/thread-bindings.manager.ts) |
| 組 session key | `buildAgentSessionKey(...)` | [src/routing/session-key.ts](../src/routing/session-key.ts) |
| 在原頻道回覆 | `message` tool(或直接用 Discord REST) | 現有 tool |

**注意**:`manager.bindTarget` 接受 `targetKind: "acp" | "subagent"`,方案 3 用 `"acp"`。[thread-bindings.manager.ts:115-121](../extensions/discord/src/monitor/thread-bindings.manager.ts#L115-L121) 會把 `"acp"` 正規化成 `SessionBindingTargetKind = "session"`,這是預期行為,不要試圖改。

### 4.3 執行序列

```ts
async function projectInit(params: {
  projectName: string;
  description?: string;
  guildId: string;
  discordAccountId: string;
  botUserId: string;
}) {
  // Step 1: 建 Forum channel
  const forum = await discordRest.post(`/guilds/${params.guildId}/channels`, {
    name: sanitizeChannelName(params.projectName),
    type: 15, // GUILD_FORUM
    topic: params.description ?? `Project: ${params.projectName}`,
  });

  // Step 2: 取 manager(必須先確保 plugin 已初始化 thread-bindings manager)
  const manager = getThreadBindingManager(params.discordAccountId);
  if (!manager) {
    throw new Error(`Discord thread binding manager not initialised for account ${params.discordAccountId}`);
  }

  // Step 3: 逐一建 thread + bind
  const agents = ["pm", "dev", "cicd"] as const;
  const records: Record<string, { threadId: string; sessionKey: string }> = {};

  for (const agentId of agents) {
    const label = agentId.toUpperCase();
    const introText =
      `<@${params.botUserId}> 你是 ${label} agent。\n` +
      `專案: **${params.projectName}**\n` +
      (params.description ? `需求概述: ${params.description}\n` : "") +
      `請等待 ${agentId === "pm" ? "使用者" : agentId === "dev" ? "PM" : "Dev"} 的指示。`;

    // bindTarget({ createThread: true }) 會:
    //   1. 呼叫 Discord REST 在 forum.id 建 thread
    //   2. 發 introText 作為 PO 文(帶 mention → 通過 mention gating)
    //   3. 建 webhook(用於日後 agent 回覆以 persona 顯示)
    //   4. 寫入 thread-bindings.json 並 in-memory 註冊
    const record = await manager.bindTarget({
      channelId: forum.id,
      createThread: true,
      threadName: agentId,
      targetKind: "acp",
      // 先用 placeholder,拿到 threadId 後再 update(見下方 4.4 chicken-and-egg)
      targetSessionKey: `agent:${agentId}:discord:${params.discordAccountId}:channel:PENDING`,
      agentId,
      label,
      boundBy: "main-project-init",
      introText,
      metadata: {
        projectName: params.projectName,
        role: agentId,
      },
    });

    if (!record) {
      throw new Error(`Failed to create/bind thread for ${agentId}`);
    }
    records[agentId] = { threadId: record.threadId, sessionKey: record.targetSessionKey };
  }

  // Step 4: 修正 session key(見 4.4)
  await rebindWithCorrectSessionKeys({
    manager,
    discordAccountId: params.discordAccountId,
    records,
  });

  // Step 5: 回傳給 main agent 使用
  return {
    forumChannelId: forum.id,
    threads: {
      pm: records.pm.threadId,
      dev: records.dev.threadId,
      cicd: records.cicd.threadId,
    },
    summaryMarkdown:
      `✅ 專案 **${params.projectName}** 已建立:\n` +
      `• <#${records.pm.threadId}> — 找 PM 討論需求\n` +
      `• <#${records.dev.threadId}> — Dev 工作區\n` +
      `• <#${records.cicd.threadId}> — CI/CD 觀察區`,
  };
}
```

### 4.4 Session key 的 chicken-and-egg 解法

`targetSessionKey` 需要 `threadId`,但 `threadId` 是 `bindTarget` 回傳的。解法:

**方案 A(推薦)**:先用 placeholder 寫入,拿到 threadId 後 `unbind` + `bindTarget` 重新綁定。成本是兩次檔案寫入,但邏輯單純。

**方案 B**:先用 `POST /channels/{forumId}/threads` 直接建 thread(不走 manager),拿到 threadId 後再呼叫 `manager.bindTarget({ threadId, createThread: false, targetSessionKey: ... })`。繞開 manager 自己建 thread 的行為,多一次 REST 呼叫,但只一次 binding 寫入。

**方案 B 範例**(實作者擇一即可):

```ts
for (const agentId of agents) {
  // 自己建 thread
  const thread = await discordRest.post(`/channels/${forum.id}/threads`, {
    name: agentId,
    auto_archive_duration: 10080,
    message: { content: introText },
  });

  // 組正確 session key
  const sessionKey = buildAgentSessionKey({
    agentId,
    channel: "discord",
    accountId: params.discordAccountId,
    peerKind: "channel",
    peerId: thread.id,
  });

  // bind(不重建 thread)
  await manager.bindTarget({
    threadId: thread.id,
    channelId: forum.id,
    createThread: false,
    targetKind: "acp",
    targetSessionKey: sessionKey,
    agentId,
    boundBy: "main-project-init",
  });
}
```

**偏好方案 B**:session key 一次到位、無重複寫檔。

### 4.5 Session key 格式

必須符合 [parseAgentSessionKey](../src/routing/session-key.ts) 的解析規則。格式:

```
agent:<agentId>:discord:<accountId>:channel:<threadId>
```

- `agent:` 字首必須存在
- 第二段是 agentId(會被 `resolveAgentIdFromSessionKey` 解析出來,務必等於 pm / dev / cicd)
- 後段隨意(只要可 parse),上述格式是 convention

**不要**用舊版你試過的 `agent:pm:discord:pm:channel:...`(第二段和 accountId 混在一起容易誤讀)。用 `buildAgentSessionKey()` 保證正確。

---

## 5. 錯誤處理與冪等性

### 5.1 部分失敗(已建 Forum 但 thread 建到一半失敗)

**必做**:catch 後清理。刪除已建的 Forum channel(及其下 threads)。否則留下孤兒頻道污染 server。

```ts
const cleanup: (() => Promise<void>)[] = [];
try {
  const forum = await createForum(...);
  cleanup.push(() => discordRest.delete(`/channels/${forum.id}`));
  // ... 建 threads ...
} catch (e) {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  throw e;
}
```

### 5.2 同名專案

兩種策略,擇一實作:

- **拒絕**:建 Forum 前先 `GET /guilds/{guildId}/channels` 檢查是否已有同名 Forum,有就回錯給使用者。
- **自動加序號**:`openclaw-foo` → `openclaw-foo-2`。

**推薦拒絕**,避免使用者混淆。

### 5.3 Manager 未初始化

`getThreadBindingManager(accountId)` 可能回傳 null(帳號尚未啟動)。必須 fail fast,訊息告訴使用者「Discord 整合尚未就緒」。

### 5.4 Rate limit

Discord REST 會丟 429。現有的 `discord-api.ts` request helper 應已處理 retry;若沒有,用 `RetryRunner`([src/infra/retry](../src/infra/retry) 或類似)包起來。

---

## 6. 額外記錄檔案(projects.json)

**選做**。在 `data/projects.json` 保留專案清單,方便日後「列出所有專案」或清理:

```jsonc
{
  "projects": [
    {
      "name": "openclaw-foo",
      "guildId": "...",
      "forumChannelId": "...",
      "threads": { "pm": "...", "dev": "...", "cicd": "..." },
      "createdAt": 1712345678901,
      "createdBy": "user:<discord-user-id>"
    }
  ]
}
```

純記事,routing 用不到。

---

## 7. 測試計畫

### 7.1 單元測試

- `project-init-tool.test.ts`
  - mock `getThreadBindingManager` 與 Discord REST client
  - 驗證:3 個 `bindTarget` 呼叫、session key 格式正確、同名專案拒絕、部分失敗觸發 cleanup

### 7.2 整合測試(在 dev Discord server)

流程:
1. 在 #general `@main 建立專案 test-1`
2. 驗證 Forum `test-1` 被建立,下有 pm / dev / cicd 三個 thread
3. 每個 thread 的第一篇 PO 文含 bot mention
4. 在 pm thread 發 `@pm hi`,確認 pm agent 回應(而不是 main 接走)
5. 在 pm prompt 裡指示它 `message channel:<dev-threadId> "..."`,確認 dev thread 收到訊息且 dev agent 被喚起
6. 確認 `thread-bindings.json` 記錄正確,含三筆 `targetKind: "acp"` entry

### 7.3 關鍵驗證:routing 正確到 agent(不是 main)

最重要的回歸測試。從上個除錯經驗知道:**最常見的失敗模式是訊息被路由到 main**。驗證方法:

- 在 pm thread 送 `@pm ping`,觀察 server log 的 `[discord-preflight] ... agentId=pm` 訊息
- 若 log 顯示 `agentId=main` 就是回歸了,檢查:
  - `agents.list` 是否註冊 pm
  - thread-binding 是否載入(`thread-bindings.json` 是否被 manager 讀到)
  - session key 格式(用 `parseAgentSessionKey` 檢查能否正確 parse 出 agentId)

---

## 8. 後續工作(不在本規格內)

實作完本規格後,值得評估的延伸:

- **專案刪除 tool**:`project_archive` — 封存 Forum、清除對應 thread-bindings、可選保留 projects.json 紀錄。
- **Main agent 的 project 清單工具**:讓使用者 `@main list projects`。
- **Agent persona avatar**:[reply-delivery.ts:116-139](../extensions/discord/src/monitor/reply-delivery.ts#L116-L139) 的 `resolveBindingPersona` 會根據 agentId 取 avatar,設定 `cfg.agents[].avatar` 可讓 pm/dev/cicd 在 webhook 訊息中有不同頭像。
- **Thread archive 策略**:`auto_archive_duration` 預設 10080(7 天)。長期 idle thread 會被 Discord 封存,封存後訊息仍可路由但新 PO 需要解封存。是否要在 Main agent 定期 ping 保活,或接受封存,自行決定。

---

## 9. 實作 checklist(給實作 agent 用)

- [ ] 確認 `openclaw.json` 有**把 pm / dev / cicd 列為 top-level `agents.list` 條目**(與 main 並列,**不是** subagents)
- [ ] 建立 `src/agents/tools/project-init-tool.ts`,實作 tool schema 與 handler
- [ ] 採用 4.4 方案 B(先建 thread、再 bind)
- [ ] session key 用 `buildAgentSessionKey()` 組,不手拼字串
- [ ] introText 含 `<@botId>` mention
- [ ] 實作部分失敗 cleanup(刪 Forum)
- [ ] 實作同名專案拒絕
- [ ] 把 `project_init` 加入 main agent 的 `tools.allow`
- [ ] 單元測試涵蓋成功、失敗、cleanup 三情境
- [ ] 手動整合測試:真的在 dev server 跑一次 end-to-end,重點確認 routing 到正確 agent(非 main)
- [ ] (選)寫入 `data/projects.json`
- [ ] 更新 `notes/multi-agent-discord-forum-architecture.md` 或相關設計文件的「project_init 實作」段落

---

## 10. 參考檔案速查

| 主題 | 路徑 |
|---|---|
| Thread binding manager 型別 | [extensions/discord/src/monitor/thread-bindings.types.ts](../extensions/discord/src/monitor/thread-bindings.types.ts) |
| Thread binding manager 實作 | [extensions/discord/src/monitor/thread-bindings.manager.ts](../extensions/discord/src/monitor/thread-bindings.manager.ts) |
| Thread binding lifecycle(autoBindSpawnedDiscordSubagent 可參考) | [extensions/discord/src/monitor/thread-bindings.lifecycle.ts](../extensions/discord/src/monitor/thread-bindings.lifecycle.ts) |
| Discord REST helper | [extensions/discord/src/monitor/thread-bindings.discord-api.ts](../extensions/discord/src/monitor/thread-bindings.discord-api.ts) |
| Session key 工具 | [src/routing/session-key.ts](../src/routing/session-key.ts) |
| Agent 查找與 fallback 邏輯(必讀,避開 main fallback 陷阱) | [src/routing/resolve-route.ts](../src/routing/resolve-route.ts) |
| Mention gating 規則 | [src/channels/mention-gating.ts](../src/channels/mention-gating.ts) + [extensions/discord/src/monitor/allow-list.ts](../extensions/discord/src/monitor/allow-list.ts) |
| Reply delivery (bound thread → webhook persona) | [extensions/discord/src/monitor/reply-delivery.ts](../extensions/discord/src/monitor/reply-delivery.ts) |
| 既有設計文件 | [notes/multi-agent-discord-forum-architecture.md](multi-agent-discord-forum-architecture.md) |
