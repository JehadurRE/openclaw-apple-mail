# Publishing to ClawHub

This guide explains how to publish `openclaw-apple-mail` to ClawHub.

## Prerequisites

1. **Install ClawHub CLI**:
   ```bash
   npm install -g clawhub-cli
   # or
   yarn global add clawhub-cli
   ```

2. **Authenticate**:
   ```bash
   clawhub login
   ```

3. **Verify your ClawHub account matches the package scope**:
   - Package name: `@jehadurre/openclaw-apple-mail`
   - ClawHub username must be: `jehadurre`
   - If not, you need to rename the package or publish under a different scope

## Pre-Publishing Checklist

✅ `openclaw.plugin.json` exists with proper metadata
✅ `package.json` includes:
   - `openclaw.compat.pluginApi`
   - `openclaw.build.openclawVersion`
✅ Source repository URL is set
✅ Icon URL is configured (https://raw.githubusercontent.com/JehadurRE/openclaw-apple-mail/master/docs/icon.png)

## Validation

Before publishing, validate the plugin:

```bash
cd C:\Users\CCAI_DEV2\Downloads\openclaw-apple-mail
clawhub package validate .
```

Fix any issues reported by the validation.

## Dry Run

Test the publish without actually publishing:

```bash
clawhub package publish . --dry-run
```

This will show you what would be published without actually doing it.

## Publish to ClawHub

When ready, publish for real:

```bash
clawhub package publish .
```

The command will:
1. Package your plugin
2. Upload to ClawHub
3. Run automated security checks
4. Make it available once checks pass

## After Publishing

### Set Up Trusted Publishing (Optional but Recommended)

After first manual publish, configure GitHub Actions trusted publishing:

```bash
clawhub package trusted-publisher set @jehadurre/openclaw-apple-mail \
  --repository JehadurRE/openclaw-apple-mail \
  --workflow-filename clawhub-publish.yml
```

This allows future publishes from GitHub Actions without storing tokens.

### Verify Publication

Check that your plugin is live:

```bash
clawhub package get @jehadurre/openclaw-apple-mail
```

Or visit: https://clawhub.io/packages/@jehadurre/openclaw-apple-mail

## Installation by Users

Users can install your plugin with:

```bash
# Via ClawHub
openclaw plugins install @jehadurre/openclaw-apple-mail

# Via npm (fallback)
npm install @jehadurre/openclaw-apple-mail
openclaw plugins install @jehadurre/openclaw-apple-mail
```

## Troubleshooting

### Package scope must match selected owner

**Error**: `Package scope "@jehadurre" must match selected owner "..."`

**Solution**: Either:
1. Publish as `@jehadurre` (requires ClawHub account: jehadurre)
2. Or rename package to match your ClawHub username

### Missing openclaw.plugin.json

**Error**: `openclaw.plugin.json not found`

**Solution**: Already included! This error shouldn't happen.

### Validation failures

Run `clawhub package validate .` and follow the specific error messages.

## Version Updates

To publish a new version:

1. Update version in `package.json`:
   ```json
   {
     "version": "1.0.2"
   }
   ```

2. Update `CHANGELOG.md`

3. Commit changes:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: bump version to 1.0.2"
   git push
   ```

4. Create Git tag:
   ```bash
   git tag v1.0.2
   git push origin v1.0.2
   ```

5. Publish to ClawHub:
   ```bash
   clawhub package publish .
   ```

6. Publish to npm:
   ```bash
   npm publish --access public
   ```

## Support

- **ClawHub Docs**: https://clawhub.io/docs
- **Package Issues**: https://github.com/JehadurRE/openclaw-apple-mail/issues
- **Author**: Md. Jehadur Rahman (Emran) - https://jehadurre.me

---

**Author**: Md. Jehadur Rahman (Emran)
**Package**: @jehadurre/openclaw-apple-mail
**Repository**: https://github.com/JehadurRE/openclaw-apple-mail
