# TOOLS.md

## Discord Bots

| Bot | Token Env |
|-----|-----------|
| main | `DISCORD_BOT_TOKEN_MAIN` |
| pm | `DISCORD_BOT_TOKEN_PM` |
| dev | `DISCORD_BOT_TOKEN_DEV` |
| cicd | `DISCORD_BOT_TOKEN_CICD` |

Guild: `1484583107947532541` | #general: `1484583108836720643`

## Gateway Restart

WSL 環境中 `openclaw gateway restart` 會被 SIGTERM 中斷。改用腳本：

```bash
bash ~/.openclaw/restart-gateway.sh
```
