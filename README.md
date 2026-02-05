# Code Evolution Analyzer

> 📊 Visualize code evolution over time with interactive animated graphs

Analyzes the evolution of code composition across your git repository's history by running **[scc](https://github.com/boyter/scc)** (default, ~80x faster) or **[cloc](https://github.com/AlDanial/cloc)** on every commit. Generates beautiful, interactive HTML visualizations showing how your codebase has grown and changed.

## ✨ Features

### Core Features
- 📊 **Full History Analysis** - Processes every commit chronologically
- ⚡ **Incremental Updates** - Only analyzes new commits (100x faster re-runs!)
- 🎨 **Interactive Visualization** - Beautiful animated HTML with custom Canvas renderer
- 📈 **Live Graph** - Real-time line graph showing language evolution
- 🎯 **Smart Sorting** - Languages maintain consistent positions for easy tracking
- 📦 **Self-Contained** - Single HTML file, no server required
- 🚀 **Fast** - Smart caching and incremental processing
- 🔧 **Flexible** - Choose between scc (fast) or cloc (thorough)

### What's New in v0.10
- **⚡ scc Support** - Default to scc for ~80x faster analysis
- **🎵 Audio Sonification** - Hear your code evolution (experimental)
- **📊 Enhanced Metrics** - Complexity and bytes data (with scc)
- **🔧 Tool Selection** - Choose scc or cloc via `--counter` flag
- **⏱️ Performance Tracking** - Detailed timing and throughput metrics

## 🚀 Quick Start

### Prerequisites

- **Node.js** v16 or higher
- **scc** (recommended, default) or **cloc**:
  - **scc** (~80x faster):
    - Ubuntu/Debian: `sudo snap install scc` or download from [releases](https://github.com/boyter/scc/releases)
    - macOS: `brew install scc`
    - Windows: `scoop install scc` or download from [releases](https://github.com/boyter/scc/releases)
  - **cloc** (traditional, more thorough):
    - Ubuntu/Debian: `sudo apt install cloc`
    - macOS: `brew install cloc`
    - Windows: `choco install cloc`
- **git** - For repository cloning

### Installation

**Option 1: Use npx (Recommended - No Installation)**

```bash
# Run directly with npx
npx @slepp/code-evolution https://github.com/facebook/react
```

**Option 2: Install Globally**

```bash
npm install -g @slepp/code-evolution
code-evolution https://github.com/facebook/react
```

**Option 3: Clone from GitHub**

```bash
git clone https://github.com/slepp/code-evolution.git
cd code-evolution
node analyze.mjs https://github.com/facebook/react
```

### Basic Usage

```bash
# Analyze a repository (uses scc by default)
npx @slepp/code-evolution https://github.com/facebook/react

# Use cloc instead of scc
npx @slepp/code-evolution https://github.com/facebook/react ./output --counter cloc

# Specify output directory
npx @slepp/code-evolution https://github.com/torvalds/linux ./linux-analysis

# Update existing analysis (incremental - super fast!)
npx @slepp/code-evolution https://github.com/facebook/react ./react-analysis
```

### Output

Two files are generated in the output directory:

1. **`data.json`** - Complete analysis data (schema v2.2 with metadata)
2. **`visualization.html`** - Interactive visualization (open in any browser)

## 📊 Example Visualization

The generated HTML includes:

- **📈 Live Graph** (right panel) - High-performance Canvas line graph showing language trends
- **📊 Statistics Table** (left panel) - Detailed per-language metrics
- **⏯️ Playback Controls** - Play/pause, step through commits, adjust speed
- **🎨 Color Coding** - Consistent colors across table and graph
- **📉 Delta Tracking** - Shows +/- changes from previous commit
- **⌨️ Keyboard Shortcuts** - Space, arrows, Home for quick navigation

## ⚡ Incremental Updates

**Blazing fast incremental updates:**

```bash
# First run: analyzes all 1000 commits (~15 minutes)
npx @slepp/code-evolution https://github.com/large-project/repo ./output

# Later: only analyzes 10 new commits (~10 seconds!)
npx @slepp/code-evolution https://github.com/large-project/repo ./output
# ✓ Found existing data (1000 commits)
# 🔄 Incremental mode: found 10 new commits
# ⚡ Analysis complete (9.2s)
```

**Performance:**
- 100x+ faster for small updates
- Perfect for CI/CD pipelines
- Daily dashboard updates in seconds

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
      - run: npx @slepp/code-evolution https://github.com/$REPO ./metrics
      # Deploy to GitHub Pages, S3, etc.
```

### 3. Multi-Repository Monitoring
Track code evolution across multiple projects:

```bash
for repo in frontend backend mobile; do
  npx @slepp/code-evolution "https://github.com/org/$repo" "./metrics/$repo"
done
```

### 4. Language Migration Tracking
Document transitions like "migrated from JavaScript to TypeScript" with visual proof.

## 🛠️ Advanced Usage

### Tool Selection

Choose between scc (fast) or cloc (thorough):

```bash
# Use scc (default, ~80x faster)
npx @slepp/code-evolution <repo-url> <output-dir>

# Use cloc (traditional, more language mappings)
npx @slepp/code-evolution <repo-url> <output-dir> --counter cloc
```

**Tool Comparison:**
- **scc**: Succinct Code Counter (Go), very fast, includes complexity & bytes
- **cloc**: Count Lines of Code (Perl), traditional, broader language support

Both provide: files, code lines, blank lines, comment lines

### Force Full Re-analysis

```bash
# Ignore existing data and regenerate from scratch
npx @slepp/code-evolution <repo-url> <output-dir> --force-full
```

Useful when:
- Upgrading counter tool versions
- Changing exclusion patterns
- Switching between scc and cloc

### Custom Exclusions

Edit `analyze.mjs` line 238 to modify excluded directories:

```javascript
const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', 'target', 'pkg', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'vendor'];
```

### Keyboard Shortcuts in Visualization

- **Space** - Play/Pause
- **→** - Next commit
- **←** - Previous commit
- **Home** - Reset to first commit

## 📊 Data Format

The analyzer uses schema v2.2 with enhanced metadata:

> **Note**: Tool version (v0.10.0) is separate from data schema version (v2.2). Schema version indicates the format of data.json output.

```json
{
  "schema_version": "2.2",
  "metadata": {
    "repository_url": "https://github.com/user/repo",
    "analyzed_at": "2024-01-30T12:34:56Z",
    "total_commits": 1245,
    "total_duration_seconds": 876.45,
    "counter_tool": "scc",
    "counter_version": "3.x",
    "last_commit_hash": "abc123...",
    "last_commit_date": "2024-01-30"
  },
  "results": [ /* per-commit data */ ],
  "allLanguages": [ /* sorted by prevalence */ ]
}
```

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

Apache 2.0 License - see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- **[scc](https://github.com/boyter/scc)** by Ben Boyter - Blazing fast code counter
- **[cloc](https://github.com/AlDanial/cloc)** by Al Danial - The classic code counting tool

## 🔗 Links

- **Issues**: [GitHub Issues](https://github.com/slepp/code-evolution/issues)
- **Releases**: [GitHub Releases](https://github.com/slepp/code-evolution/releases)

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
  <a href="https://github.com/slepp/code-evolution/stargazers">⭐ Star this repo</a>
  ·
  <a href="https://github.com/slepp/code-evolution/issues">🐛 Report Bug</a>
  ·
  <a href="https://github.com/slepp/code-evolution/issues">✨ Request Feature</a>
</div>
