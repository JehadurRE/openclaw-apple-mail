# Contributing to openclaw-apple-mail

Thank you for your interest in contributing to openclaw-apple-mail! ??

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment.

## How to Contribute

### Reporting Bugs

If you find a bug, please open an issue with:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Your environment (macOS version, Mail.app version, OpenClaw version)
- Relevant logs or error messages

### Suggesting Features

Feature requests are welcome! Please open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered
- Impact on existing functionality

### Pull Requests

1. **Fork the repository**
2. **Create a feature branch** from master:
   \\\ash
   git checkout -b feature/your-feature-name
   \\\

3. **Make your changes**:
   - Follow the existing code style
   - Add tests if applicable
   - Update documentation as needed

4. **Commit your changes** using conventional commits:
   \\\ash
   git commit -m "feat: add new feature"
   git commit -m "fix: resolve bug in thread detection"
   git commit -m "docs: update configuration guide"
   \\\

5. **Push to your fork**:
   \\\ash
   git push origin feature/your-feature-name
   \\\

6. **Open a Pull Request** with:
   - Clear description of changes
   - Reference to related issues
   - Screenshots/demos if applicable

## Development Setup

\\\ash
# Clone your fork
git clone https://github.com/YOUR-USERNAME/openclaw-apple-mail.git
cd openclaw-apple-mail

# Install dependencies
npm install

# Build the project
npm run build

# Link for local testing
openclaw plugins install --link .
\\\

## Commit Message Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- \eat:\ - New feature
- \ix:\ - Bug fix
- \docs:\ - Documentation changes
- \chore:\ - Maintenance tasks
- \
efactor:\ - Code refactoring
- \	est:\ - Adding tests
- \perf:\ - Performance improvements

## Code Style

- Use TypeScript strict mode
- Follow existing formatting conventions
- Add JSDoc comments for public APIs
- Keep functions focused and small

## Testing

Before submitting a PR:
- Test with multiple email accounts
- Verify thread isolation works correctly
- Check that allowlist filtering functions properly
- Test with various email formats (plain text, HTML, tables)

## Questions?

Feel free to open an issue for any questions or discussions!

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

**Author**: Md. Jehadur Rahman (Emran) - [@JehadurRE](https://github.com/JehadurRE)
