# 多 Agent Discord Forum - 執行配置計畫

> 本文件為完整的逐步執行指南，AI agent 可直接按步驟實作，不需要參考其他文件。

---

## 前置條件

| 項目 | 值 | 說明 |
|------|---|------|
| Discord Server | 私人 Server | 已建立，4 個 Bot 都已加入 |
| Main Bot Token | `DISCORD_BOT_TOKEN_MAIN` | 需有 `MANAGE_CHANNELS` 權限 |
| PM Bot Token | `DISCORD_BOT_TOKEN_PM` | |
| Dev Bot Token | `DISCORD_BOT_TOKEN_DEV` | |
| CICD Bot Token | `DISCORD_BOT_TOKEN_CICD` | |
| Guild ID | `YOUR_GUILD_ID` | Server Settings → Copy Server ID |
| #general Channel ID | `GENERAL_CHANNEL_ID` | 現有文字頻道，Main Bot 監聽 |
| openclaw | 已安裝並可執行 | `openclaw config set ...` 可用 |

> **Discord Bot 建立**：在 Discord Developer Portal 建立 4 個 Application，
> 各自建立 Bot 並取得 Token。每個 Bot 設定不同的 username 和 avatar 以便辨識。
> 4 個 Bot 都需要加入同一個私人 Server。

---

## 架構概覽

```
Discord Server（私人）
│
├── #general (文字頻道)                 ← Main Bot 監聽（日常對話 + 創建專案）
│
├── 📁 RAG系統 (Forum Channel)          ← 專案 A（動態建立）
│   ├── 🧵 [User-PM] 專案討論           ← PM Bot 綁定
│   ├── 🧵 [PM-Dev] 開發任務            ← Dev Bot 綁定
│   └── 🧵 [Dev-CICD] 建置測試          ← CICD Bot 綁定
│
├── 📁 Auth重構 (Forum Channel)         ← 專案 B（動態建立）
│   ├── 🧵 [User-PM] ...
│   ├── 🧵 [PM-Dev] ...
│   └── 🧵 [Dev-CICD] ...
│
└── #agent-logs (可選)
```

**通訊流**：User ↔ PM（User-PM thread）→ PM → Dev（PM-Dev thread）→ Dev → CICD（Dev-CICD thread）
**錯誤上報**：CICD → Dev → PM → User（反向傳遞）
**Session Key 格式**：`agent:<agentId>:discord:<accountId>:<threadId>`

---

## 禁止 Agent 執行的命令

Agent 運行在 gateway 之內，以下操作會導致 Agent 自身被 SIGTERM 終止：

```
❌ openclaw gateway restart / stop
❌ systemctl restart openclaw
❌ 任何會終止 gateway 行程的命令
```

配置修改 / gateway 重啟由用戶（人類）從外部執行。Agent 如需變更配置：
1. 修改配置檔案（write/edit）
2. 通知用戶：「配置已更新，請手動執行 `openclaw gateway restart`」

---

# Phase 1：基礎設置

## Step 0：啟用 Discord Plugin

Discord plugin 預設是 **disabled**，必須先啟用：

```bash
openclaw config set plugins.entries.discord.enabled true
```

驗證：
```bash
openclaw plugins list
# 確認 discord 狀態為 enabled
```

---

## Step 1：建立 openclaw.json

路徑：`~/.openclaw/openclaw.json`（主配置檔）

> **Phase 1 只寫以下配置。不要加任何 `plugins.load` 或 `project-orchestrator` 相關配置。**
> Plugin 程式碼不存在時加入 plugin path 配置會導致 gateway 啟動失敗。

```jsonc
{
  // ═══ Agent 定義 ═══
  "agents": {
    "list": [
      {
        "id": "main",
        "name": "Main Agent",
        "default": true,
        "identity": { "name": "Main", "emoji": "🚀" },
        "model": { "primary": "claude-sonnet-4-6" },
        "workspace": "./projects",
        "thinkingDefault": "medium",
        "skills": ["main-orchestrator"],
        "subagents": { "allowAgents": ["pm", "dev", "cicd"], "requireAgentId": true },
        "tools": {
          "allow": ["read", "glob", "grep", "sessions_spawn", "sessions_send", "sessions_list", "message"]
        }
      },
      {
        "id": "pm",
        "name": "PM Agent",
        "identity": { "name": "PM", "emoji": "📋" },
        "model": { "primary": "claude-opus-4-6" },
        "workspace": "./projects",
        "thinkingDefault": "high",
        "skills": ["pm-workflow"],
        "subagents": { "allowAgents": ["dev"], "requireAgentId": true },
        "tools": {
          "allow": ["read", "write", "edit", "glob", "grep", "sessions_send", "sessions_list", "message"]
        }
      },
      {
        "id": "dev",
        "name": "Dev Agent",
        "identity": { "name": "Dev", "emoji": "💻" },
        "model": { "primary": "claude-sonnet-4-6" },
        "workspace": "./projects",
        "thinkingDefault": "medium",
        "skills": ["dev-workflow"],
        "subagents": { "allowAgents": ["cicd"], "requireAgentId": true },
        "tools": {
          "allow": ["read", "write", "edit", "exec", "glob", "grep", "sessions_send", "message"]
        }
      },
      {
        "id": "cicd",
        "name": "CI/CD Agent",
        "identity": { "name": "CI/CD", "emoji": "🔧" },
        "model": { "primary": "claude-haiku-4-5" },
        "workspace": "./projects",
        "thinkingDefault": "low",
        "skills": ["cicd-workflow"],
        "subagents": { "allowAgents": [], "requireAgentId": false },
        "tools": {
          "allow": ["read", "exec", "glob", "grep", "sessions_send", "message"]
        }
      }
    ]
  },

  // ═══ 路由綁定 ═══
  "bindings": [
    {
      "agentId": "main",
      "comment": "#general → Main Agent (via main bot)",
      "match": {
        "channel": "discord",
        "accountId": "main",
        "guildId": "YOUR_GUILD_ID",
        "peer": { "kind": "channel", "id": "GENERAL_CHANNEL_ID" }
      }
    },
    {
      "agentId": "main",
      "comment": "main bot fallback",
      "match": { "channel": "discord", "accountId": "main", "guildId": "YOUR_GUILD_ID" }
    }
  ],

  // ═══ Discord 頻道（4 個 Bot Account）═══
  "channels": {
    "discord": {
      "groupPolicy": "open",
      "defaultAccount": "main",
      "accounts": {
        "main": {
          "name": "Main Bot",
          "token": "DISCORD_BOT_TOKEN_MAIN",
          "enabled": true,
          "guilds": { "YOUR_GUILD_ID": {} },
          "threadBindings": {
            "enabled": true,
            "idleHours": 168,
            "maxAgeHours": 720,
            "spawnSubagentSessions": true
          }
        },
        "pm": {
          "name": "PM Bot",
          "token": "DISCORD_BOT_TOKEN_PM",
          "enabled": true,
          "guilds": { "YOUR_GUILD_ID": {} },
          "threadBindings": {
            "enabled": true,
            "idleHours": 168,
            "maxAgeHours": 720,
            "spawnSubagentSessions": true
          }
        },
        "dev": {
          "name": "Dev Bot",
          "token": "DISCORD_BOT_TOKEN_DEV",
          "enabled": true,
          "guilds": { "YOUR_GUILD_ID": {} },
          "threadBindings": {
            "enabled": true,
            "idleHours": 168,
            "maxAgeHours": 720,
            "spawnSubagentSessions": true
          }
        },
        "cicd": {
          "name": "CICD Bot",
          "token": "DISCORD_BOT_TOKEN_CICD",
          "enabled": true,
          "guilds": { "YOUR_GUILD_ID": {} },
          "threadBindings": {
            "enabled": true,
            "idleHours": 168,
            "maxAgeHours": 720,
            "spawnSubagentSessions": true
          }
        }
      }
    }
  },

  // ═══ 跨 Agent 通訊（必要）═══
  "tools": {
    "agentToAgent": { "enabled": true, "allow": ["*"] },
    "sessions": { "visibility": "all" }
  }
}
```

---

## Step 2：建立 Skill 檔案

Skill 檔案路徑由 openclaw 的 skill 搜尋機制決定（通常在 `~/.openclaw/skills/` 或 workspace 下）。

### 2.1 `skills/main-orchestrator/SKILL.md`

```markdown
---
name: main-orchestrator
description: Main Agent 的日常對話與專案初始化工作流程
---

# Main Agent 工作流程

## 你的角色
你是用戶在 #general 頻道的主要對話夥伴，負責：
1. 日常對話和問答
2. 接收專案創建指令，自動建立專案 Forum 和對話通道
3. 將專案上下文和 session key 傳遞給 PM Agent

## 判斷邏輯
- 用戶訊息包含「創建專案」「建立專案」「新專案」等關鍵字 → 執行專案創建流程
- 其他訊息 → 正常日常對話

## 專案創建流程

1. 從用戶訊息中解析：專案名稱、專案描述（可選）
2. 呼叫 project_init tool：
   ```
   project_init({ projectName: "<名稱>", description: "<描述>" })
   ```
3. 從回傳結果取得：
   - forumChannelId
   - threads.userPm.sessionKey (PM 的 session key)
   - threads.pmDev.sessionKey (Dev 的 session key)
   - threads.devCicd.sessionKey (CICD 的 session key)
4. 透過 sessions_send 初始化 PM：
   ```
   sessions_send({
     sessionKey: threads.userPm.sessionKey,
     message: "## 新專案初始化\n\n" +
       "專案名稱：<名稱>\n" +
       "專案描述：<描述>\n\n" +
       "### 你的通訊資訊\n" +
       "- 你的 session (User-PM thread): <pm-session-key>\n" +
       "- Dev session (PM-Dev thread): <dev-session-key>\n" +
       "- CICD session (Dev-CICD thread): <cicd-session-key>\n\n" +
       "請等待用戶在 [User-PM] thread 提出需求後開始工作。"
   })
   ```
5. 在 #general 回覆用戶：
   ```
   ✅ 專案「<名稱>」已建立！

   📁 Forum Channel: <名稱>
   🧵 [User-PM] 專案討論 ← 請到這裡開始討論需求
   🧵 [PM-Dev] 開發任務
   🧵 [Dev-CICD] 建置測試
   ```

## 限制
- 建立完專案後不再參與該專案的後續流程
- 不直接與 Dev 或 CICD 溝通專案事務
- 不要執行 openclaw gateway restart/stop 等命令
```

### 2.2 `skills/pm-workflow/SKILL.md`

```markdown
---
name: pm-workflow
description: PM Agent 的專案管理工作流程
---

# PM Agent 工作流程

## 你的角色
你是專案經理（PM），負責用戶需求分析、任務拆解、進度追蹤、問題協調。

## Session Key（專案初始化時由 Main 提供）
收到初始化訊息後，記住以下 key：
- **Dev session key**：用於 sessions_send 派發任務和接收回報
- **CICD session key**：轉交給 Dev 使用

## 核心流程

### A. 收到用戶需求（用戶在 [User-PM] thread 發言）
1. 確認需求範圍和優先級，必要時追問
2. 拆分為 1-5 個具體任務
3. 為每個任務寫清規格（需求、技術方向、驗收標準）
4. 逐一派發給 Dev：
   ```
   sessions_send({
     sessionKey: "<dev-session-key>",
     message: "## Task-N: <任務名>\n\n" +
       "### 需求\n<詳細需求>\n\n" +
       "### 驗收標準\n<標準列表>\n\n" +
       "### 通訊資訊\n" +
       "- PM session key: <自己的 session key>\n" +
       "- CICD session key: <cicd-session-key>\n\n" +
       "完成後請用 sessions_send 回報。如有問題請上報。"
   })
   ```
5. 在 [User-PM] thread 回覆用戶：已派發 N 個任務

### B. 收到 Dev 回報（Dev 透過 sessions_send 回傳）
- 任務完成 → 記錄進度，匯總後在 [User-PM] thread 更新用戶
- 需要修改 → sessions_send 給 Dev 提供修改指示

### C. 收到 Dev 上報問題
1. 判斷是否需要用戶決策
2. 需要 → 在 [User-PM] thread 向用戶說明問題和選項，等待回覆
3. 不需要 → 直接 sessions_send 給 Dev 提供解決方案
4. 用戶回覆後 → sessions_send 轉達決策給 Dev

### D. 進度匯報格式
```
📊 進度更新：
✅ Task-1: <名稱> (PR #XX, 測試通過)
🔄 Task-2: <名稱> (開發中)
⏳ Task-3: <名稱> (等待中)
整體進度: XX%
```
```

### 2.3 `skills/dev-workflow/SKILL.md`

```markdown
---
name: dev-workflow
description: Dev Agent 的開發工作流程
---

# Dev Agent 工作流程

## 你的角色
你是開發工程師，負責程式碼實作、PR 建立、CICD 派發。

## Session Key（由 PM 在任務訊息中提供）
- **PM session key**：回報進度、上報問題
- **CICD session key**：派發建置測試

## 核心流程

### A. 收到 PM 任務（PM 透過 sessions_send 派發）
1. 分析需求和驗收標準
2. 探索程式碼（read, glob, grep）
3. 實作（write, edit）
4. 本地驗證（exec: 跑測試）
5. 建立 git commit + PR
6. 派發 CICD：
   ```
   sessions_send({
     sessionKey: "<cicd-session-key>",
     message: "## 建置請求\n" +
       "- 分支: <branch-name>\n" +
       "- PR: #<number>\n" +
       "- Dev session key: <自己的 key>（回報結果用）"
   })
   ```
7. 等待 CICD 結果

### B. CICD 回報結果
- ✅ 通過 → 回報 PM：
  ```
  sessions_send({
    sessionKey: "<pm-session-key>",
    message: "✅ Task-N 完成\n- PR: #XX\n- 測試: 全部通過\n- Coverage: XX%"
  })
  ```
- ❌ 失敗 → 嘗試修復，修復後重新派發 CICD
- ❌ 無法修復 → 上報 PM：
  ```
  sessions_send({
    sessionKey: "<pm-session-key>",
    message: "⚠️ 問題上報：Task-N\n" +
      "問題：<描述>\n" +
      "已嘗試：<已嘗試的方案>\n" +
      "需要確認：<需要用戶決策的問題>"
  })
  ```

### C. 收到 PM 修改指示
1. 理解要求 → 修改程式碼 → 更新 PR → 重新派發 CICD
```

### 2.4 `skills/cicd-workflow/SKILL.md`

```markdown
---
name: cicd-workflow
description: CI/CD Agent 的建置測試工作流程
---

# CI/CD Agent 工作流程

## 你的角色
你是 CI/CD 工程師。只做驗證，不做開發。問題只回報給 Dev。

## 核心流程

### 收到建置請求（Dev 透過 sessions_send 派發）
從請求中取得：分支名、PR 編號、Dev session key

執行步驟：
1. `exec: git fetch && git checkout <branch>`
2. `exec: pnpm install`
3. `exec: pnpm check`（lint）
4. `exec: pnpm test`（測試）
5. `exec: pnpm build`（建置）

回報結果給 Dev：
```
sessions_send({
  sessionKey: "<dev-session-key>",
  message: "## 建置報告：PR #XX\n" +
    "- Lint: ✅/❌ <detail>\n" +
    "- Tests: ✅/❌ <pass>/<total>, failures: <list>\n" +
    "- Build: ✅/❌ <detail>\n" +
    "- Coverage: XX%"
})
```

### 規則
- 任一步驟失敗 → 記錄錯誤，跳過後續步驟，回報失敗詳情
- 不修改程式碼，不建議修復方案
- 只與 Dev 通訊，不直接聯繫 PM 或用戶
```

---

## Step 3：Discord Bot 權限設定

4 個 Bot 都需要相同的 Intent 和權限。在 Discord Developer Portal 中為每個 Application 設定：

### Gateway Intents（4 個 Bot 都要開啟）
- `GUILDS`
- `GUILD_MESSAGES`
- `MESSAGE_CONTENT`

### Bot Permissions（4 個 Bot 統一使用相同權限組）
| 權限 | 用途 |
|------|------|
| `MANAGE_CHANNELS` | 動態建立 Forum Channel |
| `SEND_MESSAGES` | 在頻道發送訊息 |
| `SEND_MESSAGES_IN_THREADS` | 在 Thread 中發送訊息 |
| `CREATE_PUBLIC_THREADS` | 在 Forum 中建立 Thread |
| `READ_MESSAGE_HISTORY` | 讀取歷史訊息 |
| `MANAGE_THREADS` | 管理 Thread 設定 |
| `VIEW_CHANNEL` | 檢視頻道 |
| `MANAGE_WEBHOOKS` | Thread Binding Webhook |

---

## Phase 1 驗證

```
[ ] Discord plugin 已啟用（openclaw plugins list → discord: enabled）
[ ] openclaw gateway restart 成功，無 config error
[ ] channels status 顯示 discord 已連線（非空白）
[ ] 4 個 Bot 都上線（Discord 中可見 4 個 Bot 在線）
[ ] 在 #general @Main Bot 發送訊息，Main Agent 回應
[ ] Main Agent 能進行日常對話
```

> **Phase 1 完成後再進入 Phase 2。** 此時 `project_init` tool 不存在，專案創建功能在 Phase 2 實作。

---

# Phase 2：project-orchestrator Plugin

## Step 4：建立 Plugin 目錄結構

路徑：`~/.openclaw/extensions/project-orchestrator/`

```
~/.openclaw/extensions/project-orchestrator/
├── openclaw.plugin.json
├── package.json
└── src/
    └── index.ts
```

### 4.1 `openclaw.plugin.json`

```jsonc
{
  "id": "project-orchestrator",
  "name": "Project Orchestrator",
  "description": "自動建立專案 Forum Channel 和多 Agent 對話通道",
  "enabledByDefault": true,
  "config": {
    "guildId": {
      "type": "string",
      "description": "Discord Server 的 Guild ID"
    }
  }
}
```

### 4.2 `package.json`

```json
{
  "name": "project-orchestrator",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts"
}
```

### 4.3 `src/index.ts` 完整程式碼

> **重要 API 限制**（已踩坑確認）：
> - `api.discord` **不存在** — `OpenClawPluginApi` 沒有 `.discord` 屬性
> - `createThreadDiscord()` 和 `getThreadBindingManager()` 是 Discord extension 內部函數，外部 plugin 無法存取
> - **正確做法**：使用 `fetch()` 直接呼叫 Discord REST API（`https://discord.com/api/v10/`）
> - Bot token 從 `ctx.config` 或環境變數取得

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";

// ═══ Discord REST API 封裝 ═══

const DISCORD_API = "https://discord.com/api/v10";

async function discordApi(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ═══ Token 解析 ═══

function resolveToken(
  config: Record<string, unknown> | undefined,
  accountId: string,
): string {
  // 嘗試從 config 取得指定 account 的 token
  const discord = (config as any)?.channels?.discord;
  const account = discord?.accounts?.[accountId];
  const token = account?.token ?? discord?.token;
  if (token) return String(token);

  // Fallback: 環境變數
  const envKey = `DISCORD_BOT_TOKEN_${accountId.toUpperCase()}`;
  const envToken = process.env[envKey] ?? process.env.DISCORD_BOT_TOKEN;
  if (envToken) return envToken;

  throw new Error(
    `No Discord token found for account "${accountId}". ` +
      `Set it in config (channels.discord.accounts.${accountId}.token) ` +
      `or env (${envKey}).`,
  );
}

// ═══ Plugin Entry ═══

export default definePluginEntry({
  id: "project-orchestrator",
  name: "Project Orchestrator",
  description: "自動建立專案 Forum Channel 和多 Agent 對話通道",
  register(api) {
    const guildId = (api.pluginConfig as any)?.guildId as string | undefined;

    api.registerTool(
      ((ctx) => ({
        name: "project_init",
        description:
          "建立新專案：創建 Discord Forum Channel + 3 個對話 Thread",
        parameters: {
          type: "object" as const,
          properties: {
            projectName: {
              type: "string",
              description: "專案名稱（例：RAG系統）",
            },
            description: {
              type: "string",
              description: "專案簡述",
            },
          },
          required: ["projectName"],
        },

        async execute(params: {
          projectName: string;
          description?: string;
        }) {
          const { projectName, description } = params;
          const guild =
            guildId ?? (api.pluginConfig as any)?.guildId;
          if (!guild) {
            throw new Error(
              "guildId not configured. Set plugins.entries.project-orchestrator.config.guildId",
            );
          }

          // 使用 main bot 的 token（有 MANAGE_CHANNELS 權限）
          const mainToken = resolveToken(
            ctx.config as Record<string, unknown>,
            "main",
          );

          // ═══ 1. 建立 Forum Channel ═══
          // ChannelType.GuildForum = 15
          const forumChannel = await discordApi(
            mainToken,
            "POST",
            `/guilds/${guild}/channels`,
            {
              name: projectName,
              type: 15,
              topic: description ?? `專案：${projectName}`,
            },
          );
          const forumChannelId = forumChannel.id;

          // ═══ 2. 在 Forum 下建立 3 個 Thread ═══
          // Forum thread = POST /channels/{forumId}/threads
          // Forum 要求 message.content 作為首則訊息

          const createForumThread = async (
            name: string,
            content: string,
          ) => {
            return discordApi(
              mainToken,
              "POST",
              `/channels/${forumChannelId}/threads`,
              {
                name,
                auto_archive_duration: 10080, // 7 天
                message: { content }, // Forum 必須有首則訊息
              },
            );
          };

          const userPmThread = await createForumThread(
            "[User-PM] 專案討論",
            `# 專案：${projectName}\n${description ? `> ${description}\n` : ""}\n📋 **用戶與 PM 討論區**\n在此與 PM 溝通需求、確認方向、追蹤進度。`,
          );

          const pmDevThread = await createForumThread(
            "[PM-Dev] 開發任務",
            `# 專案：${projectName}\n\n💻 **PM 與 Dev 協作區**\nPM 在此派發任務規格，Dev 在此回報開發進度。`,
          );

          const devCicdThread = await createForumThread(
            "[Dev-CICD] 建置測試",
            `# 專案：${projectName}\n\n🔧 **Dev 與 CI/CD 協作區**\nDev 在此派發建置請求，CI/CD 在此回報測試結果。`,
          );

          // ═══ 3. 構造 Session Key ═══
          // 格式：agent:<agentId>:discord:<accountId>:channel:<threadId>

          const pmSessionKey = `agent:pm:discord:pm:channel:${userPmThread.id}`;
          const devSessionKey = `agent:dev:discord:dev:channel:${pmDevThread.id}`;
          const cicdSessionKey = `agent:cicd:discord:cicd:channel:${devCicdThread.id}`;

          // ═══ 4. 回傳結果給 Agent ═══
          // Thread Binding 由 openclaw 的 threadBindings.spawnSubagentSessions
          // 和 agent routing 自動處理，不需要手動呼叫 bindTarget()

          return {
            status: "ok",
            projectName,
            forumChannelId,
            threads: {
              userPm: {
                threadId: userPmThread.id,
                sessionKey: pmSessionKey,
                name: "[User-PM] 專案討論",
              },
              pmDev: {
                threadId: pmDevThread.id,
                sessionKey: devSessionKey,
                name: "[PM-Dev] 開發任務",
              },
              devCicd: {
                threadId: devCicdThread.id,
                sessionKey: cicdSessionKey,
                name: "[Dev-CICD] 建置測試",
              },
            },
          };
        },
      })) as OpenClawPluginToolFactory,
      { name: "project_init" },
    );
  },
});
```

> **API 存取方式對照**：
>
> | 方式 | 可用性 | 說明 |
> |------|--------|------|
> | `api.discord.*` | ❌ 不存在 | `OpenClawPluginApi` 沒有 `.discord` 屬性 |
> | `import ... from "openclaw/plugin-sdk/discord"` | ❌ 不存在 | package.json exports 無此 subpath，且有 guardrail test 明確禁止 |
> | `import ... from "../../discord/runtime-api.js"` | ⚠️ 可能可用 | 相對路徑 import（僅限同在 extensions/ 下的 plugin），違反 import boundary 規則 |
> | `fetch("https://discord.com/api/v10/...")` | ✅ 可靠 | 直接 Discord REST API，不依賴任何內部 API |
>
> **本計畫使用 `fetch()` 方式**，這是最可靠且不違反模組邊界的做法。
> Agent 的 plugin 如使用了其他 import 方式且可工作，不影響功能，但可能在 openclaw 升級時 break。

---

## Step 5：啟用 Plugin 並更新 Agent 配置

Plugin 程式碼就緒後，更新 `~/.openclaw/openclaw.json`：

### 5.1 加入 plugin 路徑

```bash
openclaw config set plugins.load.paths '["~/.openclaw/extensions/project-orchestrator"]'
```

或手動在 `openclaw.json` 中加入：

```jsonc
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/project-orchestrator"]
    },
    "entries": {
      "project-orchestrator": {
        "enabled": true,
        "config": {
          "guildId": "YOUR_GUILD_ID"
        }
      }
    }
  }
}
```

### 5.2 更新 Main Agent 的 tool allowlist

在 `agents.list` 中找到 `main` agent，加入 `"project_init"`：

```jsonc
{
  "id": "main",
  // ...
  "tools": {
    "allow": [
      "read", "glob", "grep",
      "sessions_spawn", "sessions_send", "sessions_list",
      "message",
      "project_init"  // ← 新增
    ]
  }
}
```

> Agent `tools.allow` 引用 plugin tool 的三種寫法（擇一）：
> - `"project_init"` — 指定 tool 名稱
> - `"project-orchestrator"` — 允許該 plugin 所有 tool
> - `"group:plugins"` — 允許所有 plugin tool

### 5.3 重啟 gateway

**由用戶（人類）執行**：

```bash
openclaw gateway restart
```

---

## Phase 2 驗證

### 驗證 Plugin 載入
```
[ ] openclaw plugins list → project-orchestrator: enabled
[ ] gateway 啟動無 error（無 "plugin path not found" 等錯誤）
[ ] Main Agent 的可用 tool 中包含 project_init
```

### 驗證專案創建
```
[ ] 在 #general 發送「@Main Bot 幫我創建專案，測試專案」
[ ] Main 呼叫 project_init → Forum Channel「測試專案」已建立
[ ] Forum 下有 3 個 Thread：[User-PM]、[PM-Dev]、[Dev-CICD]
[ ] 每個 Thread 有 introText 開場白
[ ] Main 回覆包含 Forum 和 Thread 資訊
```

### 驗證 Thread Binding 路由
```
[ ] 在 [User-PM] thread 發言 → PM Bot 回應（非 Main Bot）
[ ] 在 [PM-Dev] thread 發言 → Dev Bot 回應
[ ] 在 [Dev-CICD] thread 發言 → CICD Bot 回應
```

### 驗證 Agent 間通訊
```
[ ] 在 [User-PM] 向 PM 提需求 → PM 用 sessions_send 派發給 Dev
[ ] Dev 的回應出現在 [PM-Dev] thread（由 Dev Bot 發送）
[ ] Dev 用 sessions_send 派發 CICD → CICD 回應出現在 [Dev-CICD] thread
[ ] CICD 結果回傳給 Dev → Dev 回報 PM → PM 在 [User-PM] thread 匯報用戶
```

### 驗證錯誤上報
```
[ ] 模擬 CICD 失敗 → Dev 收到失敗通知
[ ] Dev 上報 PM → PM 在 [User-PM] thread 詢問用戶
[ ] 用戶回覆 → PM 轉達 Dev → Dev 繼續
```

### 驗證專案隔離
```
[ ] 建立第二個專案 → 新的 Forum Channel + 3 Threads
[ ] 兩個專案的 Agent 對話互不干擾
[ ] 各自的 session 獨立，context 不混用
```

---

## 故障排除

| 症狀 | 可能原因 | 解法 |
|------|---------|------|
| gateway 啟動失敗：plugin path not found | plugin 目錄不存在或路徑錯誤 | 確認 `~/.openclaw/extensions/project-orchestrator/` 存在 |
| gateway 啟動失敗：config invalid | 配置格式錯誤 | 執行 `openclaw doctor --fix` |
| discord channels 表格空白 | Discord plugin 未啟用 | `openclaw config set plugins.entries.discord.enabled true` |
| Forum 建立失敗 | Main Bot 缺少 `MANAGE_CHANNELS` 權限 | 在 Discord Developer Portal 重新設定權限 |
| `project_init` tool 不在可用清單 | plugin 未載入 / tool 名稱不在 allowlist | 確認 plugin enabled + `tools.allow` 含 `"project_init"` |
| Thread 中 Agent 不回應 | Thread Binding 未設定 / 已過期 | 檢查 `bindTarget()` 是否成功執行 |
| `sessions_send` 被拒絕 | 跨 Agent 通訊未開啟 | 確認 `agentToAgent.enabled: true` 和 `sessions.visibility: "all"` |
| Agent 回應由錯誤 Bot 發送 | Session Key 的 accountId 不正確 | 檢查格式 `agent:<id>:discord:<account>:channel:<threadId>` |
| 動態 Forum 無法被 Bot 監聽 | `groupPolicy` 不是 `"open"` | 設定 `groupPolicy: "open"` |
| Thread Binding 過期 | `maxAgeHours` 太短 | 調大至 720（30天）或更長 |
| exec 被 SIGTERM 中斷 | Agent 嘗試重啟 gateway | **Agent 禁止執行 gateway 管理命令** |
