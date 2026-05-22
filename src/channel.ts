import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  missingTargetError,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  type InboundMessage,
  type OpenClawConfig,
  type ChannelGatewayContext,
  type MsgContext,
} from "openclaw/plugin-sdk";
import type { AppleMailConfig } from "./config.js";
import {
  resolveAppleMailAccount,
  resolveDefaultAppleMailAccountId,
  listAppleMailAccountIds,
  type ResolvedAppleMailAccount,
} from "./accounts.js";
import { getAppleMailRuntime } from "./runtime.js";
import { sendAppleMailText, threadSubjectCache } from "./outbound.js";
import { appleMailThreading } from "./threading.js";
import { normalizeAppleMailTarget, isAppleMailThreadId, cleanSubject } from "./normalize.js";
import { monitorAppleMail } from "./monitor.js";
import { Semaphore } from "./semaphore.js";
import { AppleMailClient } from "./applescript-client.js";
import crypto from "node:crypto";

const meta = {
  id: "apple-mail",
  label: "Apple Mail",
  selectionLabel: "Apple Mail",
  detailLabel: "Apple Mail (macOS)",
  docsPath: "/channels/apple-mail",
  docsLabel: "apple-mail",
  blurb: "Apple Mail integration via AppleScript and Mail.app on macOS.",
  systemImage: "envelope.fill",
  order: 101,
  showConfigured: true,
};

// Active accounts and clients
const activeAccounts = new Map<string, ChannelGatewayContext<ResolvedAppleMailAccount>>();
const activeClients = new Map<string, AppleMailClient>();

// Limit concurrent dispatches
const dispatchSemaphore = new Semaphore(3);

/**
 * Build MsgContext with isolated session per email thread.
 * CRITICAL: The SessionKey format ensures each email thread gets its own session.
 */
function buildAppleMailMsgContext(
  msg: InboundMessage,
  account: ResolvedAppleMailAccount,
  cfg: OpenClawConfig
): MsgContext {
  const runtime = getAppleMailRuntime();
  const to = `apple-mail:${account.email}`;
  const threadLabel = `Apple Mail thread ${msg.threadId}`;

  // THIS IS THE KEY PART - SessionKey isolates each thread
  const ctx = runtime.channel.reply.finalizeInboundContext({
    Body: msg.text,
    RawBody: msg.text,
    CommandBody: msg.text,
    From: msg.sender.id,
    To: to,
    // Each thread gets its own session - NO MIXING!
    SessionKey: `agent:main:apple-mail:${account.email}:${msg.threadId}`,
    AccountId: msg.accountId,
    ChatType: "direct",
    ConversationLabel: threadLabel,
    SenderName: msg.sender.name,
    SenderId: msg.sender.id,
    Provider: "apple-mail" as const,
    Surface: "apple-mail" as const,
    MessageSid: msg.channelMessageId,
    ReplyToId: msg.channelMessageId,
    ThreadLabel: threadLabel,
    MessageThreadId: msg.threadId,
    ThreadStarterBody: undefined,
    Timestamp: msg.timestamp ? Math.round(msg.timestamp / 1_000) : undefined,
    MediaPath: msg.mediaPath,
    MediaType: msg.mediaType,
    MediaUrl: msg.mediaUrl,
    CommandAuthorized: false,
    OriginatingChannel: "apple-mail" as const,
    OriginatingTo: msg.threadId,
  });

  return ctx;
}

async function dispatchAppleMailMessage(
  ctx: ChannelGatewayContext<ResolvedAppleMailAccount>,
  msg: InboundMessage,
  client: AppleMailClient
) {
  const { account, accountId, cfg, log } = ctx;
  const runtime = getAppleMailRuntime();
  const requestId = crypto.randomUUID().split("-")[0];

  await dispatchSemaphore.run(async () => {
    try {
      log?.info(
        `[apple-mail][${requestId}] Dispatching message ${msg.channelMessageId} from ${msg.sender.id} (thread: ${msg.threadId})`
      );

      const ctxPayload = buildAppleMailMsgContext(msg, account, cfg);
      const amCfg = cfg.channels?.["apple-mail"] as AppleMailConfig | undefined;

      const rawMsg = msg.raw as any;
      const originalSubject = rawMsg?.subject || "(no subject)";
      const cleanSubj = cleanSubject(originalSubject);
      const replySubject = originalSubject.toLowerCase().startsWith("re:")
        ? originalSubject
        : `Re: ${originalSubject}`;

      // Cache clean subject for this thread so follow-ups can find it
      if (msg.threadId && cleanSubj) {
        threadSubjectCache.set(msg.threadId, cleanSubj);
        log?.info(
          `[apple-mail][${requestId}] Cached subject for thread ${msg.threadId}: "${cleanSubj}"`
        );
      }

      // The deliver function sends replies back to the same thread
      const deliver = async (payload: { text: string; mediaPath?: string; mediaUrl?: string }) => {
        // Auto-detect file attachments from the AI's response text
        // Supports multiple formats the AI might use:
        //   ATTACH:/path/to/file.pdf       (explicit format)
        //   file:///path/to/file.pdf       (file:// URL format)
        //   /Users/openclaw/skills/qb-cli/workspace/purchaseorder_280.pdf  (bare path in text)
        //   sandbox:/workspace/file.pdf    (sandbox path - skip these, they're virtual)
        const attachmentPaths: string[] = [];
        let cleanBody = payload.text;

        // Pattern 1: ATTACH:/absolute/path
        const attachPattern = /^ATTACH:(.+)$/gm;
        let m: RegExpExecArray | null;
        while ((m = attachPattern.exec(payload.text)) !== null) {
          const p = m[1].trim();
          if (p.startsWith("/")) attachmentPaths.push(p);
        }
        cleanBody = cleanBody.replace(/^ATTACH:.+$/gm, "").trim();

        // Pattern 2: file:///absolute/path
        const fileUrlPattern = /file:\/\/\/([^\s"'\)]+)/g;
        while ((m = fileUrlPattern.exec(payload.text)) !== null) {
          const p = "/" + m[1].trim().replace(/[)\]"']+$/, "");
          if (!attachmentPaths.includes(p)) attachmentPaths.push(p);
        }
        cleanBody = cleanBody.replace(/file:\/\/\/[^\s"'\)]+/g, "").trim();

        // Pattern 3: Markdown link with file:// or bare path to known workspace dirs
        const workspacePaths = ["/Users/openclaw/skills/qb-cli/workspace/"];
        for (const wsPath of workspacePaths) {
          const barePattern = new RegExp(`(${wsPath.replace("/", "\\/")}[^\\s"'\\)\\]]+\\.pdf)`, "g");
          while ((m = barePattern.exec(payload.text)) !== null) {
            const p = m[1].trim().replace(/[)\]"']+$/, "");
            if (!attachmentPaths.includes(p)) attachmentPaths.push(p);
          }
        }

        // Clean markdown links that pointed to files
        cleanBody = cleanBody.replace(/\[([^\]]+)\]\(file:\/\/[^\)]+\)/g, "$1").trim();
        cleanBody = cleanBody.replace(/\[Download[^\]]+\]\([^\)]+\)/g, "").trim();

        // Validate paths exist before attaching
        const { existsSync } = await import("node:fs");
        const validPaths = attachmentPaths.filter(p => {
          try { return existsSync(p); } catch { return false; }
        });

        // Also handle mediaPath from OpenClaw
        if (payload.mediaPath && !validPaths.includes(payload.mediaPath)) {
          try {
            if (existsSync(payload.mediaPath)) validPaths.push(payload.mediaPath);
          } catch { /* ignore */ }
        }

        if (validPaths.length > 0) {
          log?.info(`[apple-mail][${requestId}] Attaching ${validPaths.length} file(s): ${validPaths.join(", ")}`);
        }

        await sendAppleMailText({
          to: rawMsg?.senderEmail || msg.sender.id,
          text: cleanBody || payload.text,
          accountId,
          cfg,
          threadId: msg.threadId,
          replyToId: msg.channelMessageId,
          subject: replySubject,
          sender: rawMsg?.sender || msg.sender.id,
          attachmentPaths: validPaths,
          client,
        });
      };

      const humanDelay = runtime.channel.reply.resolveHumanDelayConfig(cfg, accountId);

      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          deliver,
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            log?.error(
              `[apple-mail][${requestId}] ${info.kind} reply failed: ${String(err)}`
            );
          },
        },
        replyOptions: {
          disableBlockStreaming:
            typeof amCfg?.blockStreaming === "boolean"
              ? !amCfg.blockStreaming
              : false,
        },
      });

      log?.info(`[apple-mail][${requestId}] Dispatch complete for ${msg.channelMessageId}`);
    } catch (e: unknown) {
      log?.error(
        `[apple-mail][${requestId}] Dispatch failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  });
}

export const appleMailPlugin = createChatChannelPlugin<ResolvedAppleMailAccount>({
  base: {
    id: "apple-mail",
    meta: {
      ...meta,
      id: "apple-mail",
      aliases: ["apple-mail", "applemail", "mail"],
      showConfigured: true,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: true,
      threads: true,
    },
    // Skip stale-socket health check since we use polling
    status: {
      skipStaleSocketHealthCheck: true,
    } as any,
    configSchema: {
      schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: true },
          blockStreaming: { type: "boolean", default: false },
          accounts: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                enabled: { type: "boolean", default: true },
                email: { type: "string" },
                mailboxAccount: { type: "string", default: "iCloud" },
                name: { type: "string" },
                allowFrom: { type: "array", items: { type: "string" } },
                pollIntervalMs: { type: "number", default: 30000 },
                archiveOnReply: { type: "boolean", default: false },
                includeQuotedReplies: { type: "boolean", default: true },
                includeThreadContext: { type: "boolean", default: false },
              },
              required: ["email"],
            },
          },
          defaults: {
            type: "object",
            properties: {
              allowFrom: { type: "array", items: { type: "string" } },
              archiveOnReply: { type: "boolean", default: false },
              includeQuotedReplies: { type: "boolean", default: true },
              includeThreadContext: { type: "boolean", default: false },
            },
          },
        },
      },
    } as any,
    config: {
      listAccountIds: (cfg) => listAppleMailAccountIds(cfg),
      resolveAccount: (cfg, accountId) => resolveAppleMailAccount(cfg, accountId),
      defaultAccountId: (cfg) => resolveDefaultAppleMailAccountId(cfg),
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => Boolean(account.email),
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name || account.email,
        enabled: account.enabled,
        configured: Boolean(account.email),
        linked: Boolean(account.email),
        mode: "polling",
        allowFrom: account.allowFrom,
      }),
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveAppleMailAccount(cfg, accountId ?? undefined).allowFrom ?? [],
      formatAllowFrom: ({ allowFrom }) =>
        allowFrom.map((e: string) => String(e).trim()).filter(Boolean),
      setAccountEnabled: ({ cfg, accountId, enabled }) =>
        setAccountEnabledInConfigSection({
          cfg,
          sectionKey: "apple-mail",
          accountId,
          enabled,
          allowTopLevel: true,
        }),
      deleteAccount: ({ cfg, accountId }) =>
        deleteAccountFromConfigSection({
          cfg,
          sectionKey: "apple-mail",
          accountId,
        }),
    } as any,
    messaging: {
      normalizeTarget: normalizeAppleMailTarget,
      inferTargetChatType: ({ to }: any) => "direct",
      targetResolver: {
        looksLikeId: (id: string) => normalizeAppleMailTarget(id) !== null,
        hint: "email or threadId",
      },
    } as any,
    agentPrompt: {
      messageToolHints: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
        const account = resolveAppleMailAccount(cfg, accountId);
        return [
          "### Apple Mail Channel",
          "- You are responding to an email. Write your reply as plain text.",
          "- Your response will be automatically sent as an email reply in the same thread.",
          "- Always write a response. Never output NO_REPLY or stay silent.",
          "",
          "### Thread Context",
          "- The full email thread history is included above your current message.",
          "- Look for the `=== EMAIL THREAD HISTORY ===` block for prior messages.",
          "- Each prior message is labeled `[YOU - Assistant]` or `[User]`.",
          "- The current new message is at the bottom under `=== CURRENT MESSAGE ===`.",
          "",
          "### Follow-up Responses",
          "- After sub-agents complete, write your follow-up as plain text.",
          "- The channel auto-delivers your text as an email reply.",
          "",
          `- Sending as: ${account.email || "the configured Apple Mail account"}.`,
        ];
      },
    },
    // NO actions block - we don't expose a message tool
    // The channel auto-delivers assistant text via the dispatcher + attachedResults
    gateway: {
      startAccount: async (ctx: any) => {
        ctx.log?.info(`[apple-mail] Account ${ctx.account.accountId} started`);

        const client = new AppleMailClient(ctx.account.mailboxAccount);
        const emailKey = ctx.account.email?.toLowerCase();

        if (emailKey) {
          activeAccounts.set(emailKey, ctx);
          activeClients.set(emailKey, client);
        }

        ctx.setStatus({
          accountId: ctx.accountId,
          running: true,
          connected: true,
        });

        const signal = ctx.abortSignal;

        await monitorAppleMail({
          account: ctx.account,
          onMessage: async (msg) => {
            await dispatchAppleMailMessage(ctx, msg, client);
          },
          signal,
          log: ctx.log,
          setStatus: ctx.setStatus,
          client,
        }).catch((err: unknown) => {
          if (!signal.aborted) {
            ctx.log?.error(`[apple-mail] Monitor error: ${String(err)}`);
          }
        });

        if (emailKey) {
          activeAccounts.delete(emailKey);
          activeClients.delete(emailKey);
        }
        ctx.setStatus({
          accountId: ctx.accountId,
          running: false,
          connected: false,
        });
      },
    } as any,
  },
  threading: appleMailThreading,
  // CRITICAL: This is the BlueBubbles pattern that makes follow-ups work!
  outbound: {
    base: {
      deliveryMode: "direct" as const,
      textChunkLimit: 8000,
      resolveTarget: ({ to, allowFrom }: any) => {
        const trimmed = to?.trim() ?? "";
        const normalized = normalizeAppleMailTarget(trimmed);

        if (!normalized) {
          return {
            ok: false,
            error: missingTargetError("Apple Mail", "email address or thread ID"),
          };
        }

        if (isAppleMailThreadId(normalized)) {
          return { ok: true, to: normalized };
        }

        const allowed = (allowFrom || []).map((e: string) => String(e).trim());
        if (allowed.includes("*")) {
          return { ok: true, to: normalized };
        }

        if (allowed.length > 0) {
          const isAllowed = allowed.some((entry: string) => {
            if (entry === normalized) return true;
            if (entry.startsWith("@") && normalized.endsWith(entry)) return true;
            return false;
          });

          if (!isAllowed) {
            return {
              ok: false,
              error: new Error(`Recipient ${normalized} not in allowList`),
            };
          }
        }

        return { ok: true, to: normalized };
      },
      sendText: async (ctx: any) => {
        const account = resolveAppleMailAccount(ctx.cfg, ctx.accountId);
        const emailKey = account.email?.toLowerCase();
        const client =
          (emailKey && activeClients.get(emailKey)) ||
          new AppleMailClient(account.mailboxAccount);
        return await sendAppleMailText({ ...ctx, client });
      },
      sendMedia: async (ctx: any) => {
        const account = resolveAppleMailAccount(ctx.cfg, ctx.accountId);
        const emailKey = account.email?.toLowerCase();
        const client =
          (emailKey && activeClients.get(emailKey)) ||
          new AppleMailClient(account.mailboxAccount);

        const { mediaPath, mediaPaths, mediaBuffer, mediaUrl, mediaUrls, contentType, filename, text } = ctx;

        // Collect all attachment paths
        const attachmentPaths: string[] = [];

        // 1. Single local path
        if (mediaPath) attachmentPaths.push(mediaPath);

        // 2. Multiple paths
        if (mediaPaths?.length) attachmentPaths.push(...mediaPaths);

        // 3. Buffer (base64 or Buffer) - save to temp
        if (mediaBuffer && !attachmentPaths.length) {
          try {
            const { writeFileSync } = await import("node:fs");
            const { tmpdir } = await import("node:os");
            const ext = contentType?.includes("pdf") ? ".pdf"
              : contentType?.includes("png") ? ".png"
              : contentType?.includes("jpeg") ? ".jpg"
              : contentType?.includes("image") ? ".png"
              : filename?.match(/\.\w+$/)?.[0] || ".bin";
            const tmpFile = `${tmpdir()}/apple-mail-${Date.now()}${ext}`;
            const buf = typeof mediaBuffer === "string" ? Buffer.from(mediaBuffer, "base64") : Buffer.from(mediaBuffer);
            writeFileSync(tmpFile, buf);
            attachmentPaths.push(tmpFile);
          } catch (e) { console.error(`[apple-mail] Failed to save media buffer: ${e}`); }
        }

        // 4. Remote URL - download to temp
        if (mediaUrl && !mediaUrl.startsWith("sandbox:") && !attachmentPaths.length) {
          try {
            const res = await fetch(mediaUrl);
            if (res.ok) {
              const { writeFileSync } = await import("node:fs");
              const { tmpdir } = await import("node:os");
              const arrBuf = await res.arrayBuffer();
              const ext = filename?.match(/\.\w+$/)?.[0] || ".bin";
              const tmpFile = `${tmpdir()}/apple-mail-${Date.now()}${ext}`;
              writeFileSync(tmpFile, Buffer.from(arrBuf));
              attachmentPaths.push(tmpFile);
            }
          } catch (e) { console.error(`[apple-mail] Failed to download ${mediaUrl}: ${e}`); }
        }

        // 5. Multiple URLs
        if (mediaUrls?.length && !attachmentPaths.length) {
          for (const url of mediaUrls) {
            if (url.startsWith("sandbox:")) continue;
            try {
              const res = await fetch(url);
              if (res.ok) {
                const { writeFileSync } = await import("node:fs");
                const { tmpdir } = await import("node:os");
                const arrBuf = await res.arrayBuffer();
                const ext = url.match(/\.\w+$/)?.[0] || ".bin";
                const tmpFile = `${tmpdir()}/apple-mail-${Date.now()}${ext}`;
                writeFileSync(tmpFile, Buffer.from(arrBuf));
                attachmentPaths.push(tmpFile);
              }
            } catch { /* skip failed downloads */ }
          }
        }

        const emailBody = text || (attachmentPaths.length > 0 ? "Please find the attached file(s)." : "");
        return await sendAppleMailText({ ...ctx, text: emailBody, attachmentPaths, client });
      },
    } as any,
    // attachedResults handles follow-up deliveries from sub-agent completions
    // This is THE KEY to making follow-ups work (BlueBubbles pattern)
    attachedResults: {
      channel: "apple-mail",
      sendText: async (ctx: any) => {
        const { cfg, to, text, accountId, replyToId } = ctx;
        const account = resolveAppleMailAccount(cfg, accountId);
        const emailKey = account.email?.toLowerCase();
        const client =
          (emailKey && activeClients.get(emailKey)) ||
          new AppleMailClient(account.mailboxAccount);

        const effectiveThreadId = isAppleMailThreadId(String(to)) ? String(to) : undefined;

        // Auto-detect file attachments using same patterns as deliver
        const attachmentPaths: string[] = [];
        let cleanBody = text;

        // ATTACH: prefix
        const attachPat = /^ATTACH:(.+)$/gm;
        let am: RegExpExecArray | null;
        while ((am = attachPat.exec(text)) !== null) {
          const p = am[1].trim();
          if (p.startsWith("/")) attachmentPaths.push(p);
        }
        cleanBody = cleanBody.replace(/^ATTACH:.+$/gm, "").trim();

        // file:/// URLs
        const fileUrlPat = /file:\/\/\/([^\s"'\)]+)/g;
        while ((am = fileUrlPat.exec(text)) !== null) {
          const p = "/" + am[1].trim().replace(/[)\]"']+$/, "");
          if (!attachmentPaths.includes(p)) attachmentPaths.push(p);
        }
        cleanBody = cleanBody.replace(/\[([^\]]+)\]\(file:\/\/[^\)]+\)/g, "$1").trim();

        // Workspace paths
        const wsPat = /(\/Users\/openclaw\/skills\/qb-cli\/workspace\/[^\s"'\)\]]+\.pdf)/g;
        while ((am = wsPat.exec(text)) !== null) {
          const p = am[1].replace(/[)\]"']+$/, "");
          if (!attachmentPaths.includes(p)) attachmentPaths.push(p);
        }

        const { existsSync } = await import("node:fs");
        const validPaths = attachmentPaths.filter(p => { try { return existsSync(p); } catch { return false; } });

        return await sendAppleMailText({
          to,
          text: cleanBody || text,
          accountId,
          cfg,
          threadId: effectiveThreadId,
          replyToId,
          attachmentPaths: validPaths,
          client,
        });
      },
      sendMedia: async (ctx: any) => {
        const { cfg, to, text, accountId, replyToId, mediaUrl, mediaUrls, mediaPath, mediaPaths, mediaBuffer, contentType, filename } = ctx;
        const account = resolveAppleMailAccount(cfg, accountId);
        const emailKey = account.email?.toLowerCase();
        const client =
          (emailKey && activeClients.get(emailKey)) ||
          new AppleMailClient(account.mailboxAccount);

        const effectiveThreadId = isAppleMailThreadId(String(to)) ? String(to) : undefined;

        const attachmentPaths: string[] = [];
        if (mediaPath) attachmentPaths.push(mediaPath);
        if (mediaPaths?.length) attachmentPaths.push(...mediaPaths);

        if (mediaBuffer && !attachmentPaths.length) {
          try {
            const { writeFileSync } = await import("node:fs");
            const { tmpdir } = await import("node:os");
            const ext = contentType?.includes("pdf") ? ".pdf" : contentType?.includes("image") ? ".png" : ".bin";
            const tmpFile = `${tmpdir()}/apple-mail-${Date.now()}${ext}`;
            const buf = typeof mediaBuffer === "string" ? Buffer.from(mediaBuffer, "base64") : Buffer.from(mediaBuffer);
            writeFileSync(tmpFile, buf);
            attachmentPaths.push(tmpFile);
          } catch { /* ignore */ }
        }

        if (mediaUrl && !mediaUrl.startsWith("sandbox:") && !attachmentPaths.length) {
          try {
            const res = await fetch(mediaUrl);
            if (res.ok) {
              const { writeFileSync } = await import("node:fs");
              const { tmpdir } = await import("node:os");
              const ext = filename?.match(/\.\w+$/)?.[0] || ".bin";
              const tmpFile = `${tmpdir()}/apple-mail-${Date.now()}${ext}`;
              writeFileSync(tmpFile, Buffer.from(await res.arrayBuffer()));
              attachmentPaths.push(tmpFile);
            }
          } catch { /* ignore */ }
        }

        const { existsSync } = await import("node:fs");
        const validPaths = attachmentPaths.filter(p => { try { return existsSync(p); } catch { return false; } });
        const emailBody = text || (validPaths.length > 0 ? "Please find the attached file(s)." : "");

        return await sendAppleMailText({
          to, text: emailBody, accountId, cfg,
          threadId: effectiveThreadId, replyToId,
          attachmentPaths: validPaths, client,
        });
      },
    },
  } as any,
});
