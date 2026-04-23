# AGENTS.md

## System Overview

- **Repo:** github.com/openclaw/openclaw
- **My workspace:** `~/.openclaw/main-workspace`
- **Blueprint:** `~/.openclaw/openclaw-research/notes/`

## Agents

| Agent | Workspace | Skills | Discord Bot |
|-------|-----------|--------|-------------|
| main | `~/.openclaw/main-workspace/` | `main-orchestrator` | main |
| pm | `~/.openclaw/projects/pm-workspace/` | `pm-workflow` | pm |
| dev | `~/.openclaw/projects/dev-workspace/` | `dev-workflow` | dev |
| cicd | `~/.openclaw/projects/cicd-workspace/` | `cicd-workflow` | cicd |
| finance | `~/.openclaw/finance-workspace/` | `finance-workflow` | finance |

## 4-Bot Flow（忽略 Finance）

```
User → #general → Main Agent
                  ↓
            [User-PM] ← PM Bot
                  ↓
            [PM-Dev] ← Dev Bot
                  ↓
            [Dev-CICD] ← CICD Bot
```

## Finance Agent（獨立）

```
每日 08:30 → Tavily 搜尋市場資訊 → 發布至 #finance-reports
```

## Common Cmds

```
bash ~/.openclaw/restart-gateway.sh
openclaw config dump
```
