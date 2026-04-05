# OpenClaw 自訂 Plugin 撰寫指南

> 基於原始碼調查，非官方文件推測。所有 pattern 來自 `extensions/` 下的真實 plugin。

---

## 目錄結構

```
my-plugin/
├── package.json            # npm 套件描述
├── openclaw.plugin.json    # openclaw 插件 manifest
├── index.ts                # 入口點
└── src/
    └── my-tool.ts          # tool 實作（可選拆分）
```

---

## 1. `package.json`

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

| 欄位 | 必要 | 說明 |
|------|:----:|------|
| `name` | 是 | **必須與 `openclaw.plugin.json` 的 `id` 一致**。本地 plugin 不用 `@openclaw/` scope |
| `type` | 是 | 必須是 `"module"`（ESM） |
| `openclaw.extensions` | 是 | 入口檔案路徑陣列 |

---

## 2. `openclaw.plugin.json`

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "My custom plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "guildId": { "type": "string" }
    }
  }
}
```

| 欄位 | 必要 | 說明 |
|------|:----:|------|
| `id` | 是 | Plugin ID，與 `package.json` 的 `name` 一致 |
| `name` | 否 | 顯示名稱 |
| `description` | 否 | 描述 |
| `enabledByDefault` | 否 | `true` = 預設啟用 |
| `configSchema` | 否 | Plugin 專屬配置的 JSON Schema |

---

## 3. `index.ts`（入口點）

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";

// ── Tool 建立函數 ──
function createMyTool(pluginConfig: Record<string, unknown> | undefined): AnyAgentTool {
  return {
    name: "my_tool",
    description: "Does something useful",
    parameters: {
      type: "object" as const,
      properties: {
        input: { type: "string", description: "Input text" },
      },
      required: ["input"],
    },
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const input = String(rawParams.input ?? "");
      // ... tool 邏輯 ...
      return {
        content: [{ type: "text", text: `Result: ${input}` }],
      };
    },
  } as AnyAgentTool;
}

// ── Plugin Entry ──
export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "My custom plugin",
  register(api) {
    // 方式 A：直接傳 tool object
    api.registerTool(createMyTool(api.pluginConfig) as AnyAgentTool);

    // 方式 B：factory 模式（可存取 ctx）
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) return null; // sandbox 環境跳過
        return createMyTool(api.pluginConfig);
      }) as OpenClawPluginToolFactory,
      { name: "my_tool" },  // 明確指定 tool 名稱
    );
  },
});
```

---

## 4. Tool 物件結構

> **易錯點**：`execute` 的第一個參數是 `toolCallId`（string），第二個才是 `params`。
> 寫成 `execute(params)` 會導致 toolCallId 字串被當成 params，真正參數被忽略。
> ```typescript
> // ❌ 錯誤
> async execute(params: any) { ... }
>
> // ✅ 正確
> async execute(_toolCallId: string, rawParams: Record<string, unknown>) { ... }
> ```

```typescript
{
  name: string;              // tool 名稱（snake_case），Agent allowlist 用此引用
  label?: string;            // 顯示名稱（可選）
  description: string;       // 描述（給 LLM 看的）
  parameters: JSONSchema;    // 參數定義（JSON Schema 或 @sinclair/typebox）
  execute: (                 // 執行函數
    toolCallId: string,      // ← 第一個參數，通常用 _toolCallId 忽略
    params: Record<string, unknown>,  // ← 第二個才是實際參數
  ) => Promise<ToolResult>;
  ownerOnly?: boolean;       // 僅限 owner 使用
}
```

**ToolResult 格式**：
```typescript
{
  content: [{ type: "text", text: "結果文字" }]
}
```

---

## 5. `api.registerTool()` 的兩種用法

### 用法 A：直接傳 tool object

```typescript
api.registerTool(myTool as AnyAgentTool);
```

- Tool 名稱從 `myTool.name` 取得
- 簡單直接，適合不需要 context 的 tool

### 用法 B：factory 模式

```typescript
api.registerTool(
  (ctx) => createMyTool(),  // factory: (OpenClawPluginToolContext) => AnyAgentTool | null
  { name: "my_tool" },     // 選項
);
```

- `ctx` 是 `OpenClawPluginToolContext`，包含：`sandboxed`、`requesterSenderId`、`senderIsOwner`
- Factory 回傳 `null` = 跳過（不註冊此 tool）
- `{ name }` 明確指定名稱（建議總是指定）
- `{ optional: true }` = 需要 Agent allowlist 明確允許才可用

---

## 6. Plugin 配置存取

### 在 `openclaw.json` 中設定

```jsonc
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "enabled": true,
        "config": {
          "apiKey": "sk-xxx",
          "guildId": "123456"
        }
      }
    }
  }
}
```

### 在 plugin 中讀取

```typescript
register(api) {
  const cfg = api.pluginConfig as { apiKey?: string; guildId?: string } | undefined;
  const apiKey = cfg?.apiKey ?? process.env.MY_API_KEY;
  const guildId = cfg?.guildId;
}
```

---

## 7. Plugin 安裝位置

| 位置 | 用途 |
|------|------|
| `~/.openclaw/extensions/my-plugin/` | 全域安裝 |
| `<workspace>/.openclaw/extensions/my-plugin/` | 工作區安裝 |
| `plugins.load.paths` 配置 | 開發/自訂路徑 |

openclaw 會在這些位置搜尋 plugin 目錄，每個目錄必須包含 `package.json`。

入口檔案搜尋順序（若 `openclaw.extensions` 未指定）：
`index.ts` → `index.js` → `index.mjs` → `index.cjs`

---

## 8. Agent 如何使用 Plugin Tool

Plugin tool 註冊後，Agent 需要在 `tools.allow` 中允許才可使用：

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "my_tool",           // 方式 1：指定 tool 名稱
            "my-plugin",         // 方式 2：允許該 plugin 所有 tool
            "group:plugins"      // 方式 3：允許所有 plugin tool
          ]
        }
      }
    ]
  }
}
```

---

## 9. 啟用 Plugin

```bash
# 啟用
openclaw config set plugins.entries.my-plugin.enabled true

# 設定 config
openclaw config set plugins.entries.my-plugin.config.guildId "123456"

# 驗證
openclaw plugins list
```

---

## 10. 常見錯誤

| 錯誤 | 原因 | 解法 |
|------|------|------|
| `plugin path not found` | `plugins.load.paths` 指向不存在的目錄 | 確認路徑正確，plugin 目錄存在 |
| Tool 不在可用清單 | Agent `tools.allow` 未包含 | 加入 tool 名稱或 plugin ID |
| `api.discord` undefined | `OpenClawPluginApi` 無 `.discord` 屬性 | 用 `fetch()` 直接呼叫 Discord REST API |
| Plugin ID 不匹配 | `package.json` name ≠ `openclaw.plugin.json` id | 兩者必須一致 |
| 使用 `@openclaw/` scope | 本地 plugin 不需要 npm scope | 移除 scope，直接用 `"my-plugin"` |
| Tool 收到的參數是字串 | `execute(params)` 少了第一個 `toolCallId` 參數 | 改為 `execute(_toolCallId, params)` |

---

## 參考的真實 Plugin

| Plugin | 路徑 | 特點 |
|--------|------|------|
| lobster | `extensions/lobster/` | 最簡單的 tool plugin，用 factory + optional |
| firecrawl | `extensions/firecrawl/` | 多個 tool，使用 typebox schema |
| memory-lancedb | `extensions/memory-lancedb/` | 複雜 configSchema，api.pluginConfig 存取 |
| diffs | `extensions/diffs/` | 使用 `{ name: "diffs" }` 明確指定 tool 名稱 |
