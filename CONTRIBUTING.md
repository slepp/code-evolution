# Contributing to Code Evolution Analyzer

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to the project.

## 🚀 Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/yourusername/code-evolution.git`
3. Create a feature branch: `git checkout -b feature/my-new-feature`
4. Make your changes
5. Test thoroughly: `./test.sh`
6. Commit with clear messages: `git commit -m "Add feature: description"`
7. Push to your fork: `git push origin feature/my-new-feature`
8. Open a Pull Request

## 🎯 Areas for Contribution

### High Priority
- [ ] **Branch Selection** - Allow analyzing non-main/master branches
- [ ] **Multi-Branch Support** - Compare multiple branches side-by-side
- [ ] **Diff Mode** - Visualize velocity/churn using cloc's --diff feature
- [ ] **Performance** - Optimize for repositories with 10k+ commits
- [ ] **Export Formats** - Add CSV, Excel, JSON export options

### Medium Priority
- [ ] **File-Level Drill-Down** - Click a language to see individual files
- [ ] **Comparison Mode** - Compare two repositories side-by-side
- [ ] **Custom Themes** - Dark mode, color blind friendly themes
- [ ] **Advanced Filtering** - Filter by date range, author, file pattern
- [ ] **Complexity Metrics** - If cloc adds complexity scoring

### Documentation
- [ ] **Video Tutorial** - Screen recording showing usage
- [ ] **More Examples** - Real-world use cases with screenshots
- [ ] **API Documentation** - Document data.json schema formally
- [ ] **Troubleshooting Guide** - Common issues and solutions

### Testing
- [ ] **Unit Tests** - Test individual functions with Jest/Mocha
- [ ] **Integration Tests** - Test end-to-end workflows
- [ ] **Performance Tests** - Benchmark on various repository sizes
- [ ] **Cross-Platform** - Test on Windows, macOS, Linux

## 🔧 Development Setup

### Prerequisites
```bash
# Install dependencies (none for runtime, only optional OpenTelemetry)
npm install

# Install scc or cloc
sudo snap install scc      # Ubuntu/Debian
brew install scc           # macOS
```

### Running Tests
```bash
# Run test suite
./test.sh

# Test with npx
npx @slepp/code-evolution https://github.com/YOUR_USERNAME/YOUR_REPO ./test-output

# Test incremental mode
npx @slepp/code-evolution https://github.com/YOUR_USERNAME/YOUR_REPO ./test-output  # Second run

# Test locally during development
node analyze.mjs https://github.com/YOUR_USERNAME/YOUR_REPO ./test-output
```

### Publishing to npm

Only maintainers can publish. To release a new version:

```bash
# 1. Update version in package.json
npm version patch  # or minor/major

# 2. Login to npm (one-time)
npm login

# 3. Publish the scoped package
npm publish --access public

# 4. Tag and push
git push --tags
git push
```

### Code Style

- **JavaScript**: ES6 modules, async/await preferred
- **Line Length**: Max 100 characters (soft limit)
- **Comments**: JSDoc for functions, inline for complex logic
- **Naming**: camelCase for variables, PascalCase for classes
- **Formatting**: 2 spaces indentation, no semicolons (optional)

Example:
```javascript
/**
 * Load existing data.json if it exists
 * @param {string} outputDir - Output directory path
 * @returns {Object|null} Parsed data or null if not found
 */
function loadExistingData(outputDir) {
  const dataFile = join(outputDir, 'data.json');
  if (!existsSync(dataFile)) return null;
  // ... implementation
}
```

## 📝 Pull Request Guidelines

### Before Submitting
- [ ] Code follows project style guidelines
- [ ] All tests pass (`./test.sh`)
- [ ] No console.log statements (use proper logging)
- [ ] Documentation updated (README.md)
- [ ] Commit messages are clear and descriptive

### PR Description Template
```markdown
## Description
Brief description of what this PR does.

## Motivation
Why is this change needed? What problem does it solve?

## Changes
- Change 1
- Change 2
- Change 3

## Testing
How was this tested?
- [ ] Unit tests added/updated
- [ ] Manual testing performed
- [ ] Test repository: [link if applicable]

## Screenshots
If UI changes, include before/after screenshots.

## Breaking Changes
List any breaking changes and migration steps.
```

### Commit Message Format
```
<type>: <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Example:**
```
feat: add branch selection support

Allow users to specify which branch to analyze via --branch flag.
Defaults to main/master auto-detection as before.

Closes #42
```

## 🐛 Bug Reports

When reporting bugs, include:

1. **Description** - Clear description of the issue
2. **Steps to Reproduce** - Exact commands/steps to trigger the bug
3. **Expected Behavior** - What you expected to happen
4. **Actual Behavior** - What actually happened
5. **Environment** - OS, Node version, cloc version
6. **Repository** - Link to repo being analyzed (if public)
7. **Logs** - Any error messages or console output

**Template:**
```markdown
### Bug Description
Brief description of the bug.

### Steps to Reproduce
1. Run: `node analyze.mjs https://github.com/user/repo`
2. Observe: [what happens]

### Expected Behavior
The analyzer should...

### Actual Behavior
Instead it...

### Environment
- OS: Ubuntu 22.04
- Node: v18.12.0
- cloc: 2.04

### Error Log
```
[paste error output here]
```
```

## ✨ Feature Requests

When requesting features, include:

1. **Use Case** - Why do you need this feature?
2. **Proposed Solution** - How should it work?
3. **Alternatives** - Other ways to achieve the goal?
4. **Examples** - Similar features in other tools?

## 🔍 Code Review Process

1. **Automated Checks** - CI runs tests and linting
2. **Maintainer Review** - At least one maintainer approval required
3. **Testing** - Reviewer tests the changes locally
4. **Feedback** - Address any requested changes
5. **Merge** - Once approved, maintainer merges

## 📚 Documentation

When updating documentation, keep README.md comprehensive yet concise.

## 🎨 UI/Visualization Changes

For visualization changes:

1. **Before/After Screenshots** - Required for UI changes
2. **Responsive Testing** - Test on mobile, tablet, desktop
3. **Browser Testing** - Test on Chrome, Firefox, Safari
4. **Accessibility** - Consider color blind friendly palettes
5. **Performance** - Ensure no lag with 1000+ commits

## ⚡ Performance Considerations

When optimizing performance:

- Profile with large repositories (1000+ commits)
- Measure before/after (include benchmarks in PR)
- Consider memory usage for huge repos
- Test incremental updates (should be <10s for 10 commits)

## 🆘 Getting Help

- **Questions**: Open a GitHub Discussion
- **Bug Reports**: Open a GitHub Issue
- **Feature Requests**: Open a GitHub Issue
- **Security Issues**: Email maintainers directly (see SECURITY.md)

## 📄 License

By contributing, you agree that your contributions will be licensed under the Apache License, Version 2.0.

## 🙏 Recognition

Contributors will be:
- Listed in README.md
- Mentioned in release notes
- Added to CONTRIBUTORS.md
- Credited in relevant documentation

Thank you for contributing to Code Evolution Analyzer! 🎉
