# 多 Agent 角色扮演全自動開發架構設計（v2）

> 分析日期：2026-04-05
> 基於 openclaw 原始碼調查，設計 Main / PM / Dev / CI-CD 四角色 Agent 協作架構
> 平台：Discord Forum（私人 Server）

---

## 目標

- 4 個 Agent（Main、PM、Dev、CI/CD）各司其職，自動協作開發
- 用戶在一般文字頻道與 Main Bot 日常對話、下達「創建專案」指令
- Main Bot 自動建立該專案的 **Forum Channel** 和 3 個對話 **Threads**
- 每個專案 = 一個獨立 Forum Channel，下轄 3 個 Thread（User↔PM、PM↔Dev、Dev↔CICD）
- Agent 間對話全程自動化，所有溝通在 Discord 可見可追溯
- 任何步驟有問題，自動上報至 PM，由 PM 與用戶溝通
- 專案間 context 完全隔離（不同 Forum = 不同 session）

---

## 整體架構圖

```
Discord Server（私人）
│
├── #general (文字頻道)                     ← Main Agent 監聽
│     👤 你：「早安」
│     🤖 Main：「早安！有什麼需要幫忙的嗎？」
│     👤 你：「幫我創建專案，RAG系統」
│     🤖 Main：「✅ 專案已建立！
│               📁 Forum: RAG系統
│               🧵 Thread 1: User-PM 專案討論
│               🧵 Thread 2: PM-Dev 開發任務
│               🧵 Thread 3: Dev-CICD 建置測試
│               請到 User-PM thread 開始討論需求。」
│
├── 📁 RAG系統 (Forum Channel)              ← 專案 A 的獨立 Forum
│   │
│   ├── 🧵 [User-PM] 專案討論               ← Thread 1 (PM Agent 綁定)
│   │     👤 你：「我需要一個用 LangChain 的 RAG 系統」
│   │     🤖 PM：「了解，我來拆分任務...」
│   │     🤖 PM：「已派發 3 個任務給 Dev」
│   │     🤖 PM：「⚠️ Dev 回報：向量 DB 選型需確認」
│   │     👤 你：「用 Qdrant」
│   │     🤖 PM：「收到，已轉達 Dev」
│   │
│   ├── 🧵 [PM-Dev] 開發任務                ← Thread 2 (Dev Agent 綁定)
│   │     🤖 PM：「Task-1 規格：文件解析 pipeline...」
│   │     🤖 Dev：「收到，開始實作...」
│   │     🤖 Dev：「Task-1 完成，PR #42 已建立」
│   │     🤖 PM：「Task-2 規格：Qdrant 整合...」
│   │
│   └── 🧵 [Dev-CICD] 建置測試              ← Thread 3 (CICD Agent 綁定)
│         🤖 Dev：「請建置 PR #42」
│         🤖 CICD：「✅ Tests pass. Coverage: 87%」
│         🤖 Dev：「請建置 PR #43」
│         🤖 CICD：「❌ Build failed: 2 test failures」
│
├── 📁 Auth重構 (Forum Channel)             ← 專案 B 的獨立 Forum
│   ├── 🧵 [User-PM] 專案討論
│   ├── 🧵 [PM-Dev] 開發任務
│   └── 🧵 [Dev-CICD] 建置測試
│
└── #agent-logs (文字頻道，可選)
    └── 系統日誌、錯誤通知等
```

---

## 核心設計原則

### 1. 一個專案 = 一個 Forum Channel

每個專案擁有獨立的 Discord Forum Channel，其下包含 3 個 Thread 作為不同 agent 對之間的溝通通道。
此結構已驗證可行。

- `User-PM` Thread：用戶與 PM 溝通需求、追蹤進度
- `PM-Dev` Thread：PM 派發任務給 Dev、Dev 回報進度
- `Dev-CICD` Thread：Dev 派發建置請求、CICD 回報結果

### 2. 專案隔離 = Forum Channel 隔離

OpenClaw 的路由機制中，每個 Discord Thread 會自動產生獨立的 `sessionKey`：

```
sessionKey 格式: agent:<agentId>:discord:<accountId>:<threadId>
```

- 不同 Forum 的 Thread → 不同 threadId → 不同 sessionKey
- **不需要額外隔離機制**，框架原生支援

### 3. Agent 間通訊 = `sessions_send` + Thread Binding

Agent 間使用 `sessions_send` 跨 session 通訊，每個 session 綁定到對應的 Thread：

```
PM 呼叫 sessions_send(devSessionKey, message)
  → 訊息送到 Dev 的 session
  → Dev 的 session 綁定到 [PM-Dev] Thread
  → Dev 回覆可見於該 Thread
```

需啟用跨 agent 通訊配置：
- `agentToAgent.enabled: true`
- `sessions.visibility: "all"`

### 4. 自動專案初始化 = Main Agent + `project_init` Tool

Main Agent 監聽 `#general` 文字頻道，兼任日常對話和專案創建：
1. 收到創建指令 → 呼叫 `project_init` tool
2. `project_init` 建立新的 Forum Channel + 3 個 Thread
3. 設定 Thread Binding（每個 Thread 綁定對應 agent 的 session）
4. 將 session key 資訊傳遞給 PM，啟動專案

### 5. 錯誤上報鏈

```
CICD 遇到問題 → sessions_send → Dev
Dev 無法解決  → sessions_send → PM
PM 與用戶溝通 → 在 [User-PM] Thread 回覆用戶
用戶決策後    → PM → sessions_send → Dev → 繼續
```

---

## 配置方案

### Step 1：定義四個 Agent

```jsonc
// ~/.openclaw/openclaw.json
{
  "agents": {
    "list": [
      // ── Main Agent：日常對話 + 專案初始化 ──
      {
        "id": "main",
        "name": "Main Agent",
        "default": true,
        "identity": {
          "name": "Main",
          "emoji": "🚀"
        },
        "model": {
          "primary": "claude-sonnet-4-6"   // 需處理日常對話，用中等模型
        },
        "workspace": "./projects",
        "thinkingDefault": "medium",
        "skills": ["main-orchestrator"],
        "subagents": {
          "allowAgents": ["pm", "dev", "cicd"],
          "requireAgentId": true
        },
        "tools": {
          "allow": [
            "read", "glob", "grep",
            "sessions_spawn", "sessions_send", "sessions_list",
            "message", "project_init"      // 自訂 tool
          ]
        }
      },

      // ── PM Agent：專案管理 ──
      {
        "id": "pm",
        "name": "PM Agent",
        "identity": {
          "name": "PM",
          "emoji": "📋"
        },
        "model": {
          "primary": "claude-opus-4-6"     // PM 需要強推理
        },
        "workspace": "./projects",
        "thinkingDefault": "high",
        "skills": ["pm-workflow"],
        "subagents": {
          "allowAgents": ["dev"],
          "requireAgentId": true
        },
        "tools": {
          "allow": [
            "read", "write", "edit", "glob", "grep",
            "sessions_send", "sessions_list",
            "message"
          ]
        }
      },

      // ── Dev Agent：開發工程師 ──
      {
        "id": "dev",
        "name": "Dev Agent",
        "identity": {
          "name": "Dev",
          "emoji": "💻"
        },
        "model": {
          "primary": "claude-sonnet-4-6"
        },
        "workspace": "./projects",
        "thinkingDefault": "medium",
        "skills": ["dev-workflow"],
        "subagents": {
          "allowAgents": ["cicd"],
          "requireAgentId": true
        },
        "tools": {
          "allow": [
            "read", "write", "edit", "exec", "glob", "grep",
            "sessions_send", "message"
          ]
        }
      },

      // ── CICD Agent：建置測試 ──
      {
        "id": "cicd",
        "name": "CI/CD Agent",
        "identity": {
          "name": "CI/CD",
          "emoji": "🔧"
        },
        "model": {
          "primary": "claude-haiku-4-5"    // CI/CD 用快速模型
        },
        "workspace": "./projects",
        "thinkingDefault": "low",
        "skills": ["cicd-workflow"],
        "subagents": {
          "allowAgents": [],               // 葉節點，不再派發
          "requireAgentId": false
        },
        "tools": {
          "allow": [
            "read", "exec", "glob", "grep",
            "sessions_send", "message"
          ]
        }
      }
    ]
  }
}
```

### Step 2：設定 Discord 路由綁定

```jsonc
{
  "bindings": [
    // ── Main Agent：監聽 #general 文字頻道（日常對話 + 專案創建）──
    {
      "agentId": "main",
      "comment": "Main Bot 監聽 #general",
      "match": {
        "channel": "discord",
        "accountId": "main",               // 指定 main bot account
        "guildId": "YOUR_GUILD_ID",
        "peer": {
          "kind": "channel",
          "id": "GENERAL_CHANNEL_ID"
        }
      }
    },

    // ── Main Bot Fallback ──
    {
      "agentId": "main",
      "comment": "main bot fallback",
      "match": {
        "channel": "discord",
        "accountId": "main",
        "guildId": "YOUR_GUILD_ID"
      }
    }
  ]
}
```

> **注意**：各專案 Forum 下的 Thread 路由完全由 Thread Binding 動態管理。
> `project_init` tool 在建立 Thread 時自動設定 binding，不需要靜態配置。
> Binding 的 `accountId` 對應 `channels.discord.accounts` 中的 key。

### Step 3：Discord Channel 設定

```jsonc
{
  // ── 4 個獨立 Discord Bot，每個 Agent 一個 ──
  // 好處：獨立 username/avatar、打字指示器、session 天然隔離
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

  // ── 跨 Agent 通訊必要設定 ──
  "tools": {
    "agentToAgent": {
      "enabled": true,
      "allow": ["*"]
    },
    "sessions": {
      "visibility": "all"
    }
  }
}
```

---

## Step 4：建立 Skill 定義（角色行為指導）

### Main Orchestrator Skill (`skills/main-orchestrator/SKILL.md`)

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

## 工作流程

### 日常對話
正常回應用戶的問題和對話，不需要特殊處理。

### 收到創建專案指令時
辨識用戶意圖為創建專案（例：「幫我創建專案，RAG系統」），然後：

1. 解析專案名稱和簡述
2. 呼叫 `project_init` tool：
   ```
   project_init({
     projectName: "RAG系統",
     description: "使用 LangChain 的 RAG 檢索增強生成系統"
   })
   ```
3. 取得回傳的 Forum Channel ID、3 個 Thread ID 和 session key
4. 使用 `sessions_send` 通知 PM Agent 啟動專案：
   ```
   sessions_send({
     sessionKey: "<pm-session-key>",
     message: "新專案已建立：RAG系統\n\n" +
       "專案描述：...\n" +
       "你的對話通道：[User-PM] thread\n" +
       "Dev session key: <dev-session-key>\n" +
       "CICD session key: <cicd-session-key>\n\n" +
       "請等待用戶在 [User-PM] thread 提出需求。"
   })
   ```
5. 在 #general 回覆用戶：
   - 專案已建立
   - 列出 Forum 和 3 個 Thread 連結
   - 引導用戶到 [User-PM] thread 開始溝通

### 不做的事
- 不參與專案開發過程
- 建立完專案後即完成，後續由 PM 接手
```

### PM Skill (`skills/pm-workflow/SKILL.md`)

```markdown
---
name: pm-workflow
description: PM Agent 的專案管理工作流程
---

# PM Agent 工作流程

## 你的角色
你是專案經理（PM），負責：
1. 在 [User-PM] thread 與用戶討論需求、確認方向
2. 將需求拆解為可執行的開發任務
3. 透過 sessions_send 派發任務給 Dev（訊息會出現在 [PM-Dev] thread）
4. 追蹤任務進度，匯報給用戶
5. 接收 Dev 上報的問題，與用戶溝通解決

## Session Key 管理
- 你會在專案初始化時收到 Dev 和 CICD 的 session key
- **務必記住這些 key**，後續派發任務時需要使用

## 工作流程

### 收到用戶需求時（來自 [User-PM] thread）
1. 確認需求範圍和優先級
2. 拆分為 1-5 個具體開發任務
3. 為每個任務撰寫清晰的規格說明
4. 使用 sessions_send 逐一派發給 Dev：
   ```
   sessions_send({
     sessionKey: "<dev-session-key>",
     message: "## Task-1: 文件解析 Pipeline\n\n" +
       "### 需求\n...\n" +
       "### 驗收標準\n...\n" +
       "### CICD session key: <cicd-session-key>\n" +
       "完成後請回報，如有問題請上報。"
   })
   ```
5. 在 [User-PM] thread 告知用戶任務已派發

### 收到 Dev 完成通知時
1. 審查產出（PR、程式碼變更摘要）
2. 如需修改，用 sessions_send 回饋給 Dev
3. 全部任務完成後，在 [User-PM] thread 匯報給用戶

### 收到 Dev 上報問題時
1. 判斷是否需要用戶決策
2. 如需用戶決策：在 [User-PM] thread 詢問用戶
3. 取得用戶回覆後：用 sessions_send 轉達給 Dev
4. 如不需用戶決策：直接指導 Dev 解決

### 溝通規範
- 對用戶（[User-PM]）：簡潔、結構化，使用列表和進度指標
- 對 Dev（sessions_send）：精確、包含具體技術規格和驗收標準
```

### Dev Skill (`skills/dev-workflow/SKILL.md`)

```markdown
---
name: dev-workflow
description: Dev Agent 的開發工作流程
---

# Dev Agent 工作流程

## 你的角色
你是開發工程師，負責：
1. 接收 PM 派發的開發任務
2. 閱讀程式碼、理解架構
3. 實作功能或修復 Bug
4. 建立 PR 並確保程式碼品質
5. 透過 sessions_send 派發 CI/CD 任務進行建置測試
6. 無法解決的問題上報給 PM

## Session Key 管理
- PM session key: 用於回報進度和上報問題
- CICD session key: PM 在任務中提供，用於派發建置測試

## 工作流程

### 收到 PM 任務時（訊息出現在 [PM-Dev] thread）
1. 分析任務需求和驗收標準
2. 探索相關程式碼（read, glob, grep）
3. 實作變更（write, edit）
4. 本地驗證（exec 執行測試）
5. 建立 Git commit 和 PR
6. 派發 CI/CD 檢查：
   ```
   sessions_send({
     sessionKey: "<cicd-session-key>",
     message: "請建置並測試分支 feature/rag-parser，PR #42\n" +
       "Dev session key: <自己的 session key>\n" +
       "完成後請回報結果。"
   })
   ```
7. 等待 CICD 結果

### 收到 CICD 結果時
- ✅ 通過：用 sessions_send 通知 PM 任務完成
- ❌ 失敗：
  1. 嘗試修復問題
  2. 修復後重新派發 CICD
  3. 如無法修復，上報給 PM：
     ```
     sessions_send({
       sessionKey: "<pm-session-key>",
       message: "⚠️ 問題上報：Task-1 的測試失敗，\n" +
         "原因：...\n需要確認：...\n" +
         "請與用戶確認方向。"
     })
     ```

### 收到 PM 修改回饋時
1. 理解修改要求
2. 執行修改
3. 更新 PR
4. 重新觸發 CI/CD
```

### CI/CD Skill (`skills/cicd-workflow/SKILL.md`)

```markdown
---
name: cicd-workflow
description: CI/CD Agent 的建置測試工作流程
---

# CI/CD Agent 工作流程

## 你的角色
你是 CI/CD 工程師，負責：
1. 執行建置和測試
2. 回報結果（通過/失敗/覆蓋率）
3. 不做開發，只做驗證
4. 問題回報給 Dev（不直接與 PM 或用戶溝通）

## 工作流程

### 收到建置請求時（訊息出現在 [Dev-CICD] thread）
1. 切換到指定分支（exec: git checkout）
2. 安裝依賴（exec: pnpm install）
3. 執行 lint（exec: pnpm check）
4. 執行測試（exec: pnpm test）
5. 檢查建置（exec: pnpm build）
6. 用 sessions_send 回報結果給 Dev：
   ```
   sessions_send({
     sessionKey: "<dev-session-key>",
     message: "## 建置報告：PR #42\n" +
       "- Lint: ✅ Pass\n" +
       "- Tests: ✅ 142/142 pass\n" +
       "- Build: ✅ Success\n" +
       "- Coverage: 89%"
   })
   ```

### 失敗時的回報格式
```
sessions_send({
  sessionKey: "<dev-session-key>",
  message: "## 建置報告：PR #42\n" +
    "- Lint: ✅ Pass\n" +
    "- Tests: ❌ 3 failures\n" +
    "  - test/parser.test.ts: TypeError at line 42\n" +
    "  - test/embed.test.ts: Timeout after 5000ms\n" +
    "  - test/api.test.ts: Expected 200, got 500\n" +
    "- Build: ⏭️ Skipped (tests failed)\n\n" +
    "請修復後重新提交。"
})
```
```

---

## Step 5：Plugin 實現自動專案初始化

### 自訂 Plugin：`project-orchestrator`

```typescript
// extensions/project-orchestrator/src/index.ts

import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";

export default {
  register(api) {
    // ── 註冊 project_init Tool ──
    api.registerTool({
      name: "project_init",
      description: "建立新專案：創建 Forum Channel + 3 個對話 Thread",
      parameters: {
        type: "object",
        properties: {
          projectName: {
            type: "string",
            description: "專案名稱（例：RAG系統）"
          },
          description: {
            type: "string",
            description: "專案簡述"
          }
        },
        required: ["projectName"]
      },

      async handler(params, ctx) {
        const { projectName, description } = params;
        const guildId = ctx.config.get("projectOrchestrator.guildId");
        const accountId = ctx.config.get("projectOrchestrator.discordAccountId");

        // ── 1. 建立 Forum Channel ──
        // 使用 Discord REST API 在 guild 下建立新的 Forum Channel

        const forumChannel = await ctx.discord.rest.post(
          `/guilds/${guildId}/channels`,
          {
            body: {
              name: projectName,
              type: 15,  // ChannelType.GuildForum
              topic: description ?? `專案：${projectName}`,
              // 可設定預設的 Forum Tags
              available_tags: [
                { name: "User-PM", moderated: false },
                { name: "PM-Dev", moderated: false },
                { name: "Dev-CICD", moderated: false },
              ],
            },
          }
        );

        const forumChannelId = forumChannel.id;

        // ── 2. 在 Forum 下建立 3 個 Thread（Forum Post）──

        const createForumThread = ctx.discord.createThreadDiscord;

        // Thread 1: [User-PM] 專案討論
        const userPmThread = await createForumThread(forumChannelId, {
          name: `[User-PM] 專案討論`,
          content: [
            `# 專案：${projectName}`,
            description ? `> ${description}` : "",
            "",
            "📋 **用戶與 PM 討論區**",
            "在此 thread 與 PM 溝通需求、確認方向、追蹤進度。",
          ].filter(Boolean).join("\n"),
          autoArchiveDuration: 10080, // 7 天
        });

        // Thread 2: [PM-Dev] 開發任務
        const pmDevThread = await createForumThread(forumChannelId, {
          name: `[PM-Dev] 開發任務`,
          content: [
            `# 專案：${projectName}`,
            "",
            "💻 **PM 與 Dev 協作區**",
            "PM 在此派發任務規格，Dev 在此回報開發進度。",
          ].join("\n"),
          autoArchiveDuration: 10080,
        });

        // Thread 3: [Dev-CICD] 建置測試
        const devCicdThread = await createForumThread(forumChannelId, {
          name: `[Dev-CICD] 建置測試`,
          content: [
            `# 專案：${projectName}`,
            "",
            "🔧 **Dev 與 CI/CD 協作區**",
            "Dev 在此派發建置請求，CI/CD 在此回報測試結果。",
          ].join("\n"),
          autoArchiveDuration: 10080,
        });

        // ── 3. 構造 Session Key ──
        // 每個 agent 使用對應的 accountId（pm/dev/cicd）

        const pmSessionKey =
          `agent:pm:discord:pm:channel:${userPmThread.id}`;
        const devSessionKey =
          `agent:dev:discord:dev:channel:${pmDevThread.id}`;
        const cicdSessionKey =
          `agent:cicd:discord:cicd:channel:${devCicdThread.id}`;

        // ── 4. 建立 Thread Binding ──
        // 每個 thread 綁定到對應 agent 的 bot account

        const pmBindingManager = ctx.discord.getThreadBindingManager("pm");
        await pmBindingManager.bindTarget({
          threadId: userPmThread.id,
          channelId: forumChannelId,
          targetSessionKey: pmSessionKey,
          agentId: "pm",
          label: `[${projectName}] User-PM`,
          introText: `PM 已就緒，等待用戶需求。`,
        });

        const devBindingManager = ctx.discord.getThreadBindingManager("dev");
        await devBindingManager.bindTarget({
          threadId: pmDevThread.id,
          channelId: forumChannelId,
          targetSessionKey: devSessionKey,
          agentId: "dev",
          label: `[${projectName}] PM-Dev`,
          introText: `Dev 已就緒，等待 PM 派發任務。`,
        });

        const cicdBindingManager = ctx.discord.getThreadBindingManager("cicd");
        await cicdBindingManager.bindTarget({
          threadId: devCicdThread.id,
          channelId: forumChannelId,
          targetSessionKey: cicdSessionKey,
          agentId: "cicd",
          label: `[${projectName}] Dev-CICD`,
          introText: `CI/CD 已就緒，等待 Dev 派發建置請求。`,
        });

        // ── 5. 回傳結果 ──

        return {
          status: "ok",
          projectName,
          forumChannelId,
          threads: {
            userPm: {
              threadId: userPmThread.id,
              sessionKey: pmSessionKey,
              name: `[User-PM] 專案討論`,
            },
            pmDev: {
              threadId: pmDevThread.id,
              sessionKey: devSessionKey,
              name: `[PM-Dev] 開發任務`,
            },
            devCicd: {
              threadId: devCicdThread.id,
              sessionKey: cicdSessionKey,
              name: `[Dev-CICD] 建置測試`,
            },
          },
        };
      },
    });
  },
} satisfies OpenClawPluginDefinition;
```

### Plugin 清單

```jsonc
// extensions/project-orchestrator/openclaw.plugin.json
{
  "id": "project-orchestrator",
  "name": "Project Orchestrator",
  "description": "自動建立專案 Forum Channel 和多 Agent 對話通道",
  "enabledByDefault": true,
  "config": {
    "guildId": {
      "type": "string",
      "description": "Discord Server 的 Guild ID"
    },
    "discordAccountId": {
      "type": "string",
      "description": "Discord Bot 的 Account ID",
      "default": "discord"
    }
  }
}
```

---

## 完整流程圖：從創建專案到開發完成

```
Phase 1: 專案創建（#general 文字頻道）
═══════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────┐
│ #general                                                │
│                                                         │
│  👤 你：「幫我創建專案，RAG系統」                          │
│                                                         │
│  ┌──── 路由：#general → Main Agent ─────────┐           │
│  │  binding: peer.id = GENERAL_CHANNEL_ID    │           │
│  │  agentId: main                            │           │
│  └───────────────────────────────────────────┘           │
│                                                         │
│  🤖 Main 內部執行:                                       │
│  project_init({ projectName: "RAG系統" })                │
│    → 建立 Forum Channel: 📁 RAG系統                      │
│    → 建立 Thread 1: 🧵 [User-PM] 專案討論                │
│    → 建立 Thread 2: 🧵 [PM-Dev] 開發任務                 │
│    → 建立 Thread 3: 🧵 [Dev-CICD] 建置測試               │
│    → 設定 Thread Binding × 3                             │
│    → 回傳 session keys                                   │
│                                                         │
│  🤖 Main 內部執行:                                       │
│  sessions_send(pmSessionKey, "新專案：RAG系統...")         │
│    → PM session 啟動，收到 Dev/CICD session key           │
│                                                         │
│  🤖 Main：「✅ 專案 RAG系統 已建立！                      │
│     📁 Forum: RAG系統                                    │
│     🧵 User-PM: [連結] ← 請到這裡討論需求                 │
│     🧵 PM-Dev: [連結]                                    │
│     🧵 Dev-CICD: [連結]」                                │
│                                                         │
└─────────────────────────────────────────────────────────┘


Phase 2: 需求溝通（📁 RAG系統 Forum）
═══════════════════════════════════════════════════════════════

🧵 [User-PM] 專案討論
┌─────────────────────────────────────────────────────────┐
│  ┌──── Thread Binding → PM Agent ────┐                  │
│  │  agentId: pm                       │                  │
│  └────────────────────────────────────┘                  │
│                                                         │
│  👤 你：「我需要一個 RAG 系統，                            │
│         用 LangChain + Qdrant，                          │
│         支援 PDF/DOCX 文件上傳」                          │
│                                                         │
│  🤖 PM：「了解！我把這拆成 3 個任務：                      │
│     1. 📄 文件解析 Pipeline                              │
│     2. 🗄️ Qdrant 向量 DB 整合                           │
│     3. 🔍 RAG 查詢 API                                  │
│     正在派發給 Dev...」                                   │
│                                                         │
│  PM 內部: sessions_send(devSessionKey, "Task-1...")       │
│                                                         │
│  🤖 PM：「已派發 3 個任務，Dev 開始開發中。」               │
│                                                         │
└─────────────────────────────────────────────────────────┘


Phase 3: 開發執行
═══════════════════════════════════════════════════════════════

🧵 [PM-Dev] 開發任務
┌─────────────────────────────────────────────────────────┐
│  ┌──── Thread Binding → Dev Agent ────┐                 │
│  │  agentId: dev                       │                 │
│  └─────────────────────────────────────┘                 │
│                                                         │
│  🤖 PM（via sessions_send）：                             │
│  「## Task-1: 文件解析 Pipeline                           │
│    ### 需求                                              │
│    - 支援 PDF、DOCX                                     │
│    - LangChain document loaders                          │
│    ### CICD session key: <cicd-key>」                    │
│                                                         │
│  🤖 Dev：「收到，開始實作...」                             │
│  🤖 Dev：「Task-1 完成，PR #42，派發 CICD...」            │
│                                                         │
│  Dev 內部: sessions_send(cicdSessionKey, "建置 PR #42")   │
│  ... 等待 CICD ...                                       │
│  Dev 內部: sessions_send(pmSessionKey, "Task-1 ✅")       │
│                                                         │
└─────────────────────────────────────────────────────────┘


Phase 4: 建置測試
═══════════════════════════════════════════════════════════════

🧵 [Dev-CICD] 建置測試
┌─────────────────────────────────────────────────────────┐
│  ┌──── Thread Binding → CICD Agent ────┐                │
│  │  agentId: cicd                       │                │
│  └──────────────────────────────────────┘                │
│                                                         │
│  🤖 Dev（via sessions_send）：                            │
│  「請建置並測試 PR #42」                                   │
│                                                         │
│  🤖 CICD：「## 建置報告：PR #42                           │
│     - Lint: ✅  Tests: ✅ 38/38  Build: ✅               │
│     - Coverage: 87%」                                    │
│                                                         │
│  CICD 內部: sessions_send(devSessionKey, "PR #42 ✅")     │
│                                                         │
└─────────────────────────────────────────────────────────┘


Phase 5: 進度匯報（回到 User-PM thread）
═══════════════════════════════════════════════════════════════

🧵 [User-PM] 專案討論
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  🤖 PM：「📊 進度更新：                                   │
│     ✅ Task-1: 文件解析 Pipeline (PR #42, 測試通過)       │
│     🔄 Task-2: Qdrant 整合 (開發中)                      │
│     ⏳ Task-3: RAG 查詢 API (等待中)                     │
│     整體進度: 33%」                                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 錯誤上報流程

```
                     錯誤上報鏈

  CICD 建置失敗                     Dev 遇到阻礙
       │                                │
       ▼                                │
  sessions_send                         │
  → Dev session                         │
  (訊息出現在 [Dev-CICD] thread)         │
       │                                │
       ▼                                ▼
  ┌──────────────────────────────────────────┐
  │ Dev 收到問題                               │
  │                                           │
  │ 判斷：能否自行解決？                        │
  │  ├── ✅ 能：修復後重新派發 CICD              │
  │  └── ❌ 不能：上報給 PM                     │
  │       sessions_send(pmSessionKey, "⚠️...") │
  │       (訊息出現在 [PM-Dev] thread)          │
  └──────────────────────┬────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────┐
  │ PM 收到上報                                │
  │                                           │
  │ 判斷：是否需要用戶決策？                     │
  │  ├── ✅ 需要：在 [User-PM] thread 詢問用戶  │
  │  │   👤 用戶回覆決策                        │
  │  │   PM sessions_send → Dev 轉達決策        │
  │  └── ❌ 不需要：直接指導 Dev 解決            │
  │       PM sessions_send → Dev 提供方案        │
  └──────────────────────────────────────────┘


範例：向量 DB 選型問題

  🧵 [Dev-CICD] thread:
  🤖 CICD：「❌ 測試失敗：pinecone SDK 版本不相容」
  CICD → sessions_send → Dev

  🧵 [PM-Dev] thread:
  🤖 Dev：「⚠️ Pinecone SDK 有相容性問題，建議改用 Qdrant 或 Milvus」
  Dev → sessions_send → PM

  🧵 [User-PM] thread:
  🤖 PM：「⚠️ Dev 回報：Pinecone SDK 有相容性問題。
          建議替代方案：
          1. Qdrant（開源，可自建）
          2. Milvus（開源，功能豐富）
          請確認方向。」
  👤 你：「用 Qdrant」
  🤖 PM：「收到，通知 Dev 改用 Qdrant。」
  PM → sessions_send → Dev
```

---

## Context 隔離機制

```
                    Session 隔離圖

📁 Forum: RAG系統                        📁 Forum: Auth重構
Thread IDs: T1001, T1002, T1003          Thread IDs: T2001, T2002, T2003
┌──────────────────────────────┐         ┌──────────────────────────────┐
│                              │         │                              │
│ PM Session (account: pm)     │         │ PM Session (account: pm)     │
│ key: agent:pm:discord:pm:T1001│        │ key: agent:pm:discord:pm:T2001│
│ bound: [User-PM] thread      │         │ bound: [User-PM] thread      │
│                              │         │                              │
│ Dev Session (account: dev)   │         │ Dev Session (account: dev)   │
│ key: agent:dev:discord:dev:T1002│      │ key: agent:dev:discord:dev:T2002│
│ bound: [PM-Dev] thread       │         │ bound: [PM-Dev] thread       │
│                              │         │                              │
│ CICD Session (account: cicd) │         │ CICD Session (account: cicd) │
│ key: agent:cicd:discord:cicd:T1003│    │ key: agent:cicd:discord:cicd:T2003│
│ bound: [Dev-CICD] thread     │         │ bound: [Dev-CICD] thread     │
│                              │         │                              │
└──────────────────────────────┘         └──────────────────────────────┘
         完全獨立，互不污染                          完全獨立，互不污染
```

**隔離保證來自：**
1. **不同 Forum Channel** → 不同 Thread → 不同 threadId → 不同 sessionKey
2. **Thread Binding** → 每個 Thread 綁定到特定 agent 的特定 session
3. **workspace 可按專案配置** → 檔案系統層面隔離
4. **session 可見性守衛** → Agent 只能存取被授權的 session

---

## 關鍵 OpenClaw 機制對照

| 需求 | 使用的 OpenClaw 機制 | 關鍵檔案 |
|------|---------------------|---------|
| 4 個角色 Agent | `agents.list[]` 配置 | `src/config/types.agents.ts` |
| Agent 角色行為 | Skill (`SKILL.md`) | `src/agents/skills/` |
| Agent 身份識別 | `identity` 配置（name, emoji） | `src/config/types.agents.ts` |
| Main 監聽 #general | `bindings[]` + peer.id 匹配 | `src/routing/resolve-route.ts` |
| 動態建立 Forum Channel | Discord REST API (`POST /guilds/{id}/channels`) | Discord API |
| Forum 下建立 Thread | `createThreadDiscord` (Forum-aware) | `extensions/discord/src/send.messages.ts` |
| Thread Binding | `ThreadBindingManager.bindTarget()` | `extensions/discord/src/monitor/thread-bindings.manager.ts` |
| 自動專案初始化 | 自訂 Plugin + `project_init` tool | `extensions/project-orchestrator/` |
| Agent 間通訊 | `sessions_send` tool | `src/agents/tools/sessions-send-tool.ts` |
| 跨 Agent 通訊授權 | `agentToAgent.enabled` 配置 | `src/config/types.tools.ts` |
| 對話可見性 | Discord Thread 天然可見 | Discord 平台特性 |
| 專案隔離 | Forum Channel → threadId → sessionKey | `src/routing/session-key.ts` |
| 錯誤上報 | `sessions_send` 反向傳遞 | Skill 行為指導 |
| 工具權限差異 | `agents.list[].tools.allow` | `src/config/types.tools.ts` |
| 模型差異 | `agents.list[].model` | `src/config/types.agents.ts` |

---

## 實施步驟（建議順序）

### Phase 1：基礎設置
1. 在 Discord Server 建立 `#general` 文字頻道（或使用現有的）
2. 建立 Discord Bot 並取得 Token，確保 Bot 有「管理頻道」權限（建立 Forum Channel）
3. 設定 `settings.json` 中的四個 Agent 配置
4. 設定 Discord channel 配置和路由綁定
5. 撰寫四個 Skill 檔案
6. 啟用 `agentToAgent` 和 `sessions.visibility` 配置

### Phase 2：開發 project-orchestrator Plugin
1. 建立 Plugin 目錄和 manifest
2. 實作 `project_init` tool（建立 Forum Channel + 3 Threads + Thread Binding）
3. 測試 Forum Channel 動態建立
4. 確認動態建立的 Forum Channel 能被 Bot 監聽（`groupPolicy: "open"`）

### Phase 3：驗證核心流程
1. 在 `#general` 測試 Main Agent 日常對話
2. 測試「幫我創建專案」指令 → Forum + Thread 建立
3. 確認 Thread Binding 正確路由到對應 Agent
4. 測試 PM → Dev 的 `sessions_send`（訊息出現在 [PM-Dev] thread）
5. 測試 Dev → CICD 的 `sessions_send`（訊息出現在 [Dev-CICD] thread）
6. 測試錯誤上報鏈：CICD → Dev → PM → User

### Phase 4：生產化
1. 加入錯誤處理和重試機制
2. 設定 Thread Binding timeout（專案級別：30 天）
3. 加入人類審批節點（PM 可暫停等用戶確認）
4. 監控和日誌（`#agent-logs` 頻道）
5. Forum Channel 分類管理（進行中/已完成/封存）

---

## 注意事項與限制

1. **Bot 權限**：Main Agent 需要「管理頻道」權限才能動態建立 Forum Channel
2. **groupPolicy**：使用 `"open"` 讓 Bot 自動監聯動態建立的 Forum Channel
3. **`sessions_send` 輪次限制**：預設 5 輪 ping-pong，長期專案需調整
4. **Thread Binding 過期**：建議設 `maxAgeMs` 至少 30 天，長期專案需更大
5. **Session Key 傳遞**：Agent 需在訊息中包含目標 Agent 的 session key，
   若遺失需重新查詢（`sessions_list`）
6. **Token 消耗**：4 個 Agent 各有獨立 system prompt + Skill，成本按 agent 數倍增
7. **並發控制**：多個 Dev session 同時寫同一個 repo 需要 Git 分支策略
8. **Discord Rate Limit**：`project_init` 建立 1 個 Forum + 3 個 Thread，
   需注意 Discord API 速率限制
9. **跨 Agent 通訊配置**：必須啟用 `agentToAgent.enabled: true`
   和 `sessions.visibility: "all"`，否則 `sessions_send` 會被拒絕
10. **Forum Channel 數量**：每個專案一個 Forum，大量專案需注意 Discord Server 的頻道上限（500）
