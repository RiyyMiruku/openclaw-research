# DC 自動化開發團隊 — 系統藍圖 v2.1

> 建立日期：2026-04-15
> 最後更新：2026-04-24
> 對齊 spec：`project-init-implementation-spec.md`（方案 3：Discord Transport）

---

## 變更記錄

- 2026-04-24：v2.1 依 `FOR-BUTLER-blueprint-review.md` 修正
  - §1.5/§6.1/§6.2：`sessions_send` 全面移除，改為 `message` tool + target thread
  - §7.2：`pm/dev/cicd` 的 `spawnSubagentSessions` 改為 `false`
  - §3.4：intro 改 mention user/main，不 mention 自己（主防線）
  - §4.2：NO_REPLY guard 降為第二道防線
  - §3.1 Step 3：明寫 intro 由 main bot 代發
  - 新增 §3.5：同名專案拒絕策略
  - 新增 §3.6：部分失敗 cleanup 說明
  - §2.2：補 `idleHours: 168` 設定來源
  - §3.3：補 `resolveToken` 為 project-orchestrator 內部 helper
- 2026-04-24：v2.0 大幅更新（見 v2.1 changelog 合併記錄）
- 2026-04-23：Finance workspace 移至 finance-workspace/

---

## 一、系統架構

### 1.1 核心元件

| 元件       | 說明                                    |
| ---------- | --------------------------------------- |
| Main Agent | 日常對話 + 專案初始化（`project_init`） |
| PM Agent   | 需求分析 + 任務派發到 Dev thread        |
| Dev Agent  | 接收任務、實作、派發建置到 CICD thread  |
| CICD Agent | 建置測試、回報結果到 Dev thread         |

### 1.2 PM / Dev / CICD 是 top-level agent

> **重要聲明**：pm / dev / cicd 是與 main **同級的頂層 agent**，不是 subagent、不是 main 的下屬。

它們：

- 在 `openclaw.json` 的 `agents.list` 中與 main 平行註冊
- 各自擁有完整的 ACP session 系統（不走 subagent spawn 路徑）
- 只在**職能**上與 main 不同（system prompt、tools allowlist）
- 訊息 routing 不會被當成 main 的 subagent 而 fallback

若 `agents.list` 漏了任一個，訊息會被路由到 main 而非正確的 agent。

### 1.3 Discord 頻道結構

```
Guild: 1484583107947532541
├── #general (文字頻道) → Main Agent 監聽
│
├── 📁 [專案Forum] (Forum Channel, type=15)
│   ├── 🧵 pm    → PM Bot 綁定 session
│   ├── 🧵 dev   → Dev Bot 綁定 session
│   └── 🧵 cicd  → CICD Bot 綁定 session
```

**Thread 名稱**：`pm`、`dev`、`cicd`

### 1.4 Session Key 格式（已驗證正確）

```
agent:<agentId>:discord:channel:<threadId>
```

| Agent | 正確格式範例                                     |
| ----- | ------------------------------------------------ |
| pm    | `agent:pm:discord:channel:1497141826660864041`   |
| dev   | `agent:dev:discord:channel:1497141830620282923`  |
| cicd  | `agent:cicd:discord:channel:1497141835578216451` |

**格式說明**：`buildAgentSessionKey()` 內部呼叫 `buildAgentPeerSessionKey()`，當 `peerKind = "channel"` 時輸出 `agent:<agentId>:<channel>:channel:<peerId>`（4 段，**不帶 accountId**）。

accountId 段只在 `dmScope === "per-account-channel-peer"` 時才會被加入。

### 1.5 Agent 間 Transport 機制（方案 3）

**不走 `sessions_send`（A2A RPC），改用 Discord thread 訊息傳遞**：

```
PM → Dev：PM 在 Dev thread 發訊息 → Dev 被喚醒
Dev → CICD：Dev 在 CICD thread 發訊息 → CICD 被喚醒
Dev → PM：Dev 在 PM thread 發訊息 → PM 被喚醒
```

每個 agent 用 `message` tool 指定 `target: "<threadId>"` 發話。Discord thread 是天然的 transport layer，訊息經過 webhook delivery 為 agent 喚起對應 session。

---

## 二、Session 生命週期

### 2.1 Session 建立觸發條件

Bot session 由 thread-binding 機制在 binding path 上建立（**不走 subagent spawn**）：

1. 在對應 Discord thread 收到訊息
2. Gateway 查 thread-bindings.json，找到 `targetSessionKey`
3. `ensureConfiguredAcpBindingSession()` 在 binding path 上建立 ACP session
4. Session 建立後可接收 `sessions_send`

### 2.2 Idle 行爲與設定來源

Bot session 完成任務後進入 `done` 狀態。Idle timeout 來自各 Discord account 的 `threadBindings.idleHours` 設定：

```json
"accounts": {
  "pm": { "threadBindings": { "idleHours": 168 } }
}
```

`idleHours: 168` = 7 天後釋放資源。**重新激活**：在對應 thread 發一條 Discord 訊息即可。

### 2.3 驗證過的通訊路徑

| 方向       | 工具                                   | 狀態 |
| ---------- | -------------------------------------- | ---- |
| Main → PM  | `sessions_send`                        | ✅   |
| Main → Dev | `sessions_send`                        | ✅   |
| PM → Dev   | `message` tool → target: dev-threadId  | ✅   |
| Dev → CICD | `message` tool → target: cicd-threadId | ✅   |
| Dev → PM   | `message` tool → target: pm-threadId   | ✅   |

---

## 三、project_init 實作流程（Method B）

### 3.1 流程說明

1. Main agent 收到使用者「@main 建立專案 <name>」
2. `project_init` tool 被呼叫，執行：
   - Step 1：建立 Forum channel（REST）
   - Step 2：檢查同名 Forum（拒絕重名，見 §3.5）
   - Step 3：建立 3 個 thread（REST + intro message）**，由 main bot 代發**
   - Step 4：呼叫 `buildAgentSessionKey()` 組正確 session key
   - Step 5：用各 agent 自己的 Discord account 建立 binding manager
   - Step 6：`bindTarget({ createThread: false, ... })` 寫入 binding
   - Step 7：回傳三個 thread 的連結
   - Step 8：失敗時 cleanup（見 §3.6）

### 3.2 Session key 組法（已驗證正確）

```typescript
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";

const sessionKey = buildAgentSessionKey({
  agentId, // "pm" / "dev" / "cicd"
  channel: "discord",
  accountId: agentId,
  peer: { kind: "channel", id: threadId },
});
// 產出：agent:pm:discord:channel:1497141826660864041
```

**禁止手拼字串**，永遠用 `buildAgentSessionKey()`。

### 3.3 Binding Manager 帳號（已驗證正確）

每個 agent 的 binding 必須用**自己**的 Discord account manager：

```typescript
const manager = createThreadBindingManager({
  accountId: agentId, // 不是 "main"！是 "pm" / "dev" / "cicd"
  token: resolveToken(config, agentId),
  cfg: ctx.config,
  persist: true,
});
```

若用 `"main"` 建立 manager，binding 會因為 `accountId` 不匹配而查不到，導致 routing fallback 到 main。

**`resolveToken(config, agentId)`**：定義於 `extensions/project-orchestrator/src/index.ts`，從 `openclaw.json` 的 `channels.discord.accounts.<agentId>.token` 讀取。

### 3.4 project_init 初始訊息格式

**主防線**：intro 由 main bot 代發，且**不 mention 自己**，只 mention 使用者：

```
<@{userId}> 專案「**{projectName}**」已建立。PM 將在此 thread 接收你的需求討論。
```

這樣 PM bot 收到時，`allowBots: "mentions"` 判斷為「自己沒被 mention」，直接由 preflight drop，不會進入 LLM。

（NO_REPLY guard 見 §4.2，作為第二道防線。）

### 3.5 同名專案處理

**策略：拒絕 + 明確錯誤訊息**

```typescript
const existingChannels = await discordApi(mainToken, "GET", `/guilds/${guild}/channels`);
const duplicate = existingChannels.find((c) => c.type === 15 && c.name === projectName);
if (duplicate) {
  throw new Error(`Forum "${projectName}" 已存在（id: ${duplicate.id}），請換名稱或先封存舊專案。`);
}
```

### 3.6 部分失敗 Cleanup

建 Forum 後若 thread 或 binding 建立失敗，必須刪除已建資源避免孤兒 Forum：

```typescript
const cleanupFns: (() => Promise<void>)[] = [];
try {
  const forum = await discordApi(...);
  cleanupFns.push(() => discordApi(mainToken, "DELETE", `/channels/${forum.id}`));

  for (const agentId of ["pm", "dev", "cicd"]) {
    const thread = await discordApi(...);
    cleanupFns.push(() => discordApi(mainToken, "DELETE", `/channels/${thread.id}`));
    // bindTarget 失敗時只刪 thread，不刪 Forum
    const record = await manager.bindTarget(...);
    if (!record) throw new Error(...);
  }
} catch (err) {
  for (const fn of cleanupFns.reverse()) await fn().catch(() => {});
  throw err;
}
```

---

## 四、已修復的問題

### 4.1 Binding accountId 錯誤（✅ 已修復 2026-04-24）

**問題**：`accountId` 被錯誤寫成 `"main"`，導致 routing fallback 到 main。

**修復**：每個 agent 的 binding manager 用自己的 `accountId`（pm/dev/cicd）。

---

### 4.2 Echo Loop（✅ 已修復）

**問題**：PM 回覆自己的 kickoff 訊息後，形成無限迴圈。

**主防線**（§3.4）：intro 由 main bot 代發且不 mention 自己，PM 收到時 preflight 直接 drop。

**第二道防線**（SKILL guard）：在 `pm-workflow/SKILL.md` 加上 NO_REPLY guard：

```
## Guard — 收到以下狀況直接回 NO_REPLY
若發現 sender_id 是自己（pm bot 的 ID），這是 echo，直接停止。
```

---

### 4.3 Thread Binding 持久化（✅ 已修復）

Binding 寫入 `~/.openclaw/discord/thread-bindings.json`，格式：

```json
{
  "bindings": {
    "pm:1497141826660864041": {
      "accountId": "pm",
      "threadId": "1497141826660864041",
      "targetKind": "acp",
      "targetSessionKey": "agent:pm:discord:channel:1497141826660864041",
      "agentId": "pm"
    }
  }
}
```

---

### 4.4 SIGTERM 問題（⚠️ 未部署）

WSL 環境中 `openclaw gateway restart` 被 SIGTERM 打斷。臨時解法：`bash ~/.openclaw/restart-gateway.sh`

---

### 4.5 `setBindingRecord` / `saveBindingsToDisk` 不是 manager 實例方法（✅ 已修復 2026-04-24）

**問題**：實作時誤以為 `setBindingRecord()` 和 `saveBindingsToDisk()` 是 `createThreadBindingManager()` 回傳的 manager 實例方法，實際不是。

**錯誤寫法**（會直接 runtime error）：

```ts
// ❌ manager 實例沒有這兩個方法
manager.setBindingRecord(updated);
manager.saveBindingsToDisk({ force: true });
```

**原因**：`createThreadBindingManager()` 回傳的 manager 實例只有 `accountId` / `getByThreadId` / `bindTarget` / `unbindThread` 等方法。`setBindingRecord` 和 `saveBindingsToDisk` 是**獨立的模組級導出**，位於 `thread-bindings.discord-api-WOO9VoBT.js`。

**正確寫法**：直接 require 該 module，取用獨立的 top-level exports：

```ts
// ✅ 從 discord-api module 單獨 require 出來
const discordApi = req(openclawDir + "/dist/thread-bindings.discord-api-WOO9VoBT.js");
discordApi.setBindingRecord(updated);         // 對應 export 名稱 M
discordApi.saveBindingsToDisk({ force: true }); // 對應 export 名稱 j
```

**通用原則**：openclaw 內部有兩類 API：
- **Manager 實例方法**：如 `bindTarget`、`getByThreadId`、`unbindThread`。由 `createThreadBindingManager()` 回傳
- **模組級獨立導出**：如 `setBindingRecord`、`saveBindingsToDisk`、`BINDINGS_BY_THREAD_ID`、`rememberRecentUnboundWebhookEcho`。需從對應 module 直接 import

遇到 `manager.xxx is not a function` 類錯誤時，優先檢查該函式是否為 module-level export，而非 manager 方法。

---

## 五、SKILL.md 實際路徑

| Agent | SKILL.md 位置                                                       |
| ----- | ------------------------------------------------------------------- |
| PM    | `~/.openclaw/projects/pm-workspace/skills/pm-workflow/SKILL.md`     |
| Dev   | `~/.openclaw/projects/dev-workspace/skills/dev-workflow/SKILL.md`   |
| CICD  | `~/.openclaw/projects/cicd-workspace/skills/cicd-workflow/SKILL.md` |

---

## 六、工作流程摘要

### 6.1 PM Workflow

- **收到用戶需求** → 拆分任務 → `message` tool → target: dev-threadId
- **收到 Dev 回報** → 更新進度 → `message` tool → target: pm-threadId（回覆用戶）
- **Guard**：收到自己訊息 → `NO_REPLY`（第二道防線）

### 6.2 Dev Workflow

- **收到 PM 任務** → 分析 → 實作 → commit + PR → `message` tool → target: cicd-threadId
- **收到 CICD 結果** → ✅通過 → `message` tool → target: pm-threadId；❌失敗 → 修復後重派

### 6.3 CICD Workflow

- **收到 Dev 建置請求** → `exec` 跑 build/test → `message` tool → target: dev-threadId（回報結果）
- 不修改程式碼，只驗證和回報

---

## 七、Config 現況（`openclaw.json`）

### 7.1 Agents.list

四個 top-level agent 並列：

```json
"agents": {
  "default": "main",
  "list": [
    { "id": "main", ... },
    { "id": "pm",   "workspace": ".../projects/pm-workspace" },
    { "id": "dev",  "workspace": ".../projects/dev-workspace" },
    { "id": "cicd", "workspace": ".../projects/cicd-workspace" }
  ]
}
```

### 7.2 Discord Accounts

```json
"channels": {
  "discord": {
    "defaultAccount": "main",
    "accounts": {
      "main": { "threadBindings": { "spawnSubagentSessions": false } },
      "pm":   { "threadBindings": { "spawnSubagentSessions": false } },
      "dev":  { "threadBindings": { "spawnSubagentSessions": false } },
      "cicd": { "threadBindings": { "spawnSubagentSessions": false } }
    }
  }
}
```

> **注意**：`spawnSubagentSessions: false` — pm/dev/cicd 走 top-level ACP binding session 機制，不走 subagent spawn 路徑。

---

## 八、相關檔案索引

| 檔案              | 路徑                                                                |
| ----------------- | ------------------------------------------------------------------- |
| 主設定            | `~/.openclaw/openclaw.json`                                         |
| Thread Bindings   | `~/.openclaw/discord/thread-bindings.json`                          |
| 專案初始化 Plugin | `~/.openclaw/extensions/project-orchestrator/src/index.ts`          |
| PM Skill          | `~/.openclaw/projects/pm-workspace/skills/pm-workflow/SKILL.md`     |
| Dev Skill         | `~/.openclaw/projects/dev-workspace/skills/dev-workflow/SKILL.md`   |
| CICD Skill        | `~/.openclaw/projects/cicd-workspace/skills/cicd-workflow/SKILL.md` |
| 實作規格          | `notes/project-init-implementation-spec.md`                         |
| Review 來函       | `notes/FOR-BUTLER-blueprint-review.md`                              |
| Restart Script    | `~/.openclaw/restart-gateway.sh`                                    |
