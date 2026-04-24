# DC 自動化開發團隊 — 系統藍圖 v2.0

> 建立日期：2026-04-15
> 最後更新：2026-04-24
> 對齊 spec：`project-init-implementation-spec.md`（方案 3：Discord Transport）

---

## 變更記錄

- 2026-04-24：v2.0 大幅更新
  - 修正 session key 格式（實際為 4 段，buildAgentSessionKey 不帶 accountId）
  - 確認 thread 命名（`pm` / `dev` / `cicd`）
  - 加入「PM/Dev/CICD 是 top-level agent」聲明
  - 新增 echo loop 防護機制（NO_REPLY guard）
  - 更新綁定流程（Method B with buildAgentSessionKey）
  - 確認 binding accountId 修復
  - 移除過時的 sessions_send 雙向通訊假設，改用 message tool
- 2026-04-23：Finance workspace 移至 finance-workspace/（不在 projects/ 下）

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
- 各自擁有完整的 session 系統
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

### 1.5 Agent 間 Transport 機制

**不走 `sessions_send`（A2A RPC），改用 Discord thread 訊息傳遞**：

```
PM → Dev：PM 在 Dev thread 發訊息 → Dev 被喚醒
Dev → CICD：Dev 在 CICD thread 發訊息 → CICD 被喚醒
Dev → PM：Dev 在 PM thread 發訊息 → PM 被喚醒
```

每個 agent 用 `message` tool 指定 `target: "<threadId>"` 發話。

---

## 二、Session 生命週期

### 2.1 Session 建立觸發條件

Bot session **不是預先存在的**，需要：

1. 在對應 Discord thread 發送訊息
2. Bot 收到後自動 spawn session（`spawnSubagentSessions: true`）
3. Session 建立後可接收 `sessions_send`

### 2.2 Idle 釋放行為

Bot session 完成任務後進入 `done` 狀態。一段時間後（`idleHours: 168`）會釋放資源。此時 `sessions_send` 會 timeout。

**重新激活**：在對應 thread 發一條 Discord 訊息，Bot 就會重新 spawn session。

---

## 三、project_init 實作流程（Method B）

### 3.1 流程說明

1. Main agent 收到使用者「@main 建立專案 <name>」
2. `project_init` tool 被呼叫，執行：
   - Step 1：建立 Forum channel（REST）
   - Step 2：檢查同名 Forum（拒絕重名）
   - Step 3：建立 3 個 thread（REST + intro message 含 @mention）
   - Step 4：呼叫 `buildAgentSessionKey()` 組正確 session key
   - Step 5：用各 agent 自己的 Discord account 建立 binding manager
   - Step 6：`bindTarget({ createThread: false, ... })` 寫入 binding
   - Step 7：回傳三個 thread 的連結

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

### 3.4 project_init 初始訊息格式

```
<@pm> 專案「**{projectName}**」已建立。這是 [User-PM] 溝通頻道，後續訊息將由 pm agent 處理。
```

---

## 四、已修復的問題

### 4.1 Binding accountId 錯誤（✅ 已修復 2026-04-24）

**問題**：`accountId` 被錯誤寫成 `"main"`，導致 routing fallback 到 main。

**原因**：`project-orchestrator` 的 binding manager 用 `"main"` 建立，但 Discord event 是由各 agent 的 webhook 觸發，accountId 不匹配。

**修復**：每個 agent 的 binding manager 用自己的 `accountId`（pm/dev/cicd）。

---

### 4.2 Echo Loop 無防護（✅ 已修復 2026-04-24）

**問題**：PM 回覆自己的 kickoff 訊息後，被當成新輸入再次處理，形成無限迴圈。

**原因**：

1. PM Bot 回覆到 thread 時，Discord 將該訊息顯示為「新訊息」
2. 該訊息的 `sender_id` = PM Bot 自己
3. `allowBots: "mentions"` 讓 Bot 吃到包含自己 mention 的訊息
4. 再次回覆 → 又觸發 → 無限迴圈

**修復**：在 `pm-workflow/SKILL.md` 加上 NO_REPLY guard：

```
## Guard
若發現 sender_id 是自己，立即回 NO_REPLY，不再處理。
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

WSL 環境中 `openclaw gateway restart` 被 SIGTERM 打斷。修復位於研究副本，未部署到實際執行版本。

臨時解法：`bash ~/.openclaw/restart-gateway.sh`

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

- **收到用戶需求** → 拆分任務 → `sessions_send` 派發給 Dev
- **收到 Dev 回報** → 更新進度 → 在 PM thread 回覆用戶
- **Guard**：收到自己訊息（sender_id 是自己）→ `NO_REPLY`

### 6.2 Dev Workflow

- **收到 PM 任務** → 分析 → 實作 → commit + PR → `sessions_send` 派發 CICD
- **收到 CICD 結果** → ✅通過 → `sessions_send` 回報 PM；❌失敗 → 修復後重派

### 6.3 CICD Workflow

- **收到 Dev 建置請求** → `exec` 跑 build/test → 回報結果給 Dev
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
      "pm":   { "threadBindings": { "spawnSubagentSessions": true  } },
      "dev":  { "threadBindings": { "spawnSubagentSessions": true  } },
      "cicd": { "threadBindings": { "spawnSubagentSessions": true  } }
    }
  }
}
```

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
| Restart Script    | `~/.openclaw/restart-gateway.sh`                                    |
