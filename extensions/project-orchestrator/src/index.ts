// src/index.ts — Project Orchestrator Plugin
//
// Registers the `project_init` tool which:
//   1. Creates a Discord Forum Channel via Discord REST API
//   2. Creates 3 threads via Discord REST API
//   3. Returns session keys for pm/dev/cicd agents
//
// Key API limitation (confirmed via SDK source):
//   - OpenClawPluginApi has NO .discord property
//   - openclaw/plugin-sdk/discord is NOT accessible from external plugins
//   - Direct fetch() to Discord REST API is the reliable approach

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DISCORD_API = "https://discord.com/api/v10";

async function discordApi(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

function resolveToken(
  config: Record<string, unknown> | undefined,
  accountId: string,
): string {
  const discord = (config as any)?.channels?.discord;
  const account = discord?.accounts?.[accountId];
  const token = account?.token ?? discord?.token;
  if (token) return String(token);

  const envKey = `DISCORD_BOT_TOKEN_${accountId.toUpperCase()}`;
  const envToken = process.env[envKey] ?? process.env.DISCORD_BOT_TOKEN;
  if (envToken) return envToken;

  throw new Error(
    `No Discord token found for account "${accountId}". ` +
      `Set it in config (channels.discord.accounts.${accountId}.token) or env (${envKey}).`,
  );
}

export default definePluginEntry({
  id: "project-orchestrator",
  name: "Project Orchestrator",
  description: "自動建立專案 Forum Channel 和多 Agent 對話通道",
  register(api) {
    const guildId = (api.pluginConfig as any)?.guildId as string | undefined;

    api.registerTool(
      ((ctx) => ({
        name: "project_init",
        description:
          "建立新專案：創建 Discord Forum Channel + 3 個對話 Thread",
        parameters: {
          type: "object" as const,
          properties: {
            projectName: {
              type: "string",
              description: "專案名稱（例：RAG系統）",
            },
            description: {
              type: "string",
              description: "專案簡述",
            },
          },
          required: ["projectName"],
        },

        async execute(_toolCallId: any, params: any) {
          // Validate inputs
          if (!params?.projectName || typeof params.projectName !== "string") {
            throw new Error(`Invalid projectName: ${JSON.stringify(params?.projectName)}, raw params: ${JSON.stringify(params)}`);
          }
          const projectName = params.projectName;
          const description = params.description;

          const guild = guildId ?? (api.pluginConfig as any)?.guildId;
          if (!guild) {
            throw new Error(
              "guildId not configured. Set plugins.entries.project-orchestrator.config.guildId in openclaw.json.",
            );
          }

          const mainToken = resolveToken(ctx.config as Record<string, unknown>, "main");

          // ═══ 1. Create Forum Channel ════════════════════════════════
          // ChannelType.GuildForum = 15
          const forumPayload: Record<string, unknown> = {
            name: String(projectName),
            type: 15,
          };
          if (description) {
            forumPayload.topic = String(description);
          }

          // Debug: verify payload before sending
          const serialized = JSON.stringify(forumPayload);
          if (!serialized.includes("name")) {
            throw new Error(`DEBUG: name field missing from payload: ${serialized}`);
          }

          const forumChannel = await discordApi(
            mainToken,
            "POST",
            `/guilds/${guild}/channels`,
            forumPayload,
          ) as { id: string };
          const forumChannelId = forumChannel.id;

          // ═══ 2. Create 3 Threads in Forum ════════════════════════════
          // Forum threads: POST /channels/{forumId}/threads
          // Forum requires message.content as first post

          const createForumThread = async (name: string, content: string) => {
            return discordApi(
              mainToken,
              "POST",
              `/channels/${forumChannelId}/threads`,
              {
                name,
                auto_archive_duration: 10080, // 7 days
                message: { content },
              },
            ) as { id: string };
          };

          const userPmThread = await createForumThread(
            "[User-PM] 專案討論",
            [
              `# 專案：${projectName}`,
              description ? `> ${description}` : "",
              "",
              "📋 **用戶與 PM 討論區**",
              "在此與 PM 溝通需求、確認方向、追蹤進度。",
            ]
              .filter(Boolean)
              .join("\n"),
          );

          const pmDevThread = await createForumThread(
            "[PM-Dev] 開發任務",
            [
              `# 專案：${projectName}`,
              "",
              "💻 **PM 與 Dev 協作區**",
              "PM 在此派發任務規格，Dev 在此回報開發進度。",
            ].join("\n"),
          );

          const devCicdThread = await createForumThread(
            "[Dev-CICD] 建置測試",
            [
              `# 專案：${projectName}`,
              "",
              "🔧 **Dev 與 CI/CD 協作區**",
              "Dev 在此派發建置請求，CI/CD 在此回報測試結果。",
            ].join("\n"),
          );

          // ═══ 2.5. Send Trigger Messages to Each Thread ═══════════════════════
          // After creating threads, send a trigger message to each one to activate
          // the bound bot session. This ensures sessions spawn automatically
          // without requiring a human to manually send the first message.
          //
          // The gateway processes these incoming Discord events, which causes
          // the thread-binding manager to lookup the binding (written in step 4)
          // and spawn the subagent session for each bot.
          //
          // If the in-memory binding cache hasn't been updated yet when the
          // gateway processes these messages, the sessions will spawn on the next
          // gateway restart (bindings are persisted to thread-bindings.json).

          const sendThreadMessage = async (threadId: string, content: string) => {
            try {
              await discordApi(mainToken, "POST", `/channels/${threadId}/messages`, { content });
            } catch (err) {
              // Non-fatal: session will spawn on next gateway restart
              console.error(`[project-orchestrator] Failed to send trigger message to thread ${threadId}:`, err);
            }
          };

          // ═══ 2.6. Trigger Gateway Restart (Background) ══════════════════════
          // After persisting bindings, use setsid + background bash to fully detach
          // the restart process into its own session. This survives SIGTERM from
          // the gateway restart itself (unlike node spawn with detached:true).
          const restartScript = path.join(os.homedir(), ".openclaw", "restart-gateway.sh");
          try {
            exec(`setsid bash "${restartScript}" </dev/null >/dev/null 2>&1 &`);
          } catch (err) {
            console.error("[project-orchestrator] Failed to spawn gateway restart:", err);
          }

          // PM trigger (User-PM thread): PM bot initializes with project info
          await sendThreadMessage(
            userPmThread.id,
            [
              `## 新專案：${projectName}`,
              description ? `> ${description}` : "",
              "",
              `PM 工作區已就緒。等待用戶在 [User-PM] thread 提出需求。`,
              "",
              `### 通訊資訊`,
              `- Dev session (PM-Dev thread): ${devSessionKey}`,
              `- CICD session (Dev-CICD thread): ${cicdSessionKey}`,
            ]
              .filter(Boolean)
              .join("\n"),
          );

          // Dev trigger (PM-Dev thread): Dev bot initializes
          await sendThreadMessage(
            pmDevThread.id,
            [
              `## 專案：${projectName}`,
              "",
              `Dev 工作區已就緒，等待 PM 派發任務。`,
              "",
              `### 通訊資訊`,
              `- PM session key: ${pmSessionKey}`,
            ].join("\n"),
          );

          // CICD trigger (Dev-CICD thread): CICD bot initializes
          await sendThreadMessage(
            devCicdThread.id,
            [
              `## 專案：${projectName}`,
              "",
              `CI/CD 工作區已就緒，等待 Dev 派發建置請求。`,
              "",
              `### 通訊資訊`,
              `- Dev session key: ${devSessionKey}`,
            ].join("\n"),
          );

          // ═══ 3. Build Session Keys ══════════════════════════════════
          // Format: agent:<agentId>:discord:<accountId>:channel:<threadId>
          const pmSessionKey = `agent:pm:discord:pm:channel:${userPmThread.id}`;
          const devSessionKey = `agent:dev:discord:dev:channel:${pmDevThread.id}`;
          const cicdSessionKey = `agent:cicd:discord:cicd:channel:${devCicdThread.id}`;

          // ═══ 4. Persist Thread Bindings to disk ══════════════════════════
          // Write binding records to thread-bindings.json so bindings survive gateway restarts.
          // Key format: "accountId:threadId"
          // Record format: PersistedThreadBindingRecord (matches thread-bindings.types.ts)
          try {
            const openclawDir = process.env.OPENCLAW_CONFIG_DIR ?? path.join(os.homedir(), ".openclaw");
            const bindingsPath = path.join(openclawDir, "discord", "thread-bindings.json");
            const bindingsDir = path.dirname(bindingsPath);

            // Ensure directory exists
            if (!fs.existsSync(bindingsDir)) {
              fs.mkdirSync(bindingsDir, { recursive: true });
            }

            // Load existing bindings (keep existing records, add new ones)
            let payload: { version: number; bindings: Record<string, unknown> } = { version: 1, bindings: {} };
            if (fs.existsSync(bindingsPath)) {
              try {
                const raw = JSON.parse(fs.readFileSync(bindingsPath, "utf-8"));
                if (raw && typeof raw === "object" && "version" in raw && "bindings" in raw) {
                  payload = raw as typeof payload;
                }
              } catch {
                // File corrupt/invalid — start fresh
              }
            }

            const nowMs = Date.now();
            const newBindings: Record<string, unknown> = {
              [`pm:${userPmThread.id}`]: {
                threadId: userPmThread.id,
                channelId: forumChannelId,
                targetSessionKey: pmSessionKey,
                accountId: "pm",
                agentId: "pm",
                targetKind: "acp",
                boundBy: "project-orchestrator",
                boundAt: nowMs,
                lastActivityAt: nowMs,
              },
              [`dev:${pmDevThread.id}`]: {
                threadId: pmDevThread.id,
                channelId: forumChannelId,
                targetSessionKey: devSessionKey,
                accountId: "dev",
                agentId: "dev",
                targetKind: "acp",
                boundBy: "project-orchestrator",
                boundAt: nowMs,
                lastActivityAt: nowMs,
              },
              [`cicd:${devCicdThread.id}`]: {
                threadId: devCicdThread.id,
                channelId: forumChannelId,
                targetSessionKey: cicdSessionKey,
                accountId: "cicd",
                agentId: "cicd",
                targetKind: "acp",
                boundBy: "project-orchestrator",
                boundAt: nowMs,
                lastActivityAt: nowMs,
              },
            };

            // Merge new bindings with existing ones
            payload.bindings = { ...payload.bindings, ...newBindings };

            fs.writeFileSync(bindingsPath, JSON.stringify(payload, null, 2), "utf-8");
          } catch (persistErr) {
            // Non-fatal: log but don't fail the tool
            console.error("[project-orchestrator] Failed to persist thread bindings:", persistErr);
          }

          // ═══ 5. Return Result ════════════════════════════════════════
          // Thread Binding is handled automatically by
          // threadBindings.spawnSubagentSessions and agent routing.
          // No manual bindTarget() call needed.

          return {
            status: "ok",
            projectName,
            forumChannelId,
            threads: {
              userPm: {
                threadId: userPmThread.id,
                sessionKey: pmSessionKey,
                name: "[User-PM] 專案討論",
              },
              pmDev: {
                threadId: pmDevThread.id,
                sessionKey: devSessionKey,
                name: "[PM-Dev] 開發任務",
              },
              devCicd: {
                threadId: devCicdThread.id,
                sessionKey: cicdSessionKey,
                name: "[Dev-CICD] 建置測試",
              },
            },
          };
        },
      })) as OpenClawPluginToolFactory,
      { name: "project_init" },
    );
  },
});
