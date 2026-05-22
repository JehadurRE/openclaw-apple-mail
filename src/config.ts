import { z } from "zod";

export const AppleMailAccountSchema = z.object({
  accountId: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().default(true),
  email: z.string(), // The Apple Mail email address (e.g., nextgensolutionsai@icloud.com)
  mailboxAccount: z.string().default("iCloud"), // Apple Mail account name (iCloud, Gmail, etc.)
  allowFrom: z.array(z.string()).default([]),
  pollIntervalMs: z.number().optional(), // Polling interval in ms (default 60s)
  // Reply behavior
  includeQuotedReplies: z.boolean().optional(), // Include thread history in replies (default: true)
  // Outbound restrictions (security)
  allowOutboundTo: z.array(z.string()).optional(),
  threadReplyPolicy: z.enum(["open", "allowlist", "sender-only"]).optional(),
  archiveOnReply: z.boolean().optional(), // Archive thread after reply (default: false for Apple Mail)
  includeThreadContext: z.boolean().optional(),
});

export const AppleMailConfigSchema = z.object({
  enabled: z.boolean().default(true),
  blockStreaming: z.boolean().optional(),
  accounts: z.record(AppleMailAccountSchema).optional(),
  defaults: z.object({
    allowFrom: z.array(z.string()).optional(),
    includeQuotedReplies: z.boolean().default(true),
    allowOutboundTo: z.array(z.string()).optional(),
    threadReplyPolicy: z.enum(["open", "allowlist", "sender-only"]).optional(),
    archiveOnReply: z.boolean().optional(),
    includeThreadContext: z.boolean().optional(),
  }).optional(),
});

export type AppleMailConfig = z.infer<typeof AppleMailConfigSchema>;
export type AppleMailAccount = z.infer<typeof AppleMailAccountSchema>;
