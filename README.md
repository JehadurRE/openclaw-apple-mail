# 📧 openclaw-apple-mail

[![npm version](https://img.shields.io/npm/v/@jehadurre/openclaw-apple-mail.svg)](https://www.npmjs.com/package/@jehadurre/openclaw-apple-mail)
[![npm downloads](https://img.shields.io/npm/dm/@jehadurre/openclaw-apple-mail.svg)](https://www.npmjs.com/package/@jehadurre/openclaw-apple-mail)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E%3D2026.1.0-blue)](https://github.com/openclaw/openclaw)
[![macOS](https://img.shields.io/badge/macOS-Mail.app-black)](https://www.apple.com/macos/)

Apple Mail channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) and [Hermes](https://github.com/hermesai/hermes). Uses AppleScript to integrate with Mail.app on macOS, providing **isolated sessions per email thread**.

## ✨ Key Features

### 🔒 Per-Thread Session Isolation
Each email thread gets its own OpenClaw/Hermes session via the session key:
```
agent:main:apple-mail:{email}:{threadId}
```

This ensures:
- ✅ Each email thread has isolated conversation history
- ✅ No mixing of conversations between different emails
- ✅ Follow-ups automatically go to the correct thread
- ✅ Works with OpenClaw's built-in session management

### 🛡️ Security Features
- **Allowlist enforcement**: Only process emails from approved senders
- **Self-reply prevention**: Avoids infinite loops
- **Outbound restrictions**: Control who can receive replies
- **Thread reply policies**: Flexible access control

### 📊 HTML Table Support
- Extract and process HTML tables from emails
- Preserve table structure and formatting
- Sanitize HTML content for security

## 🚀 Quick Start

### Prerequisites
- macOS with Mail.app configured
- OpenClaw >= 2026.1.0 or Hermes >= 2026.1.0
- Node.js >= 18.0.0

### Installation

#### Via npm (Recommended):
```bash
# Install from npm
npm install @jehadurre/openclaw-apple-mail

# For OpenClaw
openclaw plugins install @jehadurre/openclaw-apple-mail

# For Hermes
hermes plugins install @jehadurre/openclaw-apple-mail
```

#### Via Local Path:
```bash
# Clone the repository
git clone https://github.com/JehadurRE/openclaw-apple-mail.git

# For OpenClaw
openclaw plugins install --link /path/to/openclaw-apple-mail

# For Hermes
hermes plugins install --link /path/to/openclaw-apple-mail
```
```

## ⚙️ Configuration

### For OpenClaw
Add to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "apple-mail": {
      "enabled": true,
      "accounts": {
        "your-email@example.com": {
          "email": "your-email@example.com",
          "mailboxAccount": "iCloud",
          "allowFrom": [
            "allowed-sender@example.com",
            "another-sender@example.com"
          ],
          "pollIntervalMs": 30000,
          "archiveOnReply": false
        }
      }
    }
  }
}
```

### For Hermes
Add to your `~/.hermes/hermes.json`:

```json
{
  "channels": {
    "apple-mail": {
      "enabled": true,
      "accounts": {
        "your-email@example.com": {
          "email": "your-email@example.com",
          "mailboxAccount": "iCloud",
          "allowFrom": [
            "allowed-sender@example.com"
          ],
          "pollIntervalMs": 30000
        }
      }
    }
  }
}
```

## 📖 Configuration Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `email` | string | — | Email address (required) |
| `mailboxAccount` | string | `"iCloud"` | Apple Mail account name |
| `allowFrom` | string[] | `[]` | Sender allowlist. `["*"]` allows all |
| `pollIntervalMs` | number | `30000` | Polling interval in ms |
| `archiveOnReply` | boolean | `false` | Archive thread after reply |
| `includeQuotedReplies` | boolean | `true` | Include thread history in replies |
| `includeThreadContext` | boolean | `false` | Include context from non-allowed senders |

## 🏗️ How It Works

```
Mail.app INBOX
    ↓ (AppleScript polling)
AppleMailClient
    ↓ (parse inbound)
OpenClaw/Hermes Gateway
    ↓ (SessionKey: agent:main:apple-mail:email:threadId)
Agent (isolated session per thread)
    ↓ (reply)
AppleMailClient.replyToMessage
    ↓ (AppleScript)
Mail.app → Sent
```

### Thread Detection
Generates stable thread IDs using:
```typescript
threadId = md5(cleanSubject + ":" + senderEmail)
```

This ensures:
- Same subject + sender = same thread
- "Re:", "Fwd:" prefixes are normalized
- Consistent thread tracking across conversations

## 🔐 Security Best Practices

1. **Use Allowlists**: Always configure `allowFrom` in production
2. **Dedicated Accounts**: Use separate email accounts for agent communication
3. **Monitor Logs**: Regularly review session logs for suspicious activity
4. **Update Regularly**: Keep the plugin updated for security patches
5. **File Permissions**: Protect your configuration files (`chmod 600`)

## 🛠️ Development

```bash
# Clone the repository
git clone https://github.com/JehadurRE/openclaw-apple-mail.git
cd openclaw-apple-mail

# Install dependencies
npm install

# Build
npm run build

# Link for local testing with OpenClaw
openclaw plugins install --link .

# Or with Hermes
hermes plugins install --link .
```

## 📝 Architecture

- **`src/channel.ts`** - Main channel implementation
- **`src/applescript-client.ts`** - AppleScript interface
- **`src/inbound.ts`** - Inbound message processing
- **`src/outbound.ts`** - Outbound reply handling
- **`src/monitor.ts`** - Email polling and monitoring
- **`src/threading.ts`** - Thread ID generation
- **`src/html-processor.ts`** - HTML table extraction
- **`src/session-watcher.ts`** - Session state management

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

Copyright (c) 2026 Md. Jehadur Rahman (Emran)

## 👤 Author

**Md. Jehadur Rahman (Emran)**
- GitHub: [@JehadurRE](https://github.com/JehadurRE)
- Website: [jehadurre.me](https://jehadurre.me)
- Dev.to: [@jehadurre](https://dev.to/jehadurre)

## 🙏 Acknowledgments

- OpenClaw team for the extensible plugin architecture
- Hermes team for AI agent framework
- Apple Mail.app for AppleScript support

## 📚 Related Projects

- [OpenClaw](https://github.com/openclaw/openclaw) - AI Agent Framework
- [Hermes](https://github.com/hermesai/hermes) - AI Agent Platform

## 📮 Support

- 🐛 [Report Bugs](https://github.com/JehadurRE/openclaw-apple-mail/issues)
- 💡 [Request Features](https://github.com/JehadurRE/openclaw-apple-mail/issues)
- 📖 [Documentation](https://github.com/JehadurRE/openclaw-apple-mail/wiki)

---

**Made with ❤️ by Md. Jehadur Rahman (Emran)**