# 多 Agent 角色扮演全自動開發架構設計

> 分析日期：2026-04-05
> 基於 openclaw 原始碼調查，設計 PM / Dev / CI-CD 三角色 Agent 協作架構
> 平台：Discord Forum

---

## 目標

- 3 個 Agent（PM、Dev、CI/CD）各司其職，自動協作開發
- 每個專案對應一個 Discord Forum Post（thread）
- Agent 間對話在 Forum 的子 Thread 中可見
- 專案間 context 完全隔離
- 人類（你）可隨時與 PM 對話討論方向

---

## 整體架構圖

```
Discord Server
│
├── #projects (Forum Channel)
│   │
│   ├── 📌 [Project-A] 新功能：用戶認證      ← Forum Post (主 Thread)
│   │   │
│   │   │  👤 你：「我想加一個 OAuth 登入」
│   │   │  🤖 PM：「了解，我來拆分任務...」
│   │   │  🤖 PM：「已派發 3 個子任務給 Dev」
│   │   │
│   │   ├── 🧵 [PM↔Dev] Task-1: OAuth 前端     ← 子 Thread
│   │   │   🤖 PM：「需求如下...」
│   │   │   🤖 Dev：「收到，開始實作...」
│   │   │   🤖 Dev：「完成，PR #42 已建立」
│   │   │
│   │   ├── 🧵 [Dev↔CICD] Build PR#42          ← 子 Thread
│   │   │   🤖 Dev：「請建置並測試 PR #42」
│   │   │   🤖 CICD：「測試通過 ✓，覆蓋率 89%」
│   │   │
│   │   └── 🧵 [PM↔Dev] Task-2: OAuth 後端     ← 子 Thread
│   │       🤖 PM：「API 規格如下...」
│   │       🤖 Dev：「實作完成」
│   │
│   └── 📌 [Project-B] Bug修復：登入逾時        ← 另一個 Forum Post
│       │  👤 你：「用戶反映登入會 timeout」
│       │  🤖 PM：「我來調查...」
│       ...
│
└── #agent-logs (文字頻道，可選)
    └── 系統日誌、錯誤通知等
```

---

## 核心設計原則

### 1. 專案隔離 = Session 隔離

OpenClaw 的路由機制中，每個 Discord Thread 會自動產生獨立的 `sessionKey`：

```
sessionKey 格式: agent:<agentId>:discord:<accountId>:<threadId>
```

- Forum Post A 的 threadId ≠ Forum Post B 的 threadId
- 因此每個專案的每個 Agent 天然擁有獨立 session
- **不需要額外隔離機制**，框架原生支援

### 2. Agent 間通訊 = `sessions_send` + Thread Binding

Agent 間對話透過 `sessions_send` tool 實現，搭配 Discord Thread Binding：

```
PM 呼叫 sessions_send → 訊息送到 Dev 的 session
                       → subagent_spawning hook 觸發
                       → 在 Forum Post 下建立子 Thread
                       → Dev 回覆可見於該 Thread
```

### 3. 人類介入 = 直接在 Forum Post 主 Thread 對 PM 說話

PM Agent 綁定到 Forum Post 的主 Thread，你的訊息直接觸發 PM。

---

## 配置方案

### Step 1：定義三個 Agent

```jsonc
// settings.json
{
  "agents": {
    "list": [
      {
        "id": "pm",
        "name": "PM Agent",
        "default": true,
        "identity": {
          "name": "PM",
          "emoji": "📋"
        },
        "model": {
          "primary": "claude-opus-4-6"   // PM 需要強推理
        },
        "workspace": "./projects",
        "thinkingDefault": "high",
        "skills": ["pm-workflow"],
        "subagents": {
          "allowAgents": ["dev", "cicd"],  // PM 可派發給 Dev 和 CI/CD
          "requireAgentId": true
        },
        "tools": {
          "allow": [
            "read", "write", "edit", "glob", "grep",
            "sessions_spawn", "sessions_send", "sessions_list",
            "subagents", "message"
          ]
        }
      },
      {
        "id": "dev",
        "name": "Dev Agent",
        "identity": {
          "name": "Dev",
          "emoji": "💻"
        },
        "model": {
          "primary": "claude-sonnet-4-6"  // Dev 用高效模型
        },
        "workspace": "./projects",
        "thinkingDefault": "medium",
        "skills": ["dev-workflow"],
        "subagents": {
          "allowAgents": ["cicd"],         // Dev 可派發給 CI/CD
          "requireAgentId": true
        },
        "tools": {
          "allow": [
            "read", "write", "edit", "exec", "glob", "grep",
            "sessions_send", "subagents", "message"
          ]
        }
      },
      {
        "id": "cicd",
        "name": "CI/CD Agent",
        "identity": {
          "name": "CI/CD",
          "emoji": "🔧"
        },
        "model": {
          "primary": "claude-haiku-4-5"   // CI/CD 用快速模型
        },
        "workspace": "./projects",
        "thinkingDefault": "low",
        "skills": ["cicd-workflow"],
        "subagents": {
          "allowAgents": [],              // 葉節點，不再派發
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
    // ── 預設：Forum 主 Thread → PM Agent ──
    {
      "agentId": "pm",
      "comment": "所有 Forum Post 主 Thread 預設由 PM 接收",
      "match": {
        "channel": "discord",
        "guildId": "YOUR_GUILD_ID",
        "peer": {
          "kind": "channel",
          "id": "FORUM_CHANNEL_ID"    // #projects Forum 的 ID
        }
      }
    },

    // ── Forum 下所有 Thread → 根據 Thread Binding 路由 ──
    // 這部分由 subagent hook 動態建立，不需靜態設定

    // ── 備用：其他頻道 → PM ──
    {
      "agentId": "pm",
      "comment": "預設 fallback",
      "match": {
        "channel": "discord",
        "guildId": "YOUR_GUILD_ID"
      }
    }
  ]
}
```

### Step 3：Discord Channel 設定

```jsonc
{
  "channels": {
    "discord": {
      "accounts": [
        {
          "accountId": "discord",
          "token": "YOUR_BOT_TOKEN",
          "enabled": true,
          "config": {
            "groupPolicy": "allowlist",
            "guilds": {
              "YOUR_GUILD_ID": {
                "channels": {
                  "FORUM_CHANNEL_ID": {}   // 允許 Forum Channel
                }
              }
            },
            "replyToMode": "thread",        // 回覆自動進 Thread
            "conversationBindings": {
              "enabled": true,              // 啟用 Thread Binding
              "idleTimeoutMs": 86400000,    // 24h
              "maxAgeMs": 604800000         // 7 天
            }
          }
        }
      ]
    }
  }
}
```

---

## Step 4：建立 Skill 定義（角色行為指導）

### PM Skill (`skills/pm-workflow/SKILL.md`)

```markdown
---
name: pm-workflow
description: PM Agent 的專案管理工作流程
---

# PM Agent 工作流程

## 你的角色
你是專案經理（PM），負責：
1. 與人類討論需求、確認方向
2. 將需求拆解為可執行的開發任務
3. 透過 sessions_spawn 派發任務給 Dev Agent
4. 追蹤任務進度，匯報給人類
5. 審查 Dev 的產出，決定是否需要修改

## 工作流程

### 收到人類需求時
1. 確認需求範圍和優先級
2. 拆分為 1-5 個具體開發任務
3. 為每個任務撰寫清晰的規格說明
4. 使用 sessions_spawn 為每個任務建立 Dev 子代理：
   ```
   sessions_spawn({
     task: "任務描述和規格...",
     agentId: "dev",
     label: "task-1-oauth-frontend",
     mode: "session",
     thread: true
   })
   ```

### 收到 Dev 完成通知時
1. 審查產出（PR、程式碼變更）
2. 如需修改，用 sessions_send 回饋
3. 全部任務完成後，匯報給人類

### 溝通規範
- 對人類：簡潔、結構化，使用列表和進度指標
- 對 Dev：精確、包含具體技術規格和驗收標準
- 對 CI/CD：簡明指令（通常由 Dev 直接派發）
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
5. 派發 CI/CD 任務進行建置測試

## 工作流程

### 收到 PM 任務時
1. 分析任務需求和驗收標準
2. 探索相關程式碼（read, glob, grep）
3. 實作變更（write, edit）
4. 本地驗證（exec 執行測試）
5. 建立 Git commit 和 PR
6. 派發 CI/CD 檢查：
   ```
   sessions_spawn({
     task: "請建置並測試分支 feature/oauth，PR #42",
     agentId: "cicd",
     label: "build-pr-42",
     mode: "run",
     thread: true
   })
   ```
7. 等待 CI/CD 結果，通知 PM 完成

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

## 工作流程

### 收到建置請求時
1. 切換到指定分支（exec: git checkout）
2. 安裝依賴（exec: pnpm install）
3. 執行 lint（exec: pnpm check）
4. 執行測試（exec: pnpm test）
5. 檢查建置（exec: pnpm build）
6. 用 sessions_send 回報結果給 Dev：
   - ✅ 全部通過：「Build passed. Tests: 142/142. Coverage: 89%」
   - ❌ 失敗：「Build failed. 3 test failures: [details]」
```

---

## Step 5：Plugin Hook 實現自動 Thread 路由（進階）

要讓 Agent 間對話自動出現在 Discord 子 Thread 中，需要一個 Plugin Hook：

### 自訂 Plugin：`agent-thread-router`

```typescript
// extensions/agent-thread-router/src/index.ts

import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";

export default {
  register(api) {
    // ── Hook 1: subagent 派生時，在 Forum Post 下建立子 Thread ──
    api.registerHook({
      name: "subagent_spawning",
      priority: 100,
      async handler(event, ctx) {
        const { childSessionKey, label, requester } = event;

        // 只處理 Discord 來源
        if (requester?.channel !== "discord") {
          return { status: "ok" };
        }

        const parentThreadId = requester.threadId;
        if (!parentThreadId) {
          return { status: "ok" };
        }

        // 透過 Discord API 在 Forum Post 下建立子 Thread
        // Thread 名稱 = label 或 agent 組合
        const threadName = `[${event.agentId}] ${label ?? childSessionKey}`;

        // 建立 Thread 並綁定到 childSessionKey
        // ThreadBindingManager 會自動處理
        return {
          status: "ok",
          threadBindingReady: true,
        };
      },
    });

    // ── Hook 2: subagent 完成時，在主 Thread 通知 ──
    api.registerHook({
      name: "subagent_ended",
      priority: 50,
      async handler(event, ctx) {
        if (event.outcome === "ok") {
          // 通知 PM 主 Thread：任務完成
          // 由框架的 announce-delivery 機制處理
        }
      },
    });

    // ── Hook 3: 攔截 agent 間訊息，路由到正確的 Thread ──
    api.registerHook({
      name: "subagent_delivery_target",
      priority: 100,
      async handler(event, ctx) {
        // 將 subagent 完成通知路由回父 Thread
        if (event.requesterOrigin?.channel === "discord") {
          return {
            origin: {
              channel: "discord",
              accountId: event.requesterOrigin.accountId,
              to: event.requesterOrigin.to,
              threadId: event.requesterOrigin.threadId,
            },
          };
        }
        return {};
      },
    });
  },
} satisfies OpenClawPluginDefinition;
```

### Plugin 清單

```jsonc
// extensions/agent-thread-router/openclaw.plugin.json
{
  "id": "agent-thread-router",
  "name": "Agent Thread Router",
  "description": "自動在 Discord Forum 下為 Agent 間對話建立子 Thread",
  "enabledByDefault": true
}
```

---

## 完整流程圖：一次完整的開發週期

```
你 (Discord Forum #projects)
│
│  在 Forum 建立新 Post: "新功能：OAuth 登入"
│
▼
┌─────────────────────────────────────────────────────┐
│ Forum Post: [Project] OAuth 登入                     │
│                                                      │
│  👤 你：「需要 Google OAuth 登入，前後端都要」          │
│                                                      │
│  ┌──── 路由：Forum Post → PM Agent ────┐             │
│  │  binding: peer.kind=channel         │             │
│  │  agentId: pm                        │             │
│  └─────────────────────────────────────┘             │
│                                                      │
│  🤖 PM：「了解！我把這個拆成 3 個任務：                │
│     1. 前端 OAuth UI 元件                             │
│     2. 後端 OAuth API                                 │
│     3. E2E 測試                                       │
│     正在派發給 Dev...」                                │
│                                                      │
│  ═══════════════════════════════════════════════════  │
│                                                      │
│  PM 內部執行:                                         │
│  sessions_spawn({                                    │
│    task: "實作前端 OAuth...",                          │
│    agentId: "dev",                                   │
│    label: "task-1-oauth-ui",                         │
│    mode: "session",                                  │
│    thread: true        ← 關鍵：在 Discord 建子 Thread │
│  })                                                  │
│                                                      │
│  ┌─── subagent_spawning Hook 觸發 ───┐               │
│  │  建立 Discord 子 Thread            │               │
│  │  名稱: "[Dev] task-1-oauth-ui"     │               │
│  │  綁定 childSessionKey              │               │
│  └────────────────────────────────────┘               │
│                                                      │
└──────────────────────┬───────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌───────────────────┐    ┌──────────────────────┐
│ 🧵 子 Thread:      │    │ 🧵 子 Thread:         │
│ [Dev] oauth-ui    │    │ [Dev] oauth-api      │
│                   │    │                      │
│ 🤖 PM→Dev:        │    │ 🤖 PM→Dev:           │
│ 「需求規格...」     │    │ 「API 規格...」       │
│                   │    │                      │
│ 🤖 Dev:           │    │ 🤖 Dev:              │
│ 「分析中...」       │    │ 「實作中...」          │
│ 「已建立 PR #42」  │    │ 「已建立 PR #43」     │
│                   │    │                      │
│ 🤖 Dev 內部:       │    │                      │
│ sessions_spawn({  │    │                      │
│   agentId: "cicd" │    │                      │
│   label: "pr-42"  │    │                      │
│ })                │    │                      │
│       │           │    │                      │
│       ▼           │    │                      │
│ ┌───────────────┐ │    │                      │
│ │🧵 [CICD] pr-42│ │    │                      │
│ │               │ │    │                      │
│ │🤖 Dev→CICD:   │ │    │                      │
│ │「建置 PR #42」 │ │    │                      │
│ │               │ │    │                      │
│ │🤖 CICD:       │ │    │                      │
│ │「✅ Tests pass」│ │    │                      │
│ │「Coverage: 89%」│ │    │                      │
│ └───────────────┘ │    │                      │
│                   │    │                      │
│ 🤖 Dev→PM:        │    │                      │
│ 「Task-1 完成 ✅」  │    │                      │
└───────────────────┘    └──────────────────────┘
        │                             │
        └──────────────┬──────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ Forum Post 主 Thread（回到 PM 與你的對話）              │
│                                                      │
│  🤖 PM：「進度更新：                                   │
│     ✅ Task-1: 前端 OAuth (PR #42, 測試通過)           │
│     ✅ Task-2: 後端 OAuth (PR #43, 測試通過)           │
│     🔄 Task-3: E2E 測試 (進行中)                      │
│     整體進度: 67%」                                    │
│                                                      │
│  👤 你：「PR #42 加個 remember me checkbox」           │
│                                                      │
│  🤖 PM：「收到，通知 Dev 修改...」                      │
│     → sessions_send 到 Dev 的 session                 │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## Context 隔離機制

```
                    Session 隔離圖

Project A (Forum Post threadId: 1001)          Project B (Forum Post threadId: 2001)
┌──────────────────────────────┐               ┌──────────────────────────────┐
│                              │               │                              │
│ PM Session                   │               │ PM Session                   │
│ key: agent:pm:discord:...:1001│              │ key: agent:pm:discord:...:2001│
│ context: [Project A 需求]     │               │ context: [Project B 需求]     │
│                              │               │                              │
│ Dev Session                  │               │ Dev Session                  │
│ key: agent:dev:subagent-xxx  │               │ key: agent:dev:subagent-yyy  │
│ context: [Task A-1 程式碼]    │               │ context: [Task B-1 程式碼]    │
│                              │               │                              │
│ CICD Session                 │               │ CICD Session                 │
│ key: agent:cicd:subagent-zzz │               │ key: agent:cicd:subagent-www │
│ context: [Build A-1 結果]     │               │ context: [Build B-1 結果]     │
│                              │               │                              │
└──────────────────────────────┘               └──────────────────────────────┘
         完全獨立，互不污染                              完全獨立，互不污染
```

**隔離保證來自：**
1. **不同 threadId** → 不同 sessionKey → 不同 session 儲存
2. **subagent 機制** → 子代理自動獲得獨立 childSessionKey
3. **workspace 可按專案配置** → 檔案系統層面隔離
4. **session 可見性守衛** → Agent 只能看到自己衍生的子 session

---

## 關鍵 OpenClaw 機制對照

| 需求 | 使用的 OpenClaw 機制 | 關鍵檔案 |
|------|---------------------|---------|
| 3 個角色 Agent | `agents.list[]` 配置 | `src/config/types.agents.ts` |
| Agent 角色行為 | Skill (`SKILL.md`) | `src/agents/skills/` |
| Agent 身份識別 | `identity` 配置（name, emoji） | `src/config/types.agents.ts` |
| Discord Forum 路由 | `bindings[]` + peer 匹配 | `src/routing/resolve-route.ts` |
| Forum → PM | binding `peer.kind=channel` | `src/routing/resolve-route.ts` |
| PM → Dev 派發 | `sessions_spawn` tool | `src/agents/tools/sessions-spawn-tool.ts` |
| Agent 間對話 | `sessions_send` tool | `src/agents/tools/sessions-send-tool.ts` |
| 子 Thread 建立 | `thread: true` + Thread Binding | `extensions/discord/src/monitor/thread-bindings.manager.ts` |
| 對話可見性 | Discord Thread 天然可見 | Discord 平台特性 |
| 專案隔離 | threadId → sessionKey 隔離 | `src/routing/session-key.ts` |
| 人類與 PM 對話 | Forum Post 主 Thread 直接觸發 | Discord 路由綁定 |
| 任務追蹤 | subagent registry | `src/agents/subagent-registry.ts` |
| 完成通知路由 | `subagent_delivery_target` hook | `src/plugins/types.ts` |
| 工具權限差異 | `agents.list[].tools.allow` | `src/config/types.tools.ts` |
| 模型差異 | `agents.list[].model` | `src/config/types.agents.ts` |

---

## 實施步驟（建議順序）

### Phase 1：基礎設置
1. 在 Discord Server 建立 Forum Channel（`#projects`）
2. 建立 Discord Bot 並取得 Token
3. 設定 `settings.json` 中的三個 Agent 配置
4. 設定 Discord channel 配置和路由綁定
5. 撰寫三個 Skill 檔案

### Phase 2：驗證核心流程
1. 在 Forum 建立 Post，確認 PM Agent 回應
2. 手動測試 PM → Dev 的 `sessions_spawn`
3. 確認子 Thread 建立和 Thread Binding 正常
4. 測試 Dev → CICD 的派發

### Phase 3：進階 Hook（可選）
1. 開發 `agent-thread-router` plugin
2. 自動化 Thread 命名規範
3. 完成通知路由到主 Thread
4. 進度追蹤面板（可用 Discord Embed）

### Phase 4：生產化
1. 加入錯誤處理和重試機制
2. 設定 Agent timeout 和 resource limits
3. 加入人類審批節點（PM 可暫停等你確認）
4. 監控和日誌

---

## 注意事項與限制

1. **Subagent 深度限制**：預設 `maxSpawnDepth` 有限，PM→Dev→CICD 是 3 層，需確認配置允許
2. **`sessions_send` 輪次限制**：預設 5 輪 ping-pong，長對話需調整
3. **Thread Binding 過期**：預設有 `idleTimeoutMs` 和 `maxAgeMs`，長期專案需調大
4. **Token 消耗**：每個 Agent 的 system prompt 獨立計算 token，Skill 內容越多成本越高
5. **並發控制**：多個 Dev subagent 同時寫同一個 repo 需要 Git 分支策略
6. **Discord Rate Limit**：大量 Thread 建立可能觸發 Discord API 限制
7. **Forum Post 限制**：Discord Forum 單一 Post 下的子 Thread 數量有平台限制
