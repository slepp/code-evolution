#!/usr/bin/env node

/**
 * Code Evolution Analyzer v2.0
 *
 * Clones a git repository and analyzes code composition over time by running
 * a code counter (scc or cloc) on every commit. Generates an animated HTML
 * visualization showing language distribution evolution, with optional audio.
 *
 * Features:
 * - Incremental updates (only analyzes new commits)
 * - JSON progress output for automation
 * - Local repo support (via safe worktree)
 * - Performance tracking
 * - OpenTelemetry distributed tracing support
 *
 * Usage: node analyze.mjs <git-repo-url> [output-dir] [--force-full]
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SCHEMA_VERSION, DEFAULT_COUNTER_TOOL } from './lib/constants.mjs';
import { createProgressEmitter } from './lib/progress.mjs';
import { initTracing, shutdownTracing, setRootAttributes, recordRootException } from './lib/tracing.mjs';
import { cloneRepo, getCommitHistory, commitExists, addWorktree, removeWorktree } from './lib/git.mjs';
import { analyzeCommits } from './lib/analyze.mjs';
import { loadExistingData, createDataStructure } from './lib/data.mjs';
import { generateHTML } from './lib/html.mjs';

let JSON_PROGRESS = false;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
📊 Code Evolution Analyzer v${SCHEMA_VERSION}
========================

Analyzes code evolution over time by counting lines of code on every commit.
Supports incremental updates - only analyzes new commits on subsequent runs.

Usage:
  node analyze.mjs <git-repo-url> [output-dir] [options]

Arguments:
  git-repo-url      URL of the git repository to analyze (used for metadata)
  output-dir        Output directory (default: ./output)

Options:
  --force-full      Force full analysis, ignore existing data
  --json-progress   Output progress as JSONL to stderr for machine parsing
  --local-repo      Path to already cloned repository (uses a safe worktree)
  --counter <tool>  Code counter tool: 'scc' (default, ~80x faster) or 'cloc'

Counter Tools:
  scc   - Succinct Code Counter (Go, very fast, includes complexity metrics)
  cloc  - Count Lines of Code (Perl, traditional, more language mappings)

  Both tools provide: files, code lines, blank lines, comment lines
  scc additionally provides: complexity, bytes, total lines

Environment Variables (for distributed tracing):
  OTEL_TRACING_ENABLED        Set to 'true' to enable OpenTelemetry tracing
  OTEL_EXPORTER_OTLP_ENDPOINT OTLP endpoint URL (e.g., http://tempo:4318)
  OTEL_TRACE_PARENT           W3C traceparent for trace context propagation

Example:
  node analyze.mjs https://github.com/user/repo
  node analyze.mjs https://github.com/user/repo ./my-output
  node analyze.mjs https://github.com/user/repo ./output --force-full
  node analyze.mjs https://github.com/user/repo ./output --counter cloc
  node analyze.mjs https://github.com/user/repo ./output --json-progress
  node analyze.mjs https://github.com/user/repo ./output --local-repo /tmp/cloned-repo

Output:
  - output/data.json          Raw code count data for all commits (v2.2 schema)
  - output/visualization.html Interactive HTML animation

Incremental Updates:
  If data.json exists, only new commits will be analyzed and appended.
  This makes updates very fast for repos with long histories.
`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const repoUrl = args[0];
  let outputDir = './output';
  let forceFull = false;
  let localRepoPath = null;
  let jsonProgress = false;
  let counterTool = DEFAULT_COUNTER_TOOL;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--force-full') {
      forceFull = true;
    } else if (args[i] === '--json-progress') {
      jsonProgress = true;
    } else if (args[i] === '--local-repo' && args[i + 1]) {
      localRepoPath = args[++i];
    } else if (args[i] === '--counter' && args[i + 1]) {
      const tool = args[++i].toLowerCase();
      if (tool === 'scc' || tool === 'cloc') {
        counterTool = tool;
      } else {
        console.error(`Error: Invalid counter tool '${tool}'. Use 'scc' or 'cloc'.`);
        process.exit(1);
      }
    } else if (!args[i].startsWith('--')) {
      outputDir = args[i];
    }
  }

  JSON_PROGRESS = jsonProgress;
  const emitProgress = createProgressEmitter(jsonProgress);

  const tracingEnabled = await initTracing();
  if (tracingEnabled) {
    setRootAttributes({
      'analyzer.repository.url': repoUrl,
      'analyzer.output_dir': outputDir,
      'analyzer.force_full': forceFull,
      'analyzer.local_repo': localRepoPath || 'none',
      'analyzer.counter_tool': counterTool
    });
  }

  let success = false;

  emitProgress('validating', 0, 'Starting analysis...');

  if (!jsonProgress) {
    console.log(`📊 Code Evolution Analyzer v${SCHEMA_VERSION}`);
    console.log('========================\n');
    console.log(`Repository: ${repoUrl}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Counter: ${counterTool}${counterTool === 'scc' ? ' (fast)' : ''}`);
    if (forceFull) {
      console.log('Mode: Full analysis (--force-full)');
    }
    if (tracingEnabled) {
      console.log('Tracing: enabled');
    }
    console.log();
  }

  mkdirSync(outputDir, { recursive: true });

  let existingData = null;
  if (!forceFull) {
    existingData = loadExistingData(outputDir, {
      schemaVersion: SCHEMA_VERSION,
      emitProgress,
      jsonProgress
    });
    if (existingData) {
      if (existingData.metadata?.repository_url && existingData.metadata.repository_url !== repoUrl) {
        if (!jsonProgress) {
          console.log('⚠ Warning: Existing data is for a different repository. Regenerating from scratch.');
        } else {
          emitProgress('validating', 2, 'Existing data is for a different repository, regenerating');
        }
        existingData = null;
      } else if (existingData.metadata?.counter_tool && existingData.metadata.counter_tool !== counterTool) {
        if (!jsonProgress) {
          console.log(`⚠ Warning: Existing data used '${existingData.metadata.counter_tool}', but current run is '${counterTool}'. Regenerating from scratch.`);
        } else {
          emitProgress('validating', 2, 'Counter tool mismatch, regenerating', {
            existing_counter: existingData.metadata.counter_tool,
            current_counter: counterTool
          });
        }
        existingData = null;
      }
    }

    if (existingData) {
      if (!jsonProgress) {
        console.log(`✓ Found existing data (${existingData.results.length} commits)`);
        console.log(`  Last analyzed: ${existingData.metadata.last_commit_date}`);
        console.log(`  Last commit: ${existingData.metadata.last_commit_hash.substring(0, 8)}`);
      }
      emitProgress('validating', 3, 'Found existing analysis data', {
        existing_commits: existingData.results.length
      });
    }
  }

  let tempDir = null;
  let repoDir;
  let shouldCleanup = false;
  let worktreeBase = null;
  let worktreeDir = null;

  if (localRepoPath) {
    tempDir = mkdtempSync(join(tmpdir(), 'cloc-analysis-'));
    repoDir = join(tempDir, 'repo');
    shouldCleanup = true;
    worktreeBase = localRepoPath;
    worktreeDir = repoDir;
    addWorktree(localRepoPath, repoDir);
    if (!jsonProgress) {
      console.log(`📂 Using local repository (worktree): ${localRepoPath}`);
    }
    emitProgress('validating', 5, 'Using local repository (worktree)', { local_repo: localRepoPath });
  } else {
    tempDir = mkdtempSync(join(tmpdir(), 'cloc-analysis-'));
    repoDir = join(tempDir, 'repo');
    shouldCleanup = true;
  }

  let fatalError = null;

  try {
    if (!localRepoPath) {
      cloneRepo(repoUrl, repoDir, { emitProgress, jsonProgress });
    }

    let commits;
    if (existingData && existingData.metadata.last_commit_hash) {
      if (!commitExists(repoDir, existingData.metadata.last_commit_hash)) {
        if (!jsonProgress) {
          console.log('⚠ Warning: Last analyzed commit not found in repository. Regenerating from scratch.');
        } else {
          emitProgress('validating', 6, 'Last analyzed commit not found, regenerating');
        }
        existingData = null;
      }
    }

    if (existingData && existingData.metadata.last_commit_hash) {
      if (!jsonProgress) {
        console.log('\n🔄 Incremental mode: checking for new commits...');
      }
      commits = getCommitHistory(repoDir, 'main', existingData.metadata.last_commit_hash, {
        emitProgress,
        jsonProgress
      });

      if (commits.length === 0) {
        if (!jsonProgress) {
          console.log('\n✅ Already up to date! No new commits to analyze.');
          console.log(`\nVisualization: ${join(outputDir, 'visualization.html')}`);
        }
        emitProgress('complete', 100, 'Already up to date', {
          total_commits: existingData.results.length,
          output_dir: outputDir
        });
        success = true;
        return;
      }

      if (!jsonProgress) {
        console.log(`📝 Found ${commits.length} new commits to analyze`);
      }
    } else {
      commits = getCommitHistory(repoDir, 'main', null, { emitProgress, jsonProgress });
    }

    const existingResults = existingData ? existingData.results : [];
    const analysisData = analyzeCommits(repoDir, commits, existingResults, {
      emitProgress,
      jsonProgress,
      counterTool
    });

    const counterInfo = analysisData.results.length > 0
      ? {
          tool: analysisData.results[0].analysis.counter_tool || counterTool,
          version: analysisData.results[0].analysis.counter_version || 'unknown'
        }
      : { tool: counterTool, version: 'unknown' };

    const data = createDataStructure(
      repoUrl,
      analysisData.results,
      analysisData.allLanguages,
      analysisData.analysisTime,
      counterInfo,
      { counterTool, schemaVersion: SCHEMA_VERSION }
    );

    emitProgress('generating', 90, 'Saving analysis data...');
    const dataFile = join(outputDir, 'data.json');
    writeFileSync(dataFile, JSON.stringify(data, null, 2));
    if (!jsonProgress) {
      console.log(`\n💾 Data saved: ${dataFile}`);
      console.log(`   Schema version: ${data.schema_version}`);
      console.log(`   Total commits: ${data.results.length}`);
      console.log(`   Languages: ${data.allLanguages.length}`);
    }

    emitProgress('generating', 95, 'Generating HTML visualization...');
    const html = generateHTML(data, repoUrl);
    const htmlFile = join(outputDir, 'visualization.html');
    writeFileSync(htmlFile, html);
    if (!jsonProgress) {
      console.log(`🎨 Visualization generated: ${htmlFile}`);
    }

    if (tracingEnabled) {
      setRootAttributes({
        'analyzer.total_commits': data.results.length,
        'analyzer.languages_count': data.allLanguages.length,
        'analyzer.duration_seconds': analysisData.analysisTime
      });
    }

    emitProgress('complete', 100, 'Analysis complete!', {
      total_commits: data.results.length,
      languages: data.allLanguages.length,
      output_dir: outputDir
    });

    if (!jsonProgress) {
      console.log('\n✅ Analysis complete!');
      console.log(`\nOpen ${htmlFile} in a browser to view the animation.`);
    }

    success = true;
  } catch (error) {
    if (!jsonProgress) {
      console.error('\n❌ Error:', error.message);
    }
    emitProgress('failed', 0, `Analysis failed: ${error.message}`, {
      error: error.message,
      stack: error.stack
    });

    recordRootException(error);
    fatalError = error;
  } finally {
    if (worktreeBase && worktreeDir) {
      removeWorktree(worktreeBase, worktreeDir);
    }
    if (shouldCleanup && tempDir) {
      if (!jsonProgress) {
        console.log('\n🧹 Cleaning up temporary files...');
      }
      rmSync(tempDir, { recursive: true, force: true });
    }

    await shutdownTracing(success);

    if (fatalError) {
      throw fatalError;
    }
  }
}

main().catch((err) => {
  if (!JSON_PROGRESS) {
    console.error('Fatal error:', err);
  }
  process.exit(1);
});
