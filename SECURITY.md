# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in openclaw-apple-mail, please report it responsibly:

### Please DO NOT:
- Open a public GitHub issue
- Disclose the vulnerability publicly before it's fixed

### Please DO:
1. **Email the maintainer** with details:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

2. **Allow reasonable time** for a fix to be developed and released

3. **Coordinate disclosure** - We'll work with you on responsible disclosure timing

## Security Best Practices

When using openclaw-apple-mail:

### Email Allowlist
- Always configure \llowFrom\ to restrict who can interact with your agent
- Never use \["*"]\ in production unless you understand the risks
- Regularly review and update your allowlist

### Account Security
- Use dedicated email accounts for agent communication
- Enable 2FA on email accounts
- Monitor email logs for suspicious activity

### Configuration
- Store \openclaw.json\ with appropriate file permissions (600)
- Never commit sensitive configuration to public repositories
- Use environment variables for sensitive data when possible

### Thread Isolation
- Verify thread IDs are working correctly
- Monitor for cross-thread contamination
- Review session logs regularly

### AppleScript Execution
- This plugin executes AppleScript with elevated permissions
- Only install from trusted sources
- Review code changes before updating

## Known Security Considerations

### Email Processing
- HTML emails are sanitized before processing
- External content may be blocked by Mail.app
- Attachments are not automatically processed

### Session Management
- Sessions are isolated per thread
- Session keys include email and thread ID
- Session data persists in OpenClaw's database

### Network
- All communication goes through Mail.app
- No direct network connections from plugin
- Respects Mail.app's security settings

## Updates

Security updates will be released as patch versions (1.0.x) and documented in CHANGELOG.md

Stay informed by watching the repository for releases.

---

**Maintained by**: Jehadur Rahman (Emran) - [@JehadurRE](https://github.com/JehadurRE)
