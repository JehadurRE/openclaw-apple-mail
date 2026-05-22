import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface AppleMailMessage {
  messageId: string;
  threadId?: string; // Computed from subject+sender
  subject: string;
  sender: string; // "Name <email@domain.com>"
  senderEmail: string;
  senderName?: string;
  date: string;
  body: string;
  htmlBody?: string;
  mailboxAccount: string;
  isRead: boolean;
}

export class AppleMailClient {
  constructor(private mailboxAccount: string = "iCloud") {}

  /**
   * Escape string for AppleScript
   */
  private escapeApplescript(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /**
   * Run an AppleScript and return stdout
   */
  private async runScript(script: string, timeout: number = 30000): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(
        `osascript -e '${script.replace(/'/g, "'\\''")}'`,
        { timeout, maxBuffer: 10 * 1024 * 1024 }
      );
      if (stderr) {
        console.error("[apple-mail] AppleScript stderr:", stderr);
      }
      return stdout.trim();
    } catch (err: any) {
      throw new Error(`AppleScript execution failed: ${err.message}`);
    }
  }

  /**
   * Fetch unread messages from INBOX
   * Excludes emails sent by the account itself to prevent self-reply loops
   */
  async getUnreadMessages(limit: number = 50, selfEmail?: string): Promise<AppleMailMessage[]> {
    const script = `
tell application "Mail"
    set mbox to mailbox "INBOX" of account "${this.escapeApplescript(this.mailboxAccount)}"
    set unreadMsgs to (messages of mbox whose read status is false)
    set outputText to ""
    set msgCount to count of unreadMsgs
    if msgCount > ${limit} then
        set msgCount to ${limit}
    end if
    repeat with i from 1 to msgCount
        set msg to item i of unreadMsgs
        try
            set msgId to message id of msg
            set msgSubj to subject of msg
            set msgFrom to sender of msg
            set msgDate to (date received of msg) as string
            set msgBody to content of msg
            -- Skip self-sent emails to prevent reply loops
            if msgFrom does not contain "${this.escapeApplescript(selfEmail || "")}" then
                set outputText to outputText & "---MSG---" & linefeed
                set outputText to outputText & "ID: " & msgId & linefeed
                set outputText to outputText & "SUBJECT: " & msgSubj & linefeed
                set outputText to outputText & "FROM: " & msgFrom & linefeed
                set outputText to outputText & "DATE: " & msgDate & linefeed
                set outputText to outputText & "BODY_START" & linefeed
                set outputText to outputText & msgBody & linefeed
                set outputText to outputText & "BODY_END" & linefeed
            end if
        end try
    end repeat
    return outputText
end tell
`;

    const output = await this.runScript(script);
    return this.parseMessages(output);
  }

  /**
   * Parse AppleScript output into message objects
   */
  private parseMessages(output: string): AppleMailMessage[] {
    const messages: AppleMailMessage[] = [];
    const blocks = output.split("---MSG---").filter((b) => b.trim());

    for (const block of blocks) {
      const lines = block.split("\n");
      const msg: Partial<AppleMailMessage> = {
        mailboxAccount: this.mailboxAccount,
        isRead: false,
      };
      let inBody = false;
      const bodyLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("ID: ")) {
          msg.messageId = line.substring(4).trim();
        } else if (line.startsWith("SUBJECT: ")) {
          msg.subject = line.substring(9).trim();
        } else if (line.startsWith("FROM: ")) {
          msg.sender = line.substring(6).trim();
          // Extract email
          const emailMatch = msg.sender.match(/<([^>]+)>/);
          msg.senderEmail = emailMatch ? emailMatch[1].toLowerCase() : msg.sender.toLowerCase();
          const nameMatch = msg.sender.match(/^([^<]+)</);
          if (nameMatch) msg.senderName = nameMatch[1].trim();
        } else if (line.startsWith("DATE: ")) {
          msg.date = line.substring(6).trim();
        } else if (line === "BODY_START") {
          inBody = true;
        } else if (line === "BODY_END") {
          inBody = false;
          msg.body = bodyLines.join("\n").trim();
        } else if (inBody) {
          bodyLines.push(line);
        }
      }

      if (msg.messageId && msg.subject && msg.sender) {
        messages.push(msg as AppleMailMessage);
      }
    }

    return messages;
  }

  /**
   * Get messages in a thread by subject matching
   */
  async getThreadMessages(subject: string, daysBack: number = 30): Promise<AppleMailMessage[]> {
    const cleanSubj = subject.replace(/^(Re:|RE:|re:|Fwd:|FWD:|fwd:|Fw:|FW:|fw:)\s*/g, "").trim();
    const escapedSubject = this.escapeApplescript(cleanSubj);

    const script = `
tell application "Mail"
    set mbox to mailbox "INBOX" of account "${this.escapeApplescript(this.mailboxAccount)}"
    set cleanSubject to "${escapedSubject}"
    set cutoffDate to (current date) - (${daysBack} * days)
    set allMsgs to messages of mbox whose date received > cutoffDate
    set threadMsgs to {}
    repeat with msg in allMsgs
        set msgSubj to subject of msg
        set msgClean to msgSubj
        repeat
            set changed to false
            if msgClean starts with "Re: " then
                set msgClean to text 5 thru -1 of msgClean
                set changed to true
            else if msgClean starts with "Fwd: " then
                set msgClean to text 6 thru -1 of msgClean
                set changed to true
            else if msgClean starts with "Fw: " then
                set msgClean to text 5 thru -1 of msgClean
                set changed to true
            end if
            if not changed then exit repeat
        end repeat
        if msgClean is equal to cleanSubject then
            set end of threadMsgs to msg
        end if
    end repeat
    set outputText to ""
    repeat with msg in threadMsgs
        try
            set msgId to message id of msg
            set msgSubj to subject of msg
            set msgFrom to sender of msg
            set msgDate to (date received of msg) as string
            set msgBody to content of msg
            set outputText to outputText & "---MSG---" & linefeed
            set outputText to outputText & "ID: " & msgId & linefeed
            set outputText to outputText & "SUBJECT: " & msgSubj & linefeed
            set outputText to outputText & "FROM: " & msgFrom & linefeed
            set outputText to outputText & "DATE: " & msgDate & linefeed
            set outputText to outputText & "BODY_START" & linefeed
            set outputText to outputText & msgBody & linefeed
            set outputText to outputText & "BODY_END" & linefeed
        end try
    end repeat
    return outputText
end tell
`;

    const output = await this.runScript(script);
    return this.parseMessages(output);
  }

  /**
   * Mark message as read
   */
  async markAsRead(messageId: string): Promise<void> {
    const script = `
tell application "Mail"
    set mbox to mailbox "INBOX" of account "${this.escapeApplescript(this.mailboxAccount)}"
    set matches to (messages of mbox whose message id is "${this.escapeApplescript(messageId)}")
    if (count of matches) > 0 then
        set read status of item 1 of matches to true
    end if
end tell
`;
    await this.runScript(script);
  }

  /**
   * Reply to the latest message in a thread by subject match
   * Used when we have thread ID but no specific message ID to reply to
   */
  async replyToThread(
    threadId: string,
    cleanSubject: string,
    body: string,
    attachmentPaths: string[] = []
  ): Promise<{ success: boolean; error?: string }> {
    const attachLines = attachmentPaths
      .map(p => `make new attachment with properties {file name:POSIX file "${this.escapeApplescript(p)}"} at after the last paragraph of replyMessage`)
      .join("\n        ");
    const script = `
tell application "Mail"
    set mbox to mailbox "INBOX" of account "${this.escapeApplescript(this.mailboxAccount)}"
    set cleanSubj to "${this.escapeApplescript(cleanSubject)}"
    set cutoffDate to (current date) - (30 * days)
    set allMsgs to messages of mbox whose date received > cutoffDate
    set threadMsgs to {}
    repeat with msg in allMsgs
        set msgSubj to subject of msg
        set msgClean to msgSubj
        repeat
            set changed to false
            if msgClean starts with "Re: " then
                set msgClean to text 5 thru -1 of msgClean
                set changed to true
            else if msgClean starts with "Fwd: " then
                set msgClean to text 6 thru -1 of msgClean
                set changed to true
            else if msgClean starts with "Fw: " then
                set msgClean to text 5 thru -1 of msgClean
                set changed to true
            end if
            if not changed then exit repeat
        end repeat
        if msgClean is equal to cleanSubj then
            set end of threadMsgs to msg
        end if
    end repeat
    if (count of threadMsgs) is 0 then
        -- Also check Sent folder (for replies to our own sent mails)
        try
            set sentBox to mailbox "Sent" of account "${this.escapeApplescript(this.mailboxAccount)}"
            set sentMsgs to messages of sentBox whose date received > cutoffDate
            repeat with msg in sentMsgs
                set msgSubj to subject of msg
                set msgClean to msgSubj
                repeat
                    set changed to false
                    if msgClean starts with "Re: " then
                        set msgClean to text 5 thru -1 of msgClean
                        set changed to true
                    else if msgClean starts with "Fwd: " then
                        set msgClean to text 6 thru -1 of msgClean
                        set changed to true
                    end if
                    if not changed then exit repeat
                end repeat
                if msgClean is equal to cleanSubj then
                    set end of threadMsgs to msg
                end if
            end repeat
        end try
    end if
    if (count of threadMsgs) is 0 then
        error "No messages found in thread with subject: " & cleanSubj
    end if
    -- Sort by date to find the most recent
    set n to count of threadMsgs
    set latestMsg to item 1 of threadMsgs
    set latestDate to date received of latestMsg
    if n > 1 then
        repeat with i from 2 to n
            set curMsg to item i of threadMsgs
            set curDate to date received of curMsg
            if curDate > latestDate then
                set latestMsg to curMsg
                set latestDate to curDate
            end if
        end repeat
    end if
    set replyMessage to reply latestMsg
    tell replyMessage
        set content to "${this.escapeApplescript(body)}"
        ${attachLines}
        send
    end tell
    return "SUCCESS"
end tell
`;

    try {
      await this.runScript(script, attachmentPaths.length > 0 ? 60000 : 30000);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Reply to a message in the same thread
   */
  async replyToMessage(
    messageId: string,
    sender: string,
    subject: string,
    body: string,
    attachmentPaths: string[] = []
  ): Promise<{ success: boolean; error?: string }> {
    const attachLines = attachmentPaths
      .map(p => `make new attachment with properties {file name:POSIX file "${this.escapeApplescript(p)}"} at after the last paragraph of replyMessage`)
      .join("\n        ");

    const script = `
tell application "Mail"
    set mbox to mailbox "INBOX" of account "${this.escapeApplescript(this.mailboxAccount)}"
    set matches to (messages of mbox whose message id is "${this.escapeApplescript(messageId)}")
    if (count of matches) is 0 then
        set matches to (messages of mbox whose subject is "${this.escapeApplescript(subject)}" and sender contains "${this.escapeApplescript(sender)}")
    end if
    if (count of matches) is 0 then
        error "message not found"
    end if
    set theMessage to item 1 of matches
    set replyMessage to reply theMessage
    tell replyMessage
        set content to "${this.escapeApplescript(body)}"
        ${attachLines}
        send
    end tell
    return "SUCCESS"
end tell
`;

    try {
      await this.runScript(script, attachmentPaths.length > 0 ? 60000 : 30000);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Send a new email
   */
  async sendNewEmail(
    to: string,
    subject: string,
    body: string,
    attachmentPaths: string[] = []
  ): Promise<{ success: boolean; error?: string }> {
    const attachLines = attachmentPaths
      .map(p => `make new attachment with properties {file name:POSIX file "${this.escapeApplescript(p)}"} at after the last paragraph of newMessage`)
      .join("\n        ");

    const script = `
tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:"${this.escapeApplescript(subject)}", content:"${this.escapeApplescript(body)}", visible:false}
    tell newMessage
        make new to recipient at end of to recipients with properties {address:"${this.escapeApplescript(to)}"}
        ${attachLines}
        send
    end tell
    return "SUCCESS"
end tell
`;

    try {
      await this.runScript(script, attachmentPaths.length > 0 ? 60000 : 30000);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Archive a message (move to Archive mailbox or remove from INBOX)
   */
  async archiveMessage(messageId: string): Promise<void> {
    const script = `
tell application "Mail"
    set mbox to mailbox "INBOX" of account "${this.escapeApplescript(this.mailboxAccount)}"
    set matches to (messages of mbox whose message id is "${this.escapeApplescript(messageId)}")
    if (count of matches) > 0 then
        try
            set archiveBox to mailbox "Archive" of account "${this.escapeApplescript(this.mailboxAccount)}"
            move item 1 of matches to archiveBox
        end try
    end if
end tell
`;
    await this.runScript(script);
  }

  /**
   * Check if Mail.app is accessible
   */
  async checkConnection(): Promise<boolean> {
    try {
      const script = `
tell application "Mail"
    set accList to name of every account
    return accList as string
end tell
`;
      const result = await this.runScript(script, 10000);
      return result.includes(this.mailboxAccount);
    } catch {
      return false;
    }
  }
}
