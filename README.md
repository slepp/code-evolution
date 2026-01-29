# CLOC History Analyzer

> 📊 Visualize code evolution over time with interactive animated graphs

Analyzes the evolution of code composition across your git repository's history by running [cloc](https://github.com/AlDanial/cloc) on every commit. Generates beautiful, interactive HTML visualizations showing how your codebase has grown and changed.

<div align="center">
  <img src="docs/screenshot.png" alt="CLOC History Analyzer Visualization" width="800">
  <p><em>Interactive visualization showing language distribution over time with live graph updates</em></p>
</div>

## ✨ Features

### Core Features
- 📊 **Full History Analysis** - Processes every commit chronologically
- ⚡ **Incremental Updates** - Only analyzes new commits (100x faster re-runs!)
- 🎨 **Interactive Visualization** - Beautiful animated HTML with Chart.js graphs
- 📈 **Live Graph** - Real-time line graph showing language evolution
- 🎯 **Smart Sorting** - Languages maintain consistent positions for easy tracking
- 📦 **Self-Contained** - Single HTML file, no server required
- 🚀 **Fast** - Smart caching and incremental processing

### What's New in v2.0
- **⚡ Incremental Processing** - Re-analyze in seconds instead of minutes
- **📊 Enhanced Data** - Comprehensive cloc metrics per commit
- **🔧 Schema Versioning** - Future-proof data format
- **⏱️ Performance Tracking** - Detailed timing and throughput metrics

## 🚀 Quick Start

### Prerequisites

- **Node.js** v16 or higher
- **cloc** - Install with:
  - Ubuntu/Debian: `sudo apt install cloc`
  - macOS: `brew install cloc`
  - Windows: `choco install cloc`
- **git** - For repository cloning

### Installation

```bash
# Clone the repository
git clone https://github.com/slepp/cloc-history-analyzer.git
cd cloc-history-analyzer

# Make analyzer executable (optional)
chmod +x analyze.mjs
```

### Basic Usage

```bash
# Analyze a repository
node analyze.mjs https://github.com/facebook/react

# Specify output directory
node analyze.mjs https://github.com/torvalds/linux ./linux-analysis

# Update existing analysis (incremental - super fast!)
node analyze.mjs https://github.com/facebook/react ./react-analysis
```

### Output

Two files are generated in the output directory:

1. **`data.json`** - Complete analysis data (v2.0 format with metadata)
2. **`visualization.html`** - Interactive visualization (open in any browser)

## 📊 Example Visualization

The generated HTML includes:

- **📈 Live Graph** (right panel) - Chart.js line graph showing language trends
- **📊 Statistics Table** (left panel) - Detailed per-language metrics
- **⏯️ Playback Controls** - Play/pause, step through commits, adjust speed
- **🎨 Color Coding** - Consistent colors across table and graph
- **📉 Delta Tracking** - Shows +/- changes from previous commit
- **⌨️ Keyboard Shortcuts** - Space, arrows, Home for quick navigation

## ⚡ Incremental Updates

Version 2.0 introduces **blazing fast incremental updates**:

```bash
# First run: analyzes all 1000 commits (~15 minutes)
node analyze.mjs https://github.com/large-project/repo ./output

# Later: only analyzes 10 new commits (~10 seconds!)
node analyze.mjs https://github.com/large-project/repo ./output
# ✓ Found existing data (1000 commits)
# 🔄 Incremental mode: found 10 new commits
# ⚡ Analysis complete (9.2s)
```

**Performance:**
- 100x+ faster for small updates
- Perfect for CI/CD pipelines
- Daily dashboard updates in seconds

## 📖 Documentation

- **[Quick Start Guide](docs/QUICKSTART.md)** - Get started in 2 minutes
- **[User Guide](docs/README.md)** - Complete feature documentation
- **[Incremental Updates](docs/INCREMENTAL.md)** - Deep dive on v2.0 incremental mode
- **[Examples](docs/EXAMPLE.md)** - Real-world usage examples
- **[Changelog](docs/CHANGELOG.md)** - Version history and technical details
- **[UI Updates](docs/UI-UPDATES.md)** - Visualization features

## 🎯 Use Cases

### 1. Project Retrospectives
Visualize how your project evolved over time - see when languages were added, refactored, or removed.

### 2. CI/CD Dashboards
Generate up-to-date code metrics automatically:

```yaml
# .github/workflows/metrics.yml
name: Update Code Metrics
on:
  schedule:
    - cron: '0 0 * * *'  # Daily
jobs:
  metrics:
    runs-on: ubuntu-latest
    steps:
      - run: node analyze.mjs https://github.com/$REPO ./metrics
      # Deploy to GitHub Pages, S3, etc.
```

### 3. Multi-Repository Monitoring
Track code evolution across multiple projects:

```bash
for repo in frontend backend mobile; do
  node analyze.mjs "https://github.com/org/$repo" "./metrics/$repo"
done
```

### 4. Language Migration Tracking
Document transitions like "migrated from JavaScript to TypeScript" with visual proof.

## 🛠️ Advanced Usage

### Force Full Re-analysis

```bash
# Ignore existing data and regenerate from scratch
node analyze.mjs <repo-url> <output-dir> --force-full
```

Useful when:
- Upgrading cloc versions
- Changing exclusion patterns
- Migrating from v1.0 to v2.0

### Custom Exclusions

Edit `analyze.mjs` line 76 to modify excluded directories:

```javascript
--exclude-dir=node_modules,.git,dist,build,target,pkg,vendor
```

### Keyboard Shortcuts in Visualization

- **Space** - Play/Pause
- **→** - Next commit
- **←** - Previous commit
- **Home** - Reset to first commit

## 📊 Data Format

Version 2.0 uses an enhanced schema with metadata:

```json
{
  "schema_version": "2.0",
  "metadata": {
    "repository_url": "https://github.com/user/repo",
    "analyzed_at": "2024-01-30T12:34:56Z",
    "total_commits": 1245,
    "total_duration_seconds": 876.45,
    "cloc_version": "2.04",
    "last_commit_hash": "abc123...",
    "last_commit_date": "2024-01-30"
  },
  "results": [ /* per-commit data */ ],
  "allLanguages": [ /* sorted by prevalence */ ]
}
```

See [INCREMENTAL.md](docs/INCREMENTAL.md) for complete schema documentation.

## 🧪 Testing

Run the included test suite:

```bash
./test.sh
```

Tests include:
- ✓ Prerequisite checking
- ✓ Full analysis on test repository
- ✓ JSON structure validation
- ✓ Output file generation
- ✓ Cleanup verification

## 🤝 Contributing

Contributions welcome! Areas for improvement:

- [ ] Branch selection support
- [ ] Diff mode visualization (velocity/churn)
- [ ] Multiple output formats (CSV, Excel)
- [ ] Language complexity metrics
- [ ] File-level drill-down
- [ ] Comparison mode (repo A vs repo B)

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- **[cloc](https://github.com/AlDanial/cloc)** by Al Danial - The amazing tool that powers this analyzer
- **[Chart.js](https://www.chartjs.org/)** - Beautiful, responsive charts
- **[kelseyhightower/nocode](https://github.com/kelseyhightower/nocode)** - Test repository

## 🔗 Links

- **Documentation**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/slepp/cloc-history-analyzer/issues)
- **Releases**: [GitHub Releases](https://github.com/slepp/cloc-history-analyzer/releases)

## 📈 Performance Benchmarks

| Repository Size | First Run | Update (10 commits) | Update (0 commits) |
|----------------|-----------|--------------------|--------------------|
| Small (100 commits) | 30s | 3s | 2s |
| Medium (500 commits) | 2m | 5s | 2s |
| Large (1000+ commits) | 15m | 10s | 2s |

*Tested on: Ubuntu 22.04, AMD Ryzen 9, NVMe SSD*

## 💡 Tips

1. **Daily Updates**: Use incremental mode for fast daily metrics
2. **Version Control**: Commit `data.json` to track historical changes
3. **Large Repos**: Consider weekly analysis for 10k+ commit repos
4. **CI/CD**: Incremental updates complete in seconds - perfect for automation
5. **Sharing**: The HTML visualization is self-contained - just send the file!

---

<div align="center">
  <strong>Built with ❤️ by Stephen Olesen</strong>
  <br><br>
  <a href="https://github.com/slepp/cloc-history-analyzer/stargazers">⭐ Star this repo</a>
  ·
  <a href="https://github.com/slepp/cloc-history-analyzer/issues">🐛 Report Bug</a>
  ·
  <a href="https://github.com/slepp/cloc-history-analyzer/issues">✨ Request Feature</a>
</div>
