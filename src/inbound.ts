import { type InboundMessage } from "openclaw/plugin-sdk";
import type { AppleMailMessage, AppleMailClient } from "./applescript-client.js";
import { generateThreadId, cleanSubject } from "./normalize.js";

/**
 * Parse an Apple Mail message into an OpenClaw InboundMessage
 */
export function parseInboundAppleMail(
  msg: AppleMailMessage,
  accountId?: string,
  accountEmail?: string
): InboundMessage | null {
  // Self-reply prevention
  if (accountEmail && msg.senderEmail.toLowerCase() === accountEmail.toLowerCase()) {
    return null;
  }

  // Generate thread ID from subject + sender
  const threadId = generateThreadId(msg.subject, msg.sender);

  const fullText = `[Thread Context: ID=${threadId}, Subject="${msg.subject}"]\n\n${msg.body}`;

  return {
    channelId: "apple-mail",
    accountId,
    channelMessageId: msg.messageId,
    threadId,
    text: fullText,
    sender: {
      id: msg.senderEmail,
      name: msg.senderName,
      isBot: false,
    },
    raw: msg,
    isGroup: false,
    replyTo: {
      channelMessageId: msg.messageId,
    },
    // Use current time as timestamp - AppleScript date strings are unreliable
    // The processing time is more useful for the AI's context anyway
    timestamp: Date.now(),
  };
}

/**
 * Enrich an inbound message with the full thread history.
 * Includes all prior messages in the thread (oldest first) so the AI can see
 * the full conversation context.
 *
 * @param msg The current inbound message
 * @param amMsg The raw Apple Mail message (has subject, sender, body)
 * @param client AppleMailClient to fetch thread messages
 * @param accountEmail Account email (to filter out self-sent replies if needed)
 * @returns Updated InboundMessage with thread history prepended
 */
export async function enrichWithThreadHistory(
  msg: InboundMessage,
  amMsg: AppleMailMessage,
  client: AppleMailClient,
  accountEmail?: string
): Promise<InboundMessage> {
  try {
    // Fetch all messages in this thread (matches by clean subject)
    const threadMessages = await client.getThreadMessages(amMsg.subject, 30);

    // Filter out the current message (it'll be shown separately)
    const priorMessages = threadMessages.filter(
      (tm) => tm.messageId !== amMsg.messageId
    );

    if (priorMessages.length === 0) {
      // First message in thread - no history needed
      return msg;
    }

    // Sort prior messages by date (oldest first for context flow)
    priorMessages.sort((a, b) => {
      const parseDate = (d: string) => {
        const clean = d.replace(/\s+at\s+/i, " ").replace(/\u202F/g, " ").replace(/\s+/g, " ").trim();
        const t = Date.parse(clean);
        return isNaN(t) ? 0 : t;
      };
      return parseDate(a.date) - parseDate(b.date);
    });

    // Build thread history block
    const historyBlock: string[] = [];
    historyBlock.push(`=== EMAIL THREAD HISTORY (${priorMessages.length} prior message${priorMessages.length > 1 ? "s" : ""}, oldest first) ===`);
    historyBlock.push("");

    for (let i = 0; i < priorMessages.length; i++) {
      const pm = priorMessages[i];
      const isFromAssistant = accountEmail && pm.senderEmail.toLowerCase() === accountEmail.toLowerCase();
      const senderLabel = isFromAssistant ? "[YOU - Assistant]" : "[User]";
      historyBlock.push(`--- Message ${i + 1} of ${priorMessages.length} ${senderLabel} ---`);
      historyBlock.push(`From: ${pm.sender}`);
      historyBlock.push(`Date: ${pm.date}`);
      historyBlock.push(`Subject: ${pm.subject}`);
      historyBlock.push("");
      historyBlock.push(pm.body || "(no content)");
      historyBlock.push("");
    }

    historyBlock.push("=== END OF THREAD HISTORY ===");
    historyBlock.push("");
    historyBlock.push("=== CURRENT MESSAGE (the new email you need to respond to) ===");
    historyBlock.push("");

    const enrichedText = `[Thread Context: ID=${msg.threadId}, Subject="${amMsg.subject}"]\n\n${historyBlock.join("\n")}${amMsg.body}`;

    return {
      ...msg,
      text: enrichedText,
    };
  } catch (err) {
    // Graceful fallback - return original message if thread fetch fails
    console.error(`[apple-mail] Failed to enrich thread history: ${String(err)}`);
    return msg;
  }
}
