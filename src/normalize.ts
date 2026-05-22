import crypto from "node:crypto";

/**
 * Apple Mail thread IDs are generated from subject + sender hash
 * Format: 16-char hex string
 */
export function isAppleMailThreadId(id: string): boolean {
  return /^[0-9a-fA-F]{16}$/.test(id) && !id.includes("@");
}

export function isEmail(id: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
}

export function normalizeAppleMailTarget(raw: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  if (isEmail(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (isAppleMailThreadId(trimmed)) {
    return trimmed.toLowerCase();
  }

  return null;
}

/**
 * Extract email address from sender string like "Name <email@domain.com>"
 */
export function extractEmailAddress(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  if (match) return match[1].trim().toLowerCase();
  return sender.trim().toLowerCase();
}

/**
 * Clean subject by removing Re:, Fwd:, etc. prefixes
 */
export function cleanSubject(subject: string): string {
  let clean = subject;
  const prefixes = ["Re:", "RE:", "re:", "Fwd:", "FWD:", "fwd:", "Fw:", "FW:", "fw:"];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (clean.startsWith(prefix + " ")) {
        clean = clean.substring(prefix.length + 1);
        changed = true;
      } else if (clean.startsWith(prefix)) {
        clean = clean.substring(prefix.length);
        changed = true;
      }
    }
    clean = clean.trim();
  }
  return clean;
}

/**
 * Generate stable thread ID from subject and sender email
 * md5(clean_subject:sender_email).slice(0, 16)
 */
export function generateThreadId(subject: string, sender: string): string {
  const cleanSubj = cleanSubject(subject);
  const senderEmail = extractEmailAddress(sender);
  const threadStr = `${cleanSubj}:${senderEmail}`.toLowerCase();
  return crypto.createHash("md5").update(threadStr).digest("hex").slice(0, 16);
}

export function isAllowed(senderId: string, allowList: string[]): boolean {
  if (allowList.length === 0) return false;
  if (allowList.includes("*")) return true;

  const normalizedSender = senderId.toLowerCase();
  return allowList.some((entry) => {
    const normalized = entry.toLowerCase().trim();
    if (!normalized) return false;
    if (normalizedSender === normalized) return true;
    // Domain wildcard (@company.com)
    if (normalized.startsWith("@") && normalizedSender.endsWith(normalized)) {
      return true;
    }
    return false;
  });
}
