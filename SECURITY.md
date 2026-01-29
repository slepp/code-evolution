# Security Policy

## Supported Versions

Currently supported versions:

| Version | Supported          |
| ------- | ------------------ |
| 2.0.x   | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in CLOC History Analyzer, please report it by emailing:

**slepp@slepp.ca**

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

### What to Expect

- **Response Time**: Within 48 hours
- **Updates**: Regular updates on the status of your report
- **Credit**: Security researchers will be credited (unless anonymity is preferred)

### Security Considerations

This tool:
- Clones git repositories to temporary directories
- Executes shell commands (git, cloc)
- Writes output to local filesystem
- Does NOT make network requests beyond git clone
- Does NOT execute code from analyzed repositories

**Important**: Only analyze repositories you trust. The tool checks out every commit in history, so malicious git hooks or post-checkout scripts could potentially execute.

## Best Practices

1. **Trust**: Only analyze repositories from trusted sources
2. **Isolation**: Consider running in a container/VM for untrusted repos
3. **Cleanup**: Temporary directories are cleaned up automatically
4. **Permissions**: Run with minimal required permissions
5. **Review**: Review output before sharing (may contain commit messages)

## Known Limitations

- Relies on system `git` and `cloc` commands
- Temporary files created in system temp directory
- No sandboxing of git repository operations
- Shell command injection possible via malformed repo URLs (input sanitization recommended)

## Future Enhancements

- Container-based execution option
- Repository URL validation and sanitization
- Configurable temp directory with cleanup verification
- Optional sandboxing for untrusted repositories
