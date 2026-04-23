# DC 自動化開發團隊 — 系統藍圖 v1.0

> 建立日期：2026-04-15
> 最后更新：2026-04-15

---

## 一、系統架構

### 1.1 核心元件

| 元件 | 說明 |
|------|------|
| Main Agent | 日常對話 + 專案初始化（`project_init`）|
| PM Agent | 需求分析 + 任務派發 |
| Dev Agent | 接收任務、實作、派發建置 |
| CICD Agent | 建置測試、回報結果 |
| Finance Agent | 存在但未整合進此架構 |

### 1.2 Discord 頻道結構

```
Guild: 1484583107947532541
├── #general (文字頻道) → Main Agent 監聽
│
├── 📁 [專案Forum] (Forum Channel)
│   ├── 🧵 [User-PM] 專案討論 → PM Bot 綁定
│   ├── 🧵 [PM-Dev] 開發任務 → Dev Bot 綁定
│   └── 🧵 [Dev-CICD] 建置測試 → CICD Bot 綁定
```

### 1.3 Session Key 格式

```
agent:<agentId>:discord:<accountId>:channel:<threadId>

範例：
agent:pm:discord:pm:channel:1493939424457916446
agent:dev:discord:dev:channel:1493939426705805483
agent:cicd:discord:cicd:channel:1493939431412076546
```

---

## 二、已修復的問題

### 2.1 Thread Binding 持久化（✅ 已修復）

**問題**：`project_init` 執行後，`thread-bindings.json` 為空，gateway 重啟後所有 binding 消失。

**原因**：`project_init` 只建立了 Forum/Threads，但沒有寫入 `thread-bindings.json`。

**修復**：在 `~/.openclaw/extensions/project-orchestrator/src/index.ts` 的 `execute()` 末尾，新增寫入邏輯：
- 寫入 `thread-bindings.json`
- 格式：`${accountId}:${threadId}` → `PersistedThreadBindingRecord`
- 綁定記錄包含：`threadId`, `channelId`, `targetSessionKey`, `accountId`, `agentId`, `targetKind="acp"`, `boundAt`, `lastActivityAt`

**檔案位置**：`~/.openclaw/extensions/project-orchestrator/src/index.ts`

**驗證**：✅ 2026-04-15 確認成功寫入

---

## 三、Bot Session 生命週期（重要發現）

### 3.1 Session 建立觸發條件

Bot session（`agent:pm:discord:pm:channel:xxx`）**不是預先存在的**，需要：
1.有人在對應的 Discord thread 發送訊息
2. Bot 收到後自動 spawn session（`spawnSubagentSessions: true`）
3. Session 建立後可接收 `sessions_send`

### 3.2 Session 狀態

| 狀態 | 意義 |
|------|------|
| `running` | Session 活躍，可接收訊息 |
| `done` | 任務完成，進入 idle |
| (空) | Session 尚未建立 |

### 3.3 Idle 釋放行為

Bot session 完成任務後會進入 `done` 狀態。一段時間後（`idleHours: 168`）會釋放資源。此時 `sessions_send` 會 timeout。

**重新激活**：在對應 thread 發一條 Discord 訊息，Bot 就會重新 spawn session。

### 3.4 驗證過的通訊路徑

| 方向 | 工具 | 狀態 |
|------|------|------|
| Main → PM | `sessions_send` | ✅ |
| Main → Dev | `sessions_send` | ✅ |
| Main → CICD | `sessions_send` | ✅ |
| PM → Dev | 未驗證（session idle）| ⚠️ |
| Dev → CICD | 未驗證（session idle）| ⚠️ |

---

## 四、Config 現況（`openclaw.json`）

### 4.1 Agent 工具權限

| Agent | `sessions_send` | `message` | `sessions_spawn` |
|-------|:---:|:---:|:---:|
| PM | ✅ | ✅ | ✅ |
| Dev | ✅ | ✅ | ❌ |
| CICD | ✅ | ✅ | ❌ |

### 4.2 Thread Bindings 設定

| 帳號 | `spawnSubagentSessions` | 狀態 |
|------|:---:|------|
| main | true | ✅ |
| pm | true | ✅ |
| dev | true | ✅ |
| cicd | true | ✅ |
| finance | false | — |

### 4.3 `thread-bindings.json` 位置

```
~/.openclaw/discord/thread-bindings.json
```

格式：
```json
{
  "version": 1,
  "bindings": {
    "pm:1493939424457916446": {
      "threadId": "1493939424457916446",
      "channelId": "1493939417596035233",
      "targetSessionKey": "agent:pm:discord:pm:channel:1493939424457916446",
      "accountId": "pm",
      "agentId": "pm",
      "targetKind": "acp",
      "boundBy": "project-orchestrator",
      "boundAt": 1776253317048,
      "lastActivityAt": 1776253317048
    }
  }
}
```

---

## 五、Skill / Workflow 現況

### 5.1 三個 Workflow SKILL.md 位置

```
~/.openclaw/skills/
├── pm-workflow/SKILL.md
├── dev-workflow/SKILL.md
└── cicd-workflow/SKILL.md
```

### 5.2 主要缺口（未修復）

1. **Session Key 初始化共識**：三個 workflow 對 session key 從哪裡來說法不一致
2. **CICD Session Key 來源**：Dev 的 SKILL.md 說 CICD key 由 PM 在任務中提供，但 PM SKILL.md 沒說清楚怎麼拿到
3. **Bootstrapping 未完成**：三個 workspace 的 `BOOTSTRAP.md` 未刪除、`IDENTITY.md` 未填寫、`TOOLS.md` 為空
4. **錯誤上報鏈**：只在架構筆記有描述，workflow 沒明確定義

---

## 六、PR #47222（SIGTERM 問題）

### 6.1 問題描述

WSL 環境中執行 `openclaw gateway restart` 時，gateway 收到 SIGTERM 後立即關閉，導致 restart script 被打斷。

### 6.2 原因

CLI 進程退出時，systemd 的 `KillMode=control-group` 會把 SIGTERM 傳播到同一 cgroup 下的 gateway 進程。

### 6.3 修復內容

| 檔案 | 修改 |
|------|------|
| `src/cli/gateway-cli/run-loop.ts` | 新增 `serverStarting` + `pendingSigterm` guard，延後 startup 期間的 SIGTERM |
| `src/daemon/systemd-unit.ts` | `KillMode=control-group` → `KillMode=mixed` |

### 6.4 現況

修復位於 `~/.openclaw/openclaw-research/`（研究用原始碼），**未部署**到實際運行的 npm 安裝版本。

如需真正修復，需要修改 npm 全域安裝或等待上游合併。

---

## 七、測試用 Forum/Threads（2026-04-15 建立）

| 項目 | ID |
|------|-----|
| Forum Channel | `1493939417596035233` |
| [User-PM] Thread | `1493939424457916446` |
| [PM-Dev] Thread | `1493939426705805483` |
| [Dev-CICD] Thread | `1493939431412076546` |

---

## 八、已知限制

1. **Bot session 需手動觸發**：每次重啟 gateway 或 session idle 後，需有人在 thread 發訊息才能重啟
2. **Session timeout**：Bot idle 太久（>168小時）會完全釋放
3. **跨-session 雙向通訊**：需確保雙方 session 都處於 `running` 狀態
4. **研究 repo 變更未部署**：`openclaw-research` 的 PR #47222 變更只在研究副本中，不影響實際運行

---

## 九、相關檔案索引

| 檔案 | 路徑 |
|------|------|
| 主設定 | `~/.openclaw/openclaw.json` |
| Thread Bindings | `~/.openclaw/discord/thread-bindings.json` |
| 專案初始化 Plugin | `~/.openclaw/extensions/project-orchestrator/src/index.ts` |
| Main Skill | `~/.openclaw/skills/main-orchestrator/SKILL.md` |
| PM Skill | `~/.openclaw/skills/pm-workflow/SKILL.md` |
| Dev Skill | `~/.openclaw/skills/dev-workflow/SKILL.md` |
| CICD Skill | `~/.openclaw/skills/cicd-workflow/SKILL.md` |
| 架構設計筆記 | `~/.openclaw/openclaw-research/notes/multi-agent-discord-forum-architecture.md` |
| Restart Script | `~/.openclaw/restart-gateway.sh` |
