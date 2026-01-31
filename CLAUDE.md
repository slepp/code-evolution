# CLAUDE.md

## Project Overview

Single-file code evolution analyzer - generates interactive HTML visualizations showing code composition over time using git history and scc/cloc.

## Key Files

- `analyze.mjs` - Main script containing CLI, analysis logic, AND the entire HTML visualization (embedded as template literal ~3500 lines)

## Development Commands

```bash
# Basic analysis
node analyze.mjs <repo-url> <output-dir>

# Use local repo (faster, avoids clone)
node analyze.mjs <repo-url> <output-dir> --local-repo <path>

# Force full re-analysis (ignore cached data.json)
rm <output-dir>/data.json && node analyze.mjs ...

# Run tests
npm test
```

## Development Gotchas

- **Local repo analysis**: Uncommitted changes cause failures (analyzer checks out each commit). Commit or stash changes first.
- **Testing visualization changes**: Remove `data.json` to force HTML regeneration, or the cached version will be used.
- **Embedded HTML**: The visualization HTML/CSS/JS is a template literal in `analyze.mjs` starting around line 800. Changes require regeneration.

## Visualization Architecture

- Custom Canvas 2D renderer (replaced Chart.js for 30fps performance)
- Web Audio API for sonification with beat-synced drum patterns
- Data decimation for large datasets (MAX_RENDER_POINTS = 800)
- DOM element caching for efficient table updates
