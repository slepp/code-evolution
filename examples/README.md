# Examples

This directory contains example scripts demonstrating different use cases for the Code Evolution Analyzer.

## Available Examples

### 1. Multiple Repository Analysis
**File**: `analyze-multiple-repos.sh`

Demonstrates analyzing multiple repositories and organizing outputs:

```bash
cd examples
./analyze-multiple-repos.sh
```

Features:
- Analyzes multiple repos in sequence
- Organizes outputs by repository name
- Provides summary of all generated visualizations

### 2. Daily Update Script
**File**: `daily-update.sh`

Perfect for CI/CD pipelines - demonstrates incremental updates:

```bash
cd examples
./daily-update.sh
```

Features:
- Automatic incremental detection
- Fast updates (only new commits)
- Optional deployment hooks (GitHub Pages, S3)

## Custom Examples

### Analyze Your Own Repository

```bash
# Using npx (recommended)
npx @slepp/code-evolution https://github.com/yourusername/yourrepo ./my-analysis

# Or from cloned repo
cd examples
node ../analyze.mjs https://github.com/yourusername/yourrepo ./my-analysis
```

### Force Full Re-analysis

```bash
npx @slepp/code-evolution https://github.com/yourusername/yourrepo ./my-analysis --force-full
```

### Weekly Metrics Update

```bash
#!/bin/bash
# weekly-update.sh

REPOS=(
  "https://github.com/org/frontend"
  "https://github.com/org/backend"
  "https://github.com/org/mobile"
)

for repo in "${REPOS[@]}"; do
  name=$(basename "$repo")
  echo "Updating $name..."
  npx @slepp/code-evolution "$repo" "./weekly-metrics/$name"
done
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Weekly Metrics
on:
  schedule:
    - cron: '0 0 * * 0'  # Weekly on Sunday
  workflow_dispatch:

jobs:
  update-metrics:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install scc
        run: sudo snap install scc
      
      - name: Update metrics
        run: |
          npx @slepp/code-evolution https://github.com/${{ github.repository }} ./metrics
      
      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./metrics
```

### GitLab CI Example

```yaml
metrics:
  stage: deploy
  script:
    - apt-get update && apt-get install -y cloc
    - npx @slepp/code-evolution https://gitlab.com/$CI_PROJECT_PATH ./metrics
    - cp -r ./metrics public/
  artifacts:
    paths:
      - public
  only:
    - schedules
```

## Tips

1. **First Run**: Allow extra time for full analysis (15min+ for large repos)
2. **Incremental Updates**: Subsequent runs complete in seconds
3. **Scheduling**: Daily/weekly updates work great with incremental mode
4. **Storage**: Keep data.json in version control to track historical changes
5. **Sharing**: The visualization.html is self-contained - just send the file!

## Output Structure

```
example-output/
├── repo-name-1/
│   ├── data.json
│   └── visualization.html
├── repo-name-2/
│   ├── data.json
│   └── visualization.html
└── repo-name-3/
    ├── data.json
    └── visualization.html
```

## Troubleshooting

**Issue**: Script fails with "cloc: command not found"
**Solution**: Install cloc first: `sudo apt install cloc` (Ubuntu) or `brew install cloc` (macOS)

**Issue**: "Permission denied" error
**Solution**: Make scripts executable: `chmod +x examples/*.sh`

**Issue**: Slow analysis
**Solution**: Use incremental mode (automatic on second run) or analyze smaller repos
