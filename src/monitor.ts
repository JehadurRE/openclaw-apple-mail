import type { ChannelLogSink, InboundMessage } from "openclaw/plugin-sdk";
import type { ResolvedAppleMailAccount } from "./accounts.js";
import type { AppleMailClient } from "./applescript-client.js";
import { parseInboundAppleMail, enrichWithThreadHistory } from "./inbound.js";
import { isAllowed } from "./normalize.js";

const DEFAULT_POLL_INTERVAL = 30_000; // 30 seconds default

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });

// Local deduplication cache
const dispatchedMessageIds = new Set<string>();
setInterval(() => dispatchedMessageIds.clear(), 60 * 60 * 1000).unref();

export async function monitorAppleMail(params: {
  account: ResolvedAppleMailAccount;
  onMessage: (msg: InboundMessage) => Promise<void>;
  signal: AbortSignal;
  log: ChannelLogSink;
  setStatus: (status: any) => void;
  client: AppleMailClient;
}) {
  const { account, onMessage, signal, log, setStatus, client } = params;

  // Verify Mail.app is accessible
  const connected = await client.checkConnection();
  if (!connected) {
    log.error(`Apple Mail not accessible for account: ${account.mailboxAccount}`);
    setStatus({
      accountId: account.accountId,
      running: false,
      connected: false,
      error: "Mail.app not accessible or account not found",
    });
    return;
  }

  // Record start time - only process emails received AFTER this
  const monitorStartTime = Date.now();
  log.info(
    `Starting Apple Mail monitor for ${account.email} (mailbox: ${account.mailboxAccount})`
  );
  log.info(
    `[apple-mail] Will only process emails received after: ${new Date(monitorStartTime).toISOString()}`
  );

  // Set initial connected status with proper mode
  setStatus({
    accountId: account.accountId,
    running: true,
    connected: true,
    mode: "polling",
    lastConnectedAt: Date.now(),
    lastError: undefined,
  });

  log.info(`[apple-mail] Initial status set (connected=true, mode=polling). Starting poll loop with interval: ${account.pollIntervalMs || DEFAULT_POLL_INTERVAL}ms`);

  let isSyncing = false;
  const pollInterval = account.pollIntervalMs || DEFAULT_POLL_INTERVAL;
  let lastStatusUpdate = Date.now();

  while (!signal.aborted) {
    try {
      await sleep(pollInterval, signal);
      if (signal.aborted) break;

      if (isSyncing) {
        log.warn(`Sync already in progress for ${account.email}, skipping`);
        continue;
      }

      isSyncing = true;
      try {
        log.info(`[apple-mail] Polling for unread messages...`);
        const unreadMessages = await client.getUnreadMessages(50, account.email);

        // Always update status to keep channel marked as connected
        // (prevents health-monitor from restarting the plugin)
        // Also force update every 2 minutes even if no new messages
        const now = Date.now();
        if (unreadMessages.length === 0 || (now - lastStatusUpdate) > 120000) {
          setStatus({
            accountId: account.accountId,
            running: true,
            connected: true,
            mode: "polling",
            lastEventAt: now,
            lastConnectedAt: now,
            lastError: undefined,
          });
          lastStatusUpdate = now;
        }

        if (unreadMessages.length === 0) {
          continue;
        }

        log.info(`[apple-mail] Found ${unreadMessages.length} unread messages`);

        for (const amMsg of unreadMessages) {
          if (signal.aborted) break;

          // Skip if already dispatched
          if (dispatchedMessageIds.has(amMsg.messageId)) continue;

          // Parse date and check if email is newer than monitor start time
          const msgTimestamp = Date.parse(amMsg.date);
          if (!isNaN(msgTimestamp) && msgTimestamp < monitorStartTime) {
            log.info(
              `[apple-mail] Skipping old email (${amMsg.date}) from ${amMsg.senderEmail}: ${amMsg.subject}`
            );
            // Mark as read to prevent re-processing
            await client.markAsRead(amMsg.messageId).catch((err) => {
              log.error(`Failed to mark old message as read: ${err}`);
            });
            dispatchedMessageIds.add(amMsg.messageId);
            continue;
          }

          // Parse into OpenClaw inbound format
          const msg = parseInboundAppleMail(amMsg, account.accountId, account.email);
          if (!msg) continue;

          // Check allowlist
          if (!isAllowed(msg.sender.id, account.allowFrom || [])) {
            log.warn(
              `[apple-mail] Quarantining message from non-allowed sender: ${msg.sender.id}`
            );
            // Mark as read to prevent re-processing
            await client.markAsRead(amMsg.messageId).catch((err) => {
              log.error(`Failed to mark quarantined message as read: ${err}`);
            });
            continue;
          }

          // Enrich with thread history (full conversation context)
          // This way the AI sees the entire thread for context-aware replies
          const enrichedMsg = await enrichWithThreadHistory(
            msg,
            amMsg,
            client,
            account.email
          );

          // Add to dedupe set
          dispatchedMessageIds.add(amMsg.messageId);

          // Debug: log a preview of what's being sent
          const preview = enrichedMsg.text.substring(0, 300).replace(/\n/g, ' ');
          log.info(`[apple-mail] Dispatching with text preview: ${preview}...`);

          try {
            await onMessage(enrichedMsg);
            // Mark as read after successful dispatch
            await client.markAsRead(amMsg.messageId);
            log.info(
              `[apple-mail] Dispatched message ${amMsg.messageId} from ${msg.sender.id}`
            );
          } catch (err) {
            log.error(
              `Failed to dispatch message ${amMsg.messageId}: ${String(err)}`
            );
            // Remove from dedupe to retry next tick
            dispatchedMessageIds.delete(amMsg.messageId);
          }
        }

        setStatus({
          accountId: account.accountId,
          running: true,
          connected: true,
          lastError: undefined,
        });
      } finally {
        isSyncing = false;
      }
    } catch (err: unknown) {
      const msg = String(err);
      log.error(`[apple-mail] Monitor loop error: ${msg}`);
      setStatus({
        accountId: account.accountId,
        running: true,
        connected: false,
        lastError: msg,
      });
    }
  }

  log.info(`[apple-mail] Monitor stopped for ${account.email}`);
}
