// src/index.ts — Project Orchestrator Plugin
//
// Registers the `project_init` tool which:
//   1. Creates a Discord Forum Channel via Discord REST API
//   2. Creates 3 threads via bindTarget (auto webhook + intro + persist)
//   3. Bindings are persisted automatically via the manager
//
// NOTE: Trigger messages and gateway restart are handled by the main-orchestrator
// SKILL (agentic), not here. This plugin only sets up Discord infrastructure.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { createRequire } from "node:module";

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

// Lazy singleton require for openclaw dist
let _openclawRequire: ReturnType<typeof createRequire> | null = null;
function getOpenclawRequire(): ReturnType<typeof createRequire> {
  if (!_openclawRequire) {
    // openclaw is installed at this known path when running in the gateway
    const openclawDist = "/home/justin/.npm-global/lib/node_modules/openclaw/dist";
    _openclawRequire = createRequire(openclawDist + "/index.js");
  }
  return _openclawRequire;
}

function getThreadBindingsExports() {
  const req = getOpenclawRequire();
  const openclawDir = "/home/justin/.npm-global/lib/node_modules/openclaw";
  // thread-bindings-DGck9pdd.js: u=createThreadBindingManager, d=getThreadBindingManager
  return req(openclawDir + "/dist/thread-bindings-DGck9pdd.js");
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
            throw new Error(
              `Invalid projectName: ${JSON.stringify(params?.projectName)}, raw params: ${JSON.stringify(params)}`,
            );
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

          const forumChannel = await discordApi(
            mainToken,
            "POST",
            `/guilds/${guild}/channels`,
            forumPayload,
          ) as { id: string };
          const forumChannelId = forumChannel.id;

          // ═══ 2. Create 3 Threads via bindTarget ══════════════════════
          // bindTarget will: create webhook, send introText, persist binding to disk
          const { u: createThreadBindingManager } = getThreadBindingsExports();
          const manager = createThreadBindingManager({
            accountId: "main",
            token: mainToken,
            cfg: ctx.config,
            persist: true,
          });

          const makeIntroText = (label: string, agentId: string) =>
            `Session for ${label} (${agentId}) is now active. Messages here go directly to this session.`;

          const bindThread = async (
            threadName: string,
            agentId: string,
            label: string,
            targetSessionKeyBase: string,
          ): Promise<{
            threadId: string;
            sessionKey: string;
            name: string;
          }> => {
            // First create the thread via Discord REST
            const thread = await discordApi(
              mainToken,
              "POST",
              `/channels/${forumChannelId}/threads`,
              {
                name: threadName,
                auto_archive_duration: 10080,
                message: { content: makeIntroText(label, agentId) },
              },
            ) as { id: string };

            const threadId = thread.id;
            const realSessionKey = `${targetSessionKeyBase}${threadId}`;

            // Now bind the thread with webhook + intro via manager
            await manager.bindTarget({
              threadId,
              channelId: forumChannelId,
              createThread: false, // already created above
              agentId,
              targetSessionKey: realSessionKey,
              label,
              introText: makeIntroText(label, agentId),
              boundBy: "project-orchestrator",
            });

            return { threadId, sessionKey: realSessionKey, name: threadName };
          };

          // Create all three thread bindings in parallel
          const [userPmResult, pmDevResult, devCicdResult] = await Promise.all([
            bindThread("[User-PM] 專案討論", "pm", "User-PM", `agent:pm:discord:pm:channel:`),
            bindThread("[PM-Dev] 開發任務", "dev", "PM-Dev", `agent:dev:discord:dev:channel:`),
            bindThread("[Dev-CICD] 建置測試", "cicd", "Dev-CICD", `agent:cicd:discord:cicd:channel:`),
          ]);

          // ═══ 3. Return Result ════════════════════════════════════════
          return {
            status: "ok",
            projectName,
            forumChannelId,
            threads: {
              userPm: {
                threadId: userPmResult.threadId,
                sessionKey: userPmResult.sessionKey,
                name: userPmResult.name,
              },
              pmDev: {
                threadId: pmDevResult.threadId,
                sessionKey: pmDevResult.sessionKey,
                name: pmDevResult.name,
              },
              devCicd: {
                threadId: devCicdResult.threadId,
                sessionKey: devCicdResult.sessionKey,
                name: devCicdResult.name,
              },
            },
          };
        },
      })) as OpenClawPluginToolFactory,
      { name: "project_init" },
    );
  },
});
