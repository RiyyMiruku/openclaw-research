# 多 Agent Discord Forum - 執行配置計畫

> 參考藍圖：`notes/multi-agent-discord-forum-architecture.md`
> 本文件為 AI 可直接執行的逐步配置指南

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

> **Discord Bot 建立**：在 [Discord Developer Portal](https://discord.com/developers/applications) 建立 4 個 Application，
> 各自建立 Bot 並取得 Token。每個 Bot 設定不同的 username 和 avatar 以便辨識。
> 4 個 Bot 都需要加入同一個私人 Server。

---

## Step 1：建立 openclaw.json

路徑：`~/.openclaw/openclaw.json`（主配置檔）

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
          "allow": ["read", "glob", "grep", "sessions_spawn", "sessions_send", "sessions_list", "message", "project_init"]
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
  // 每個 binding 指定 accountId，確保訊息由正確的 Bot 接收和路由
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
  // 每個 Agent 對應一個獨立 Discord Bot，擁有獨立 username / avatar
  // 好處：視覺身分辨識、獨立打字指示器、session 天然隔離
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

> **4 個 Bot Account**：每個 Agent 擁有獨立 Discord Bot（獨立 token / username / avatar）。
> 好處：視覺身分辨識、獨立打字指示器、session key 天然含 accountId 隔離。
>
> **`groupPolicy: "open"`**：Forum Channel 動態建立，所有 Bot 自動監聽。
>
> **Session Key 格式**：`agent:<agentId>:discord:<accountId>:<threadId>`，accountId 即 Bot account 名稱（main / pm / dev / cicd）。

---

## Step 2：建立 Skill 檔案

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

## Step 3：建立 project-orchestrator Plugin

### 3.1 目錄結構

```
extensions/project-orchestrator/
├── openclaw.plugin.json
├── package.json
└── src/
    └── index.ts
```

### 3.2 `openclaw.plugin.json`

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
    },
    "discordAccountId": {
      "type": "string",
      "description": "Discord Bot 的 Account ID",
      "default": "discord"
    }
  }
}
```

### 3.3 `src/index.ts`

完整實作見藍圖 Step 5。核心邏輯：

```
project_init(projectName, description)
  │
  ├─ 1. POST /guilds/{guildId}/channels
  │     → 建立 Forum Channel (type: 15 = GuildForum)
  │     → 取得 forumChannelId
  │
  ├─ 2. createThreadDiscord(forumChannelId, ...) × 3
  │     → [User-PM] 專案討論  → userPmThread.id
  │     → [PM-Dev] 開發任務   → pmDevThread.id
  │     → [Dev-CICD] 建置測試 → devCicdThread.id
  │
  ├─ 3. 構造 Session Key × 3
  │     → agent:pm:discord:pm:channel:{userPmThread.id}
  │     → agent:dev:discord:dev:channel:{pmDevThread.id}
  │     → agent:cicd:discord:cicd:channel:{devCicdThread.id}
  │       (每個 agent 使用各自的 accountId: pm/dev/cicd)
  │
  ├─ 4. getThreadBindingManager(accountId) + bindTarget() × 3
  │     → pm account manager:   userPmThread  ↔ PM session
  │     → dev account manager:  pmDevThread   ↔ Dev session
  │     → cicd account manager: devCicdThread ↔ CICD session
  │
  └─ 5. 回傳 { forumChannelId, threads: { userPm, pmDev, devCicd } }
```

---

## Step 4：Discord Bot 權限設定

4 個 Bot 都需要相同的 Intent 和權限。在 Discord Developer Portal 中為每個 Application 設定：

### Gateway Intents（4 個 Bot 都要開啟）
- `GUILDS`
- `GUILD_MESSAGES`
- `MESSAGE_CONTENT`

### Bot Permissions（4 個 Bot 都要設定）
| 權限 | 用途 | Main | PM | Dev | CICD |
|------|------|:----:|:--:|:---:|:----:|
| `MANAGE_CHANNELS` | 動態建立 Forum Channel | **必要** | - | - | - |
| `SEND_MESSAGES` | 在頻道發送訊息 | v | v | v | v |
| `SEND_MESSAGES_IN_THREADS` | 在 Thread 中發送訊息 | v | v | v | v |
| `CREATE_PUBLIC_THREADS` | 在 Forum 中建立 Thread | v | - | - | - |
| `READ_MESSAGE_HISTORY` | 讀取歷史訊息 | v | v | v | v |
| `MANAGE_THREADS` | 管理 Thread 設定 | v | - | - | - |
| `VIEW_CHANNEL` | 檢視頻道 | v | v | v | v |
| `MANAGE_WEBHOOKS` | Thread Binding Webhook | v | v | v | v |

> **簡化做法**：4 個 Bot 統一使用相同權限組，避免權限不足問題。

---

## Step 5：驗證清單

按順序逐一驗證，每步通過後再進行下一步。

### 5.1 基礎連線
```
[ ] openclaw 啟動，Bot 上線
[ ] 在 #general 發送訊息，Main Agent 回應
[ ] Main Agent 能進行日常對話
```

### 5.2 專案創建
```
[ ] 在 #general 發送「幫我創建專案，測試專案」
[ ] Main 呼叫 project_init → Forum Channel「測試專案」已建立
[ ] Forum 下有 3 個 Thread：[User-PM]、[PM-Dev]、[Dev-CICD]
[ ] Main 回覆包含 Forum 和 Thread 連結
```

### 5.3 Thread Binding 路由
```
[ ] 在 [User-PM] thread 發言 → PM Agent 回應（非 Main）
[ ] 在 [PM-Dev] thread 發言 → Dev Agent 回應
[ ] 在 [Dev-CICD] thread 發言 → CICD Agent 回應
```

### 5.4 Agent 間通訊
```
[ ] 在 [User-PM] 向 PM 提需求 → PM 用 sessions_send 派發給 Dev
[ ] Dev 的回應出現在 [PM-Dev] thread
[ ] Dev 用 sessions_send 派發 CICD → CICD 回應出現在 [Dev-CICD] thread
[ ] CICD 結果回傳給 Dev → Dev 回報 PM → PM 匯報用戶
```

### 5.5 錯誤上報
```
[ ] 模擬 CICD 失敗 → Dev 收到失敗通知
[ ] Dev 上報 PM → PM 在 [User-PM] thread 詢問用戶
[ ] 用戶回覆 → PM 轉達 Dev → Dev 繼續
```

### 5.6 專案隔離
```
[ ] 建立第二個專案 → 新的 Forum Channel + 3 Threads
[ ] 兩個專案的 Agent 對話互不干擾
[ ] 各自的 session 獨立，context 不混用
```

---

## 故障排除

| 症狀 | 可能原因 | 解法 |
|------|---------|------|
| Forum 建立失敗 | Bot 缺少 `MANAGE_CHANNELS` 權限 | 重新設定 Bot 權限 |
| Thread 中 Agent 不回應 | Thread Binding 未設定 / 已過期 | 檢查 `bindTarget()` 是否成功 |
| `sessions_send` 被拒絕 | `agentToAgent.enabled` 未開啟 | 確認 openclaw.json 中的配置 |
| Agent 回應在錯誤 Thread | Session Key 構造錯誤 | 檢查 `agent:<id>:discord:<account>:channel:<threadId>` 格式 |
| 動態建立的 Forum 無法監聽 | `groupPolicy` 設定錯誤 | 使用 `groupPolicy: "open"` |
| Thread Binding 過期 | `maxAgeMs` 太短 | 調大至 2592000000 (30天) 或更長 |
| 訊息未出現在 Discord | Webhook 未建立 | 確認 Bot 有 `MANAGE_WEBHOOKS` 權限 |
