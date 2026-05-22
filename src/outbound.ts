import { type OutboundContext, type OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveAppleMailAccount } from "./accounts.js";
import { isAppleMailThreadId, isAllowed } from "./normalize.js";
import type { AppleMailConfig } from "./config.js";
import type { AppleMailClient } from "./applescript-client.js";

export interface AppleMailOutboundContext extends OutboundContext {
  subject?: string;
  threadId?: string;
  replyToId?: string;
  sender?: string;
  attachmentPaths?: string[];
  client: AppleMailClient;
}

// Thread metadata cache - stores subject per threadId so follow-ups can find the thread
export const threadSubjectCache = new Map<string, string>();

/**
 * Send an email via Apple Mail
 */
export async function sendAppleMailText(ctx: AppleMailOutboundContext) {
  const { to, text, accountId, cfg, threadId, replyToId, subject: explicitSubject, sender, attachmentPaths = [], client } = ctx;
  const account = resolveAppleMailAccount(cfg, accountId);
  const amCfg = cfg.channels?.["apple-mail"] as AppleMailConfig | undefined;

  // If 'to' looks like a thread ID, use it as threadId
  const toIsThreadId = to && isAppleMailThreadId(String(to));
  const effectiveThreadId = (threadId && isAppleMailThreadId(String(threadId)))
    ? String(threadId)
    : (toIsThreadId ? String(to) : undefined);

  if (!to && !effectiveThreadId && !replyToId) {
    throw new Error("Apple Mail send requires a valid 'to' address, thread ID, or reply target");
  }

  // Determine outbound restrictions
  const accountCfg = amCfg?.accounts?.[accountId || "default"];
  const allowOutboundTo = accountCfg?.allowOutboundTo
    ?? amCfg?.defaults?.allowOutboundTo
    ?? account.allowFrom
    ?? [];

  // Cache subject for future follow-ups in this thread
  if (effectiveThreadId && explicitSubject) {
    const cleanSubj = explicitSubject.replace(/^(Re:|RE:|re:|Fwd:|FWD:|fwd:|Fw:|FW:|fw:)\s*/g, "").trim();
    if (cleanSubj) {
      threadSubjectCache.set(effectiveThreadId, cleanSubj);
    }
  }

  const cachedSubject = effectiveThreadId ? threadSubjectCache.get(effectiveThreadId) : undefined;
  const subject = explicitSubject || (cachedSubject ? `Re: ${cachedSubject}` : "(no subject)");

  // PRIORITY 1: If we have a replyToId (specific message), reply to that message
  if (replyToId) {
    const result = await client.replyToMessage(
      String(replyToId),
      sender || "",
      subject,
      text,
      attachmentPaths
    );

    if (!result.success) {
      // If replyToId lookup failed but we have a threadId, try replying to the thread
      if (effectiveThreadId && cachedSubject) {
        console.log(`[apple-mail] replyToId failed, trying replyToThread for thread ${effectiveThreadId}`);
        const threadResult = await client.replyToThread(effectiveThreadId, cachedSubject, text, attachmentPaths);
        if (threadResult.success) {
          return { channel: "apple-mail", messageId: "sent" };
        }
      }
      throw new Error(`Failed to send Apple Mail reply: ${result.error}`);
    }

    // Archive if configured
    const archiveOnReply = accountCfg?.archiveOnReply
      ?? amCfg?.defaults?.archiveOnReply
      ?? false;
    if (archiveOnReply) {
      client.archiveMessage(String(replyToId)).catch((err) => {
        console.error(`[apple-mail] Failed to archive message: ${err}`);
      });
    }

    return { channel: "apple-mail", messageId: "sent" };
  }

  // PRIORITY 2: We have a thread ID - reply to the latest message in that thread
  if (effectiveThreadId && cachedSubject) {
    const result = await client.replyToThread(effectiveThreadId, cachedSubject, text, attachmentPaths);
    if (!result.success) {
      throw new Error(`Failed to send Apple Mail thread reply: ${result.error}`);
    }
    return { channel: "apple-mail", messageId: "sent" };
  }

  // PRIORITY 3: Send a new email to the given address
  if (to && !isAppleMailThreadId(String(to))) {
    // Check outbound allowlist
    if (allowOutboundTo.length > 0 && !isAllowed(String(to), allowOutboundTo)) {
      throw new Error(`Direct email to ${to} blocked: not in allowOutboundTo list.`);
    }

    const result = await client.sendNewEmail(String(to), subject, text, attachmentPaths);
    if (!result.success) {
      throw new Error(`Failed to send new email: ${result.error}`);
    }
    return { channel: "apple-mail", messageId: "sent" };
  }

  throw new Error(
    `Apple Mail: cannot determine how to send - to=${to}, threadId=${effectiveThreadId}, cached_subject=${cachedSubject}`
  );
}
