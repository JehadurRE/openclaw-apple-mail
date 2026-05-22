import {
  type ChannelConfig,
  type ResolvedChannelAccount,
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk";
import type { AppleMailConfig } from "./config.js";

export interface ResolvedAppleMailAccount extends ResolvedChannelAccount {
  email: string;
  mailboxAccount: string;
  pollIntervalMs?: number;
  includeThreadContext?: boolean;
  includeQuotedReplies?: boolean;
  archiveOnReply?: boolean;
  allowOutboundTo?: string[];
  threadReplyPolicy?: "open" | "allowlist" | "sender-only";
}

/**
 * Normalize account key (email-format to hyphenated)
 * e.g., "nextgensolutionsai@icloud.com" -> "nextgensolutionsai-icloud-com"
 */
function canonicalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

export function resolveAppleMailAccount(
  cfg: ChannelConfig<AppleMailConfig>,
  accountId?: string,
): ResolvedAppleMailAccount {
  const resolvedId = accountId || DEFAULT_ACCOUNT_ID;
  const accounts = cfg.channels?.['apple-mail']?.accounts;
  let account = accounts?.[resolvedId];

  // Try canonical key match for email-format accountIds
  if (!account && accounts && resolvedId !== DEFAULT_ACCOUNT_ID) {
    const canonicalizedId = canonicalizeKey(resolvedId);
    for (const key of Object.keys(accounts)) {
      if (canonicalizeKey(key) === canonicalizedId) {
        account = accounts[key];
        break;
      }
    }
  }

  if (!account) {
    // Graceful fallback
    return {
      accountId: resolvedId,
      name: resolvedId,
      enabled: false,
      email: "",
      mailboxAccount: "iCloud",
      allowFrom: [],
      pollIntervalMs: undefined,
    };
  }

  const defaults = cfg.channels?.['apple-mail']?.defaults;

  return {
    accountId: resolvedId,
    name: account.name || account.email,
    enabled: account.enabled,
    email: account.email,
    mailboxAccount: account.mailboxAccount || "iCloud",
    allowFrom: account.allowFrom,
    pollIntervalMs: account.pollIntervalMs,
    includeThreadContext: account.includeThreadContext ?? (defaults as any)?.includeThreadContext ?? false,
    includeQuotedReplies: account.includeQuotedReplies ?? (defaults as any)?.includeQuotedReplies ?? true,
    archiveOnReply: account.archiveOnReply ?? (defaults as any)?.archiveOnReply ?? false,
    allowOutboundTo: account.allowOutboundTo ?? (defaults as any)?.allowOutboundTo,
    threadReplyPolicy: account.threadReplyPolicy ?? (defaults as any)?.threadReplyPolicy ?? "open",
  };
}

export function listAppleMailAccountIds(cfg: ChannelConfig<AppleMailConfig>): string[] {
  return Object.keys(cfg.channels?.['apple-mail']?.accounts || {});
}

export function resolveDefaultAppleMailAccountId(cfg: ChannelConfig<AppleMailConfig>): string {
  const ids = listAppleMailAccountIds(cfg);
  if (ids.length === 0) return DEFAULT_ACCOUNT_ID;
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0];
}
