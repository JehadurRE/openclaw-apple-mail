# openclaw-apple-mail

Apple Mail channel plugin for [OpenClaw](https://github.com/openclaw/openclaw). Uses AppleScript to integrate with Mail.app on macOS, providing **isolated sessions per email thread**.

## Key Feature: Per-Thread Session Isolation

Each email thread gets its own OpenClaw session via the session key:
```
agent:main:apple-mail:{email}:{threadId}
```

This means:
- ✅ Each email thread has isolated conversation history
- ✅ No mixing of conversations between different emails
- ✅ Follow-ups automatically go to the correct thread
- ✅ Works with OpenClaw's built-in session management

## Installation

```bash
openclaw plugins install --link /path/to/openclaw-apple-mail
```

Requires `openclaw >= 2026.1.0` and macOS with Mail.app configured.

## Configuration

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "apple-mail": {
      "enabled": true,
      "accounts": {
        "nextgensolutionsai@icloud.com": {
          "email": "nextgensolutionsai@icloud.com",
          "mailboxAccount": "iCloud",
          "allowFrom": [
            "zack@starrecycling.com",
            "david@starrecycling.com",
            "zack@nextgen-solutions.ai",
            "devccai2@gmail.com",
            "shahed.amin456@gmail.com"
          ],
          "pollIntervalMs": 30000,
          "archiveOnReply": false
        }
      }
    }
  }
}
```

## Configuration Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `email` | string | — | Email address (required) |
| `mailboxAccount` | string | `"iCloud"` | Apple Mail account name |
| `allowFrom` | string[] | `[]` | Sender allowlist. `["*"]` allows all |
| `pollIntervalMs` | number | `30000` | Polling interval in ms |
| `archiveOnReply` | boolean | `false` | Archive thread after reply |
| `includeQuotedReplies` | boolean | `true` | Include thread history in replies |
| `includeThreadContext` | boolean | `false` | Include thread context from non-allowed senders |

## How It Works

1. **Polling**: Monitors Mail.app INBOX for unread messages every 30 seconds (configurable)
2. **Filtering**: Only processes messages from senders in `allowFrom` list
3. **Thread Detection**: Generates stable thread ID from `md5(clean_subject:sender_email)`
4. **Session Isolation**: Each thread uses unique session key: `agent:main:apple-mail:{email}:{threadId}`
5. **Reply**: Uses AppleScript to reply in the same thread, maintaining conversation context

## Architecture

```
Mail.app INBOX
    ↓ (AppleScript polling)
AppleMailClient
    ↓ (parse inbound)
OpenClaw Gateway
    ↓ (SessionKey: agent:main:apple-mail:email:threadId)
Agent (isolated session per thread)
    ↓ (reply)
AppleMailClient.replyToMessage
    ↓ (AppleScript)
Mail.app → Sent
```

## Security

- **Allowlist enforcement**: Only senders in `allowFrom` are processed
- **Self-reply prevention**: Skips messages from the account itself to prevent loops
- **Outbound restrictions**: `allowOutboundTo` controls who replies can be sent to
- **Thread reply policies**: `open`, `allowlist`, or `sender-only`

## Development

```bash
# Build
npm run build

# Link for local testing
openclaw plugins install --link .
```
