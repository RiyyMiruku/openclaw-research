# AGENTS.md
- **Repo:** github.com/openclaw/openclaw
- **My workspace:** `~/.openclaw/workspace-main`
- **Blueprint:** `~/.openclaw/openclaw-research/notes/`

## 4-Bot Setup
| Agent | Bot | Thread |
|-------|-----|--------|
| main | main | #general |
| pm | pm | [User-PM] |
| dev | dev | [PM-Dev] |
| cicd | cicd | [Dev-CICD] |

## Flow
User → [User-PM] → PM → Dev → CICD → result flows back

## Skills
`~/.openclaw/skills/`: `main-orchestrator` | `pm-workflow` | `dev-workflow` | `cicd-workflow`

## Common Cmds
```
openclaw gateway restart
openclaw config dump
pnpm install · pnpm tsgo · pnpm check · pnpm build
```
