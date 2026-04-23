# TOOLS.md

## Discord Bots

| Bot | Account | Channel |
|-----|---------|---------|
| main | `main` | #general (`1484583108836720643`) |
| pm | `pm` | [User-PM] threads |
| dev | `dev` | [PM-Dev] threads |
| cicd | `cicd` | [Dev-CICD] threads |
| finance | `finance` | #finance-reports |

Guild: `1484583107947532541`

## Gateway Restart

WSL 環境中 `openclaw gateway restart` 會被 SIGTERM 中斷。改用腳本：

```bash
bash ~/.openclaw/restart-gateway.sh
```
