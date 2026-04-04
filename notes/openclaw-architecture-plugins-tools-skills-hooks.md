# OpenClaw 框架結構分析：Plugin / Tool / Skill / Hook

> 分析日期：2026-04-04
> 基於 openclaw 主倉庫原始碼調查整理

---

## 整體架構概覽

```
┌─────────────────────────────────────────────────────────────┐
│                      Gateway / Agent Runtime                 │
│                                                              │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐ │
│  │  Plugins  │   │  Tools   │   │  Skills  │   │  Hooks   │ │
│  │ (擴展載體) │   │ (LLM動作) │   │ (提示指導) │   │ (事件攔截) │ │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬─────┘ │
│       │              │              │              │         │
│       └──────────────┴──────────────┴──────────────┘         │
│                          │                                    │
│                    Agent 執行迴圈                              │
│              (System Prompt → LLM → Tool Call → Response)     │
└─────────────────────────────────────────────────────────────┘
```

---

## 四大核心概念對比

| 面向 | **Plugin** | **Tool** | **Skill** | **Hook** |
|------|-----------|----------|-----------|----------|
| **本質** | 擴展載體/容器 | LLM 可調用的函數 | Markdown 提示文件 | 生命週期事件處理器 |
| **定義位置** | `openclaw.plugin.json` | Plugin `registerTool()` 或核心內建 | `SKILL.md` 檔案 | `settings.json` 或 Plugin `registerHook()` |
| **執行者** | Gateway 進程載入 | LLM 發起 → SessionManager 執行 | LLM 自行讀取並遵循 | Gateway 進程在事件觸發時執行 |
| **Token 成本** | 無（後端載入） | 工具定義嵌入 prompt | **高**（整段嵌入 system prompt） | 無（後端執行） |
| **能否修改狀態** | 間接（透過註冊的 tools/hooks） | 是（檔案系統、session 等） | 否（純提示，無 runtime） | 是（可攔截/修改事件資料） |
| **有 Runtime 程式碼** | 是（TypeScript 模組） | 是（TypeScript 函數） | **否**（純 Markdown） | 是（TypeScript 函數/模組） |

---

## 1. Plugin — 擴展的容器

Plugin 是**其他三者的載體**。一個 plugin 可以同時註冊 tools、hooks、commands、channels、providers 等。Plugin 本身不直接「做事」，它是能力的打包與發布單位。

### 生命週期：Manifest-First 設計

```
Discovery → Manifest 驗證 → 啟用判定 → Runtime 載入 → 註冊
    │            │              │            │           │
    ▼            ▼              ▼            ▼           ▼
掃描目錄找到    解析 JSON      根據 config   動態 import  呼叫 api.register*()
plugin.json    不執行程式碼    決定啟用/停用  載入 TS 模組  填入 PluginRegistry
```

安全設計重點：在載入任何 runtime 程式碼之前，先完成 JSON 清單解析、配置驗證與啟用判斷。

### 關鍵檔案

| 功能 | 檔案路徑 |
|------|---------|
| 發現 | `src/plugins/discovery.ts` |
| 載入 | `src/plugins/loader.ts` |
| 清單定義 | `src/plugins/manifest.ts` |
| 註冊中心 | `src/plugins/registry.ts` |
| 型別定義 | `src/plugins/types.ts`（~2100 行） |
| 配置與啟用 | `src/plugins/config-state.ts` |

### Plugin 可註冊的能力

`OpenClawPluginApi` 上提供的 `register*()` 方法：

```
registerTool()                    registerHook()
registerCommand()                 registerChannel()
registerProvider()                registerService()
registerHttpRoute()               registerGatewayMethod()
registerCli()                     registerCliBackend()
registerSpeechProvider()          registerRealtimeTranscriptionProvider()
registerRealtimeVoiceProvider()   registerMediaUnderstandingProvider()
registerImageGenerationProvider() registerWebFetchProvider()
registerWebSearchProvider()       registerInteractiveHandler()
registerContextEngine()           registerMemoryPromptSection()
registerMemoryFlushPlan()         registerMemoryRuntime()
registerMemoryEmbeddingProvider()
on()  — 生命週期事件訂閱
```

### PluginRegistry 結構

```typescript
interface PluginRegistry {
  plugins: PluginRecord[]
  tools: PluginToolRegistration[]
  hooks: PluginHookRegistration[]
  typedHooks: TypedPluginHookRegistration[]
  channels: PluginChannelRegistration[]
  providers: PluginProviderRegistration[]
  speechProviders, realtimeTranscriptionProviders, ...
  gatewayHandlers: GatewayRequestHandlers
  httpRoutes: PluginHttpRouteRegistration[]
  services: PluginServiceRegistration[]
  commands: PluginCommandRegistration[]
  diagnostics: PluginDiagnostic[]
}
```

---

## 2. Tool — LLM 的「手腳」

Tool 是 LLM 在對話中**主動調用**的可執行函數（如 `read`、`write`、`exec`、`message`）。

### 執行流程

```
LLM 決定呼叫 tool
       │
       ▼
🪝 before_tool_call Hook（Plugin Hook，fail-closed）
       │  ← 可攔截/修改/拒絕
       ▼
SessionManager 執行 tool 函數
       │
       ▼
🪝 after_tool_call Hook（fire-and-forget）
       │
       ▼
結果回傳給 LLM → 下一輪對話
```

### Tool 來源

| 來源 | 說明 | 範例 |
|------|------|------|
| **核心內建** | 框架自帶 | `read`, `write`, `edit`, `exec`, `message`, `sessions_list`, `subagents` |
| **Plugin 提供** | 透過 `registerTool()` 註冊 | 各 plugin 自訂工具 |
| **MCP Server** | 外部語言服務器 | Language Server Protocol 工具 |

### 權限控制

定義於 `src/config/types.tools.ts`：

- `tools.profile` — 預設工具集 profile
- `tools.allow` / `tools.deny` — 白名單/黑名單
- `tools.alsoAllow` — 額外允許的工具
- `tools.byProvider.<provider|provider/model>` — 按模型供應商配置
- 按 sender 身份做細粒度控制

### Tool Context

每個 tool 執行時可取得的上下文：

```typescript
interface OpenClawPluginToolContext {
  config, runtimeConfig
  workspaceDir, agentDir, agentId
  sessionKey, sessionId
  messageChannel, agentAccountId
  deliveryContext
  requesterSenderId, senderIsOwner
  sandboxed  // 是否在沙箱中執行
  browser    // 瀏覽器配置
}
```

### 關鍵檔案

| 功能 | 檔案路徑 |
|------|---------|
| 核心 tool 建立 | `src/agents/pi-tools.ts` |
| Tool 政策過濾 | `src/agents/pi-tools.policy.ts` |
| before_tool_call 包裝 | `src/agents/pi-tools.before-tool-call.ts` |
| Tool 執行結果處理 | `src/agents/pi-embedded-subscribe.handlers.tools.ts` |
| Tool 配置型別 | `src/config/types.tools.ts` |
| Plugin tool 解析 | `src/plugins/tools.ts` |

---

## 3. Skill — LLM 的「腦中筆記」

Skill 是**純 Markdown 提示文件**，完全沒有 runtime 程式碼。它在系統提示中告訴 LLM：「你有這些技能可用，需要時去讀取對應檔案。」

### 運作方式

```
Agent 初始化
    │
    ▼
掃描 skill 目錄 → 載入 SKILL.md 的 frontmatter（名稱、描述）
    │
    ▼
formatSkillsForPrompt() 產生 XML：
    <available_skills>
      <skill>
        <name>commit</name>
        <description>Create git commits...</description>
        <location>/path/to/SKILL.md</location>
      </skill>
    </available_skills>
    │
    ▼
嵌入 System Prompt → LLM 看到技能清單
    │
    ▼
當任務匹配時，LLM 用 read tool 讀取 SKILL.md 全文 → 依照指示操作
```

### Skill vs Tool 的核心差異

- **Tool** = LLM 可以「做」的動作（調用函數，有明確的 input schema 和 output）
- **Skill** = LLM 可以「學」的指南（讀取文件後，指導 LLM 如何組合已有的 tools 完成複雜工作流程）
- Skill 本身不執行任何程式碼，**Token 成本最高但最靈活**

### Skill 來源

| 來源 | 說明 |
|------|------|
| Bundled skills | 倉庫 `/skills/` 目錄 |
| Managed skills | 從 clawhub 遠端取得 |
| Workspace skills | 專案本地定義 |
| Extra directory skills | 額外目錄掃描 |

### 過濾與限制

- 平台/環境相容性檢查（`shouldIncludeSkill()`）
- 允許/拒絕清單控制
- 單一 SKILL.md 上限 256KB（可配置 `limits.maxSkillFileBytes`）

### 關鍵檔案

| 功能 | 檔案路徑 |
|------|---------|
| 型別定義 | `src/agents/skills/types.ts` |
| 載入與掃描 | `src/agents/skills/workspace.ts` |
| Prompt 格式化 | `src/agents/skills/skill-contract.ts` |
| 系統提示整合 | `src/agents/system-prompt.ts` |
| 配置型別 | `src/config/types.skills.ts` |
| 安裝邏輯 | `src/agents/skills-install.ts` |
| 遠端獲取 | `src/infra/skills-remote.ts` |

---

## 4. Hook — 兩層事件系統

OpenClaw 有**兩種不同的 Hook 機制**，各自服務不同的使用場景：

### 4a. Config Hook（Internal Hook）— 使用者層

使用者在 `settings.json` 中定義，指向 workspace 內的 TypeScript 模組。

#### 配置範例

```json
{
  "hooks": {
    "internal": {
      "entries": [{
        "event": "agent:bootstrap",
        "module": "./hooks/my-hook.ts"
      }]
    }
  }
}
```

#### 事件類型

| 分類 | 事件範例 |
|------|---------|
| command | `command:*` |
| session | `session:patch` |
| agent | `agent:bootstrap` |
| gateway | `gateway:*` |
| message | `message:received`, `message:sent`, `message:transcribed`, `message:preprocessed` |

#### 特性

- **執行方式**：`triggerInternalHook(event)` 觸發所有匹配的 handler
- **錯誤處理**：一律 fail-open（錯誤記錄但不阻斷其他 handler）
- **信任邊界**：workspace 本地程式碼，使用者自行負責
- **載入方式**：動態 import + mtime cache busting

### 4b. Plugin Hook — 插件層

Plugin 透過 `registerHook()` 註冊到全域 Hook Runner，在 agent 執行管線中攔截事件。

#### 完整 Hook 生命週期

```
before_model_resolve → before_prompt_build → before_agent_start
         │                    │                      │
         ▼                    ▼                      ▼
    選擇模型/供應商      注入系統提示內容         Agent 啟動前處理

         ┌──── Agent 執行迴圈 ────┐
         │                        │
   before_tool_call ←──→ after_tool_call
   (fail-closed!)        (fire-and-forget)
         │                        │
    llm_input ←──────→ llm_output
         │                        │
         └────────────────────────┘

before_agent_reply → agent_end → session_end
```

#### 所有 Plugin Hook 名稱

| 分類 | Hook 名稱 |
|------|----------|
| 模型 | `before_model_resolve` |
| 提示 | `before_prompt_build`, `before_agent_start`（legacy） |
| LLM | `llm_input`, `llm_output` |
| Tool | `before_tool_call`（**fail-closed**）, `after_tool_call`, `tool_result_persist` |
| Agent | `before_agent_reply`, `agent_end`, `before_reset` |
| 壓縮 | `before_compaction`, `after_compaction` |
| 訊息 | `message_received`, `message_sending`, `message_sent`, `before_message_write` |
| Session | `session_start`, `session_end` |
| 入站 | `inbound_claim`, `before_dispatch` |
| 子代理 | `subagent_spawning`, `subagent_delivery_target`, `subagent_spawned`, `subagent_ended` |
| Gateway | `gateway_start`, `gateway_stop` |
| 安裝 | `before_install` |

### 兩層 Hook 對比

| 面向 | Config Hook（Internal） | Plugin Hook |
|------|------------------------|-------------|
| **來源** | 使用者 `settings.json` | Plugin 清單 |
| **事件格式** | `"agent:bootstrap"` | `"before_tool_call"` |
| **上下文** | 基本事件資料（type, action, sessionKey） | 豐富結構化上下文（model, channel, session, provider） |
| **失敗策略** | 一律 fail-open | 可配置（`before_tool_call` 是 fail-closed） |
| **修改能力** | 修改 `event.messages` 陣列 | 回傳 typed `*Result` 物件（如注入 prompt、攔截 tool） |
| **優先序** | 註冊順序 | 可配置 priority（數值越高越先執行） |
| **適用場景** | Workspace 級自訂自動化 | Plugin 級 agent 管線擴展 |

### 關鍵檔案

| 功能 | 檔案路徑 |
|------|---------|
| Internal Hook 註冊/觸發 | `src/hooks/internal-hooks.ts` |
| Internal Hook 載入 | `src/hooks/loader.ts` |
| Hook 配置型別 | `src/config/types.hooks.ts` |
| Hook 配置 schema | `src/config/zod-schema.hooks.ts` |
| Plugin Hook Runner | `src/plugins/hooks.ts` |
| 全域 Hook Runner | `src/plugins/hook-runner-global.ts` |
| before_prompt_build 整合 | `src/agents/pi-embedded-runner/run/attempt.ts` |
| before_tool_call 包裝 | `src/agents/pi-tools.before-tool-call.ts` |

---

## 整體執行流程

```
┌─ 啟動階段 ──────────────────────────────────────────────────┐
│                                                              │
│  1. Plugin Discovery & Loading                               │
│     └→ 掃描 openclaw.plugin.json → 驗證 → 啟用 → 載入       │
│     └→ 填充 PluginRegistry (tools, hooks, channels, ...)     │
│                                                              │
│  2. Config Hook Loading                                      │
│     └→ 讀取 settings.json → 動態 import 模組 → 註冊事件      │
│                                                              │
│  3. Skill Loading                                            │
│     └→ 掃描 skill 目錄 → 讀取 frontmatter → 格式化為 XML     │
│                                                              │
├─ Agent 執行階段 ────────────────────────────────────────────┤
│                                                              │
│  4. 組裝 System Prompt                                       │
│     ├→ 核心指令 + Skills XML + Memory + 時間等                │
│     └→ 🪝 before_prompt_build Hook → 注入額外上下文          │
│                                                              │
│  5. 組裝 Tool 清單                                           │
│     ├→ 核心 tools + Plugin tools + MCP tools                 │
│     └→ 套用 allow/deny 政策過濾                               │
│                                                              │
│  6. 送入 LLM                                                 │
│     ├→ 🪝 llm_input Hook                                    │
│     └→ LLM 回應（文字 或 tool_call）                          │
│         └→ 🪝 llm_output Hook                               │
│                                                              │
│  7. Tool 執行（若 LLM 發起 tool_call）                       │
│     ├→ 🪝 before_tool_call Hook（可攔截/拒絕）               │
│     ├→ SessionManager 執行 tool                              │
│     └→ 🪝 after_tool_call Hook                              │
│                                                              │
│  8. 回到步驟 6，直到 Agent 完成                               │
│                                                              │
├─ 結束階段 ──────────────────────────────────────────────────┤
│                                                              │
│  9.  🪝 before_agent_reply → agent_end → session_end         │
│  10. 🪝 message_sending → message_sent                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 核心設計洞察

1. **Plugin 是容器，不是功能**：Plugin 本身不直接執行業務邏輯，它是 tools/hooks/commands/channels/providers 的打包與發布載體。

2. **Skill 是唯一「無 runtime」的概念**：純 Markdown 提示文字，依賴 LLM 的理解力來執行。Token 成本最高但最靈活 — 不需要寫程式碼就能定義複雜工作流程。

3. **兩層 Hook 互不衝突、各司其職**：
   - Config Hook 面向 workspace 使用者（bootstrap、message 等事件）
   - Plugin Hook 面向 agent 執行管線（prompt build、tool call、LLM I/O）

4. **Tool 是 Hook 管線的終端**：每次 tool 調用都穿過 `before_tool_call`（fail-closed）→ 執行 → `after_tool_call`，plugin 可完全控制 tool 行為。

5. **Manifest-First 安全設計**：Plugin 先解析 JSON 清單、驗證配置、判斷啟用，才載入任何 runtime 程式碼，最小化攻擊面。

6. **Skill 驅動 Tool 組合**：Skill 的真正威力在於它能指導 LLM 如何將多個 Tool 組合成複雜的工作流程，而不需要寫任何程式碼。

---

## 關聯圖：四者如何交互

```
                    ┌─────────┐
                    │ Plugin  │
                    │ (容器)   │
                    └────┬────┘
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
      ┌─────────┐  ┌─────────┐  ┌─────────────┐
      │  Tool   │  │  Hook   │  │  Command /  │
      │ (動作)   │  │ (攔截)   │  │  Channel /  │
      └────┬────┘  └────┬────┘  │  Provider   │
           │             │       └─────────────┘
           │             │
           ▼             ▼
      ┌──────────────────────┐
      │   Agent 執行迴圈      │ ←── Skill（提示指導）
      │  LLM ↔ Tool Calls   │     嵌入 System Prompt
      └──────────────────────┘     引導 LLM 組合 Tools
```

- **Plugin → Tool**：Plugin 透過 `registerTool()` 提供新工具
- **Plugin → Hook**：Plugin 透過 `registerHook()` 攔截執行管線
- **Hook → Tool**：`before_tool_call` hook 可攔截/修改/拒絕任何 tool 調用
- **Skill → Tool**：Skill 指導 LLM 在適當時機調用適當的 tool
- **Hook → Prompt**：`before_prompt_build` hook 可注入額外系統提示（間接影響 Skill 和 Tool 的使用方式）
