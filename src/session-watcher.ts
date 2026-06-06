import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sendAppleMailText } from "./outbound.js";
import type { AppleMailClient } from "./applescript-client.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

/**
 * Watches apple-mail session JSONL files for new assistant messages and
 * forwards them to the email thread when the trigger was NOT an inbound
 * email (e.g., webui, cron, sub-agent).
 *
 * Inbound-email-triggered assistant replies are delivered by the channel's
 * own dispatch flow, so we skip those to prevent duplicates.
 *
 * Features:
 * - Persistent state across restarts
 * - Auto-detection of attachments (PDF paths, file:// URLs)
 * - Per-thread serialization (one send at a time per thread)
 * - Retry with exponential backoff on failure
 * - Automatic cleanup of orphaned state entries
 * - Bounded state file size
 */

const SESSIONS_DIR = "/Users/openclaw/.openclaw/agents/main/sessions";
const STATE_FILE = join(homedir(), ".openclaw", "apple-mail-watcher-state.json");
const POLL_INTERVAL_MS = 5_000;
const MAX_DELIVERED_IDS_PER_FILE = 100;
const MAX_RETRY_ATTEMPTS = 3;
const STATE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // every 10 min
const MAX_STATE_AGE_DAYS = 30; // prune entries older than 30 days

interface PendingRetry {
  text: string;
  attempts: number;
  lastAttemptMs: number;
  nextAttemptMs: number;
  entryId: string;
}

interface WatcherState {
  offsets: Record<string, number>;
  delivered: Record<string, string[]>;
  // Track last-seen timestamp for cleanup of orphaned entries
  lastSeenMs: Record<string, number>;
  // Pending retries per file path
  pending: Record<string, PendingRetry[]>;
}

function loadState(): WatcherState {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        offsets: parsed.offsets || {},
        delivered: parsed.delivered || {},
        lastSeenMs: parsed.lastSeenMs || {},
        pending: parsed.pending || {},
      };
    }
  } catch {
    /* ignore */
  }
  return { offsets: {}, delivered: {}, lastSeenMs: {}, pending: {} };
}

function saveState(state: WatcherState): void {
  try {
    const dir = join(homedir(), ".openclaw");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error(`[apple-mail-watcher] Failed to save state: ${err}`);
  }
}

const state = loadState();

// Per-thread mutex map - prevents concurrent sends to the same thread
const threadLocks = new Map<string, Promise<void>>();

async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = threadLocks.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(r => { release = r; });
  threadLocks.set(threadId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Clean up if we're the last in line
    if (threadLocks.get(threadId) === next) threadLocks.delete(threadId);
  }
}

function extractThreadId(fileName: string): string | null {
  const m = fileName.match(/-topic-([0-9a-f]{16})\.jsonl$/);
  return m ? m[1] : null;
}

function getMessageText(msg: any): string {
  const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
  let blob = "";
  for (const p of parts) {
    if (typeof p === "string") blob += p;
    else if (p && p.type === "text") blob += p.text || "";
  }
  return blob;
}

function detectUserSource(text: string): "email" | "webui" | "cron" | "unknown" {
  if (text.includes('"label": "openclaw-control-ui"') || text.includes('"id": "openclaw-control-ui"')) {
    return "webui";
  }
  if (text.includes("scheduled reminder has been triggered")) {
    return "cron";
  }
  // Apple Mail inbound markers - check both patterns
  if (text.includes("Apple Mail thread") || text.includes('"channel": "apple-mail"')) {
    return "email";
  }
  if (text.includes("sender_id") && /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+/.test(text)) {
    return "email";
  }
  return "unknown";
}

function buildEntryId(entry: any): string {
  return entry.id || entry.uuid || entry.message?.id || entry.timestamp || JSON.stringify(entry).slice(0, 64);
}

/**
 * Extract attachment paths from assistant text, matching the same patterns
 * the inbound deliver function uses. If no path is found in the text but
 * the text mentions an attachment, fall back to scanning the session for
 * the most recent subagent PDF result.
 */
function extractAttachmentsAndCleanText(text: string, sessionFilePath?: string): { cleanText: string; paths: string[] } {
  const paths: string[] = [];
  let cleanText = text;

  // Pattern 1: ATTACH:/absolute/path
  const attachPattern = /^ATTACH:(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = attachPattern.exec(text)) !== null) {
    const p = m[1].trim();
    if (p.startsWith("/") && !paths.includes(p)) paths.push(p);
  }
  cleanText = cleanText.replace(/^ATTACH:.+$/gm, "").trim();

  // Pattern 2: file:///absolute/path
  const fileUrlPattern = /file:\/\/\/([^\s"'\)]+)/g;
  while ((m = fileUrlPattern.exec(text)) !== null) {
    const p = "/" + m[1].trim().replace(/[)\]"']+$/, "");
    if (!paths.includes(p)) paths.push(p);
  }
  cleanText = cleanText.replace(/file:\/\/\/[^\s"'\)]+/g, "").trim();

  // Pattern 3: Bare workspace paths to PDFs
  const wsPattern = /(\/Users\/openclaw\/skills\/qb-cli\/workspace\/[^\s"'\)\]]+\.pdf)/g;
  while ((m = wsPattern.exec(text)) !== null) {
    const p = m[1].replace(/[)\]"']+$/, "");
    if (!paths.includes(p)) paths.push(p);
  }

  // Clean markdown links pointing to files
  cleanText = cleanText.replace(/\[([^\]]+)\]\(file:\/\/[^\)]+\)/g, "$1").trim();
  cleanText = cleanText.replace(/\[Download[^\]]+\]\([^\)]+\)/g, "").trim();

  // Validate paths exist on disk
  let validPaths = paths.filter(p => {
    try { return existsSync(p); } catch { return false; }
  });

  // FALLBACK: assistant mentions attachment but didn't include path
  if (validPaths.length === 0 && sessionFilePath) {
    const mentionsAttachment = /attach(ed|ment)|\bpdf\b|purchase order|invoice|receipt|download/i.test(text);
    if (mentionsAttachment) {
      const fallback = findLatestPdfInSession(sessionFilePath);
      if (fallback) validPaths.push(fallback);
    }
  }

  return { cleanText: cleanText || text, paths: validPaths };
}

/**
 * Walk session JSONL backward to find the most recent subagent completion
 * event. Returns the file path from inside the subagent result.
 *
 * Safety constraints:
 * - Only scans the provided session file (this thread only)
 * - Requires the BEGIN_OPENCLAW_INTERNAL_CONTEXT marker (subagent result)
 * - Only considers events from the last 10 minutes
 * - Validates the file exists before returning
 */
function findLatestPdfInSession(sessionFilePath: string): string | null {
  try {
    const content = readFileSync(sessionFilePath, "utf-8");
    const lines = content.split("\n");
    const MAX_AGE_MS = 10 * 60 * 1000;
    const now = Date.now();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg || msg.role !== "user") continue;

      // Time bound - skip stale entries
      if (entry.timestamp) {
        const tsMs = Date.parse(entry.timestamp);
        if (!isNaN(tsMs) && now - tsMs > MAX_AGE_MS) break;
      }

      const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
      let blob = "";
      for (const p of parts) {
        if (typeof p === "string") blob += p;
        else if (p && p.type === "text") blob += p.text || "";
      }

      // Require subagent completion marker
      const isSubagentResult =
        blob.includes("BEGIN_OPENCLAW_INTERNAL_CONTEXT") &&
        blob.includes("subagent task") &&
        blob.includes("status: completed");
      if (!isSubagentResult) continue;

      const fileUrl = blob.match(/file:\/\/\/([^\s"'\)]+)/);
      if (fileUrl) {
        const path = "/" + fileUrl[1].replace(/[)\]"']+$/, "");
        if (existsSync(path)) return path;
      }
      const ws = blob.match(/\/Users\/openclaw\/skills\/qb-cli\/workspace\/[^\s"'\)\]]+\.pdf/);
      if (ws) {
        const path = ws[0].replace(/[)\]"']+$/, "");
        if (existsSync(path)) return path;
      }

      // Found subagent result but no path - stop, don't keep walking
      break;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Periodic cleanup: remove state entries for session files that no longer
 * exist (deleted by user) or that we haven't seen in a long time.
 */
function cleanupStaleState(log?: { info: (m: string) => void }): void {
  const now = Date.now();
  const ageThresholdMs = MAX_STATE_AGE_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const filePath of Object.keys(state.offsets)) {
    const fileExists = existsSync(filePath);
    const lastSeen = state.lastSeenMs[filePath] ?? now;
    const ageMs = now - lastSeen;

    if (!fileExists || ageMs > ageThresholdMs) {
      delete state.offsets[filePath];
      delete state.delivered[filePath];
      delete state.lastSeenMs[filePath];
      delete state.pending[filePath];
      removed++;
    }
  }

  if (removed > 0) {
    log?.info(`[apple-mail-watcher] Cleaned up ${removed} stale state entries`);
    saveState(state);
  }
}

/**
 * Send with retry. Returns true on success.
 */
async function deliverWithRetry(params: {
  threadId: string;
  text: string;
  cfg: OpenClawConfig;
  accountId: string;
  client: AppleMailClient;
  log?: { info: (m: string) => void; error: (m: string) => void };
  source: string;
  sessionFilePath?: string;
}): Promise<boolean> {
  const { threadId, text, cfg, accountId, client, log, source, sessionFilePath } = params;
  const { cleanText, paths } = extractAttachmentsAndCleanText(text, sessionFilePath);

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const preview = cleanText.slice(0, 80).replace(/\n/g, " ");
      log?.info(`[apple-mail-watcher] ${source}-triggered reply -> thread ${threadId} (attempt ${attempt}, ${paths.length} attachments): "${preview}"`);

      await sendAppleMailText({
        to: threadId,
        text: cleanText,
        accountId,
        cfg,
        threadId,
        attachmentPaths: paths,
        client,
      } as any);

      log?.info(`[apple-mail-watcher] Delivered to thread ${threadId}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error(`[apple-mail-watcher] Send failed (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}) for thread ${threadId}: ${msg}`);
      if (attempt < MAX_RETRY_ATTEMPTS) {
        // Exponential backoff: 2s, 4s, 8s
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }

  return false;
}

async function processSessionFile(params: {
  filePath: string;
  threadId: string;
  cfg: OpenClawConfig;
  accountId: string;
  accountEmail: string;
  client: AppleMailClient;
  log?: { info: (m: string) => void; error: (m: string) => void };
}): Promise<void> {
  const { filePath, threadId, cfg, accountId, client, log } = params;

  let stat;
  try { stat = statSync(filePath); } catch { return; }

  state.lastSeenMs[filePath] = Date.now();

  const lastOffset = state.offsets[filePath] ?? -1;

  // First time seeing this file: snapshot size, don't replay history
  if (lastOffset === -1) {
    state.offsets[filePath] = stat.size;
    saveState(state);
    return;
  }

  if (stat.size <= lastOffset) return;

  let fullContent: string;
  try {
    fullContent = readFileSync(filePath, "utf-8");
  } catch (err) {
    log?.error(`[apple-mail-watcher] Failed to read ${filePath}: ${err}`);
    return;
  }

  const newOffset = stat.size;
  const deliveredSet = new Set(state.delivered[filePath] || []);

  // Walk lines tracking byte position. Detect new assistant messages and
  // their trigger source.
  let bytePos = 0;
  let mostRecentUserSource: "email" | "webui" | "cron" | "unknown" | null = null;

  // Collect deliveries first, then perform them serially under thread lock
  const deliveries: { text: string; entryId: string; source: string }[] = [];

  const lines = fullContent.split("\n");
  for (const line of lines) {
    const lineStart = bytePos;
    bytePos += line.length + 1; // +1 for \n

    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: any;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "user") {
      mostRecentUserSource = detectUserSource(getMessageText(msg));
      continue;
    }

    if (msg.role === "assistant") {
      if (lineStart < lastOffset) continue;
      if (mostRecentUserSource === null) continue;
      // OpenClaw natively delivers replies for email (inbound dispatcher),
      // cron (heartbeat/attachedResults), and sub-agent (attachedResults).
      // The watcher ONLY handles webui-driven turns - the one path OpenClaw
      // doesn't route back to the channel automatically.
      if (mostRecentUserSource !== "webui") continue;

      const text = getMessageText(msg);
      if (!text.trim()) continue;
      const id = buildEntryId(entry);
      if (deliveredSet.has(id)) continue;

      deliveries.push({ text, entryId: id, source: mostRecentUserSource });
    }
  }

  // Update offset and persist BEFORE attempting delivery
  // This prevents replaying the same lines if delivery fails permanently
  state.offsets[filePath] = newOffset;
  saveState(state);

  // Deliver under per-thread lock so multiple message bursts don't race
  if (deliveries.length > 0) {
    await withThreadLock(threadId, async () => {
      for (const d of deliveries) {
        const ok = await deliverWithRetry({
          threadId,
          text: d.text,
          cfg,
          accountId,
          client,
          log,
          source: d.source,
          sessionFilePath: filePath,
        });

        if (ok) {
          deliveredSet.add(d.entryId);
        } else {
          // Persist as pending retry for next loop iteration
          if (!state.pending[filePath]) state.pending[filePath] = [];
          state.pending[filePath].push({
            text: d.text,
            attempts: MAX_RETRY_ATTEMPTS,
            lastAttemptMs: Date.now(),
            nextAttemptMs: Date.now() + 60_000, // retry in 60s
            entryId: d.entryId,
          });
          log?.error(`[apple-mail-watcher] All retries exhausted for thread ${threadId}, queued for delayed retry`);
        }

        state.delivered[filePath] = [...deliveredSet].slice(-MAX_DELIVERED_IDS_PER_FILE);
        saveState(state);
      }
    });
  }
}

/**
 * Process queued retries (deliveries that failed all in-loop retries).
 */
async function processPendingRetries(params: {
  cfg: OpenClawConfig;
  accountId: string;
  client: AppleMailClient;
  log?: { info: (m: string) => void; error: (m: string) => void };
}): Promise<void> {
  const { cfg, accountId, client, log } = params;
  const now = Date.now();

  for (const [filePath, queue] of Object.entries(state.pending)) {
    if (!queue || queue.length === 0) continue;
    const threadId = extractThreadId(filePath.split("/").pop() || "");
    if (!threadId) continue;

    const remaining: PendingRetry[] = [];
    for (const item of queue) {
      if (item.nextAttemptMs > now) {
        remaining.push(item);
        continue;
      }

      await withThreadLock(threadId, async () => {
        const ok = await deliverWithRetry({
          threadId,
          text: item.text,
          cfg,
          accountId,
          client,
          log,
          source: "retry",
          sessionFilePath: filePath,
        });

        if (ok) {
          const deliveredSet = new Set(state.delivered[filePath] || []);
          deliveredSet.add(item.entryId);
          state.delivered[filePath] = [...deliveredSet].slice(-MAX_DELIVERED_IDS_PER_FILE);
        } else {
          item.attempts += MAX_RETRY_ATTEMPTS;
          item.lastAttemptMs = now;
          // Backoff: 1min, 5min, 15min, 30min, capped
          const minutes = Math.min(30, item.attempts * 5);
          item.nextAttemptMs = now + minutes * 60_000;
          // Drop after 24 hours of total retry time
          if (now - item.lastAttemptMs < 24 * 60 * 60 * 1000) {
            remaining.push(item);
          } else {
            log?.error(`[apple-mail-watcher] Dropping permanently-failed delivery for thread ${threadId}`);
          }
        }
      });
    }

    if (remaining.length > 0) {
      state.pending[filePath] = remaining;
    } else {
      delete state.pending[filePath];
    }
  }

  saveState(state);
}

export async function startSessionWatcher(params: {
  cfg: OpenClawConfig;
  accountId: string;
  accountEmail: string;
  client: AppleMailClient;
  signal: AbortSignal;
  log?: { info: (m: string) => void; error: (m: string) => void };
}): Promise<void> {
  const { cfg, accountId, accountEmail, client, signal, log } = params;
  log?.info(`[apple-mail-watcher] Started for ${accountEmail}`);

  let lastCleanupMs = 0;

  while (!signal.aborted) {
    try {
      // Periodic cleanup
      const now = Date.now();
      if (now - lastCleanupMs > STATE_CLEANUP_INTERVAL_MS) {
        cleanupStaleState(log);
        lastCleanupMs = now;
      }

      // Process pending retries first
      await processPendingRetries({ cfg, accountId, client, log });

      if (!existsSync(SESSIONS_DIR)) {
        await sleep(POLL_INTERVAL_MS, signal);
        continue;
      }

      const files = readdirSync(SESSIONS_DIR);
      for (const fileName of files) {
        if (signal.aborted) break;
        if (!fileName.endsWith(".jsonl")) continue;
        const threadId = extractThreadId(fileName);
        if (!threadId) continue;

        const filePath = join(SESSIONS_DIR, fileName);
        await processSessionFile({
          filePath, threadId, cfg, accountId, accountEmail, client, log,
        });
      }
    } catch (err) {
      log?.error(`[apple-mail-watcher] Loop error: ${err}`);
    }

    await sleep(POLL_INTERVAL_MS, signal);
  }

  log?.info(`[apple-mail-watcher] Stopped`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
