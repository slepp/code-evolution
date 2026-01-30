#!/usr/bin/env node

/**
 * CLOC History Analyzer v2.0
 * 
 * Clones a git repository and analyzes code composition over time by running
 * cloc on every commit. Generates an animated HTML visualization showing
 * language distribution evolution.
 * 
 * Features:
 * - Incremental updates (only analyzes new commits)
 * - Comprehensive cloc metadata capture
 * - Performance tracking
 * - OpenTelemetry distributed tracing support
 * 
 * Usage: node analyze.mjs <git-repo-url> [output-dir] [--force-full]
 */

import { execSync, spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCHEMA_VERSION = '2.0';

// =============================================================================
// OpenTelemetry Tracing (optional - only active when env vars are set)
// =============================================================================

let otelApi = null;
let tracer = null;
let rootSpan = null;
let rootContext = null;
let sdkShutdown = null;

/**
 * Initialize OpenTelemetry tracing if environment variables are set.
 * Reads OTEL_TRACE_PARENT from parent process (worker) to continue the trace.
 * 
 * @returns {Promise<boolean>} True if tracing was initialized
 */
async function initTracing() {
  // Check if tracing is enabled via environment
  if (process.env.OTEL_TRACING_ENABLED !== 'true' || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return false;
  }

  try {
    // Dynamic imports for optional dependencies
    const [
      { trace, context, SpanKind, SpanStatusCode },
      { NodeSDK },
      { OTLPTraceExporter },
      { Resource },
      { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
      { BatchSpanProcessor },
    ] = await Promise.all([
      import('@opentelemetry/api'),
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
      import('@opentelemetry/sdk-trace-node'),
    ]);

    otelApi = { trace, context, SpanKind, SpanStatusCode };

    // Configure OTLP exporter
    const exporter = new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    });

    // Create resource with service info
    const resource = new Resource({
      [ATTR_SERVICE_NAME]: 'cloc-history-analyzer',
      [ATTR_SERVICE_VERSION]: SCHEMA_VERSION,
    });

    // Initialize SDK
    const sdk = new NodeSDK({
      resource,
      spanProcessor: new BatchSpanProcessor(exporter),
    });

    sdk.start();
    sdkShutdown = () => sdk.shutdown();

    // Get tracer
    tracer = trace.getTracer('cloc-history-analyzer', SCHEMA_VERSION);

    // Parse parent trace context from environment (injected by worker)
    const parentContext = parseTraceParent(process.env.OTEL_TRACE_PARENT);
    
    if (parentContext) {
      // Create parent span context to continue the trace
      const parentSpanContext = {
        traceId: parentContext.traceId,
        spanId: parentContext.spanId,
        traceFlags: parentContext.traceFlags,
        isRemote: true,
      };

      // Set parent context and start root span as child
      const ctx = trace.setSpanContext(context.active(), parentSpanContext);
      rootSpan = tracer.startSpan('analyzer.run', {
        kind: SpanKind.INTERNAL,
      }, ctx);
      rootContext = trace.setSpan(ctx, rootSpan);
    } else {
      // No parent context, start new root span
      rootSpan = tracer.startSpan('analyzer.run', {
        kind: SpanKind.INTERNAL,
      });
      rootContext = trace.setSpan(context.active(), rootSpan);
    }

    return true;
  } catch (err) {
    // OTel packages not installed or initialization failed - continue without tracing
    if (process.env.DEBUG) {
      console.error('Tracing initialization failed:', err.message);
    }
    return false;
  }
}

/**
 * Parse W3C traceparent header format
 * Format: version-traceid-spanid-flags (e.g., "00-abc123...-def456...-01")
 * 
 * @param {string} traceparent - W3C traceparent string
 * @returns {{ traceId: string, spanId: string, traceFlags: number } | null}
 */
function parseTraceParent(traceparent) {
  if (!traceparent) return null;

  const parts = traceparent.split('-');
  if (parts.length !== 4) return null;

  const [version, traceId, spanId, flags] = parts;
  
  // Validate version (only 00 supported)
  if (version !== '00') return null;
  
  // Validate trace ID (32 hex chars, not all zeros)
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === '00000000000000000000000000000000') {
    return null;
  }
  
  // Validate span ID (16 hex chars, not all zeros)
  if (!/^[0-9a-f]{16}$/.test(spanId) || spanId === '0000000000000000') {
    return null;
  }

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
  };
}

/**
 * Create a child span for an operation
 * Returns a no-op span object if tracing is not initialized
 * 
 * @param {string} name - Span name
 * @param {object} attributes - Span attributes
 * @returns {{ span: object, end: function, setAttributes: function, setStatus: function, recordException: function }}
 */
function startSpan(name, attributes = {}) {
  if (!tracer || !otelApi) {
    // Return no-op span
    return {
      span: null,
      end: () => {},
      setAttributes: () => {},
      setStatus: () => {},
      recordException: () => {},
      addEvent: () => {},
    };
  }

  const span = tracer.startSpan(name, {
    kind: otelApi.SpanKind.INTERNAL,
    attributes,
  }, rootContext);

  return {
    span,
    end: () => span.end(),
    setAttributes: (attrs) => {
      for (const [key, value] of Object.entries(attrs)) {
        span.setAttribute(key, value);
      }
    },
    setStatus: (code, message) => {
      span.setStatus({ 
        code: code === 'error' ? otelApi.SpanStatusCode.ERROR : otelApi.SpanStatusCode.OK,
        message,
      });
    },
    recordException: (err) => span.recordException(err),
    addEvent: (name, attrs) => span.addEvent(name, attrs),
  };
}

/**
 * Shutdown tracing and flush spans
 */
async function shutdownTracing(success = true) {
  if (rootSpan && otelApi) {
    rootSpan.setStatus({ 
      code: success ? otelApi.SpanStatusCode.OK : otelApi.SpanStatusCode.ERROR,
    });
    rootSpan.end();
  }

  if (sdkShutdown) {
    try {
      await sdkShutdown();
    } catch (err) {
      // Ignore shutdown errors
    }
  }
}

// =============================================================================
// End OpenTelemetry Tracing
// =============================================================================

// Global flag for JSON progress output
let JSON_PROGRESS = false;

// Counter tool to use: 'scc' (default, ~80x faster) or 'cloc'
let COUNTER_TOOL = 'scc';

// Exclude directories for code counting (common build/dependency folders)
const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', 'target', 'pkg', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'vendor'];

/**
 * Emit a progress event as JSONL to stderr
 * @param {string} stage - Current stage (validating, cloning, analyzing, generating, complete)
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} message - Human-readable message
 * @param {object} data - Additional data
 */
function emitProgress(stage, progress, message, data = {}) {
  if (!JSON_PROGRESS) return;
  
  const event = {
    type: 'progress',
    stage,
    progress: Math.min(100, Math.max(0, progress)),
    message,
    timestamp: new Date().toISOString(),
    ...data
  };
  
  console.error(JSON.stringify(event));
}

function exec(cmd, options = {}) {
  try {
    return execSync(cmd, { 
      encoding: 'utf8', 
      stdio: options.silent ? 'pipe' : ['pipe', 'pipe', 'inherit'],
      ...options 
    }).trim();
  } catch (error) {
    if (options.ignoreError) {
      return '';
    }
    throw error;
  }
}

function cloneRepo(repoUrl, targetDir) {
  const span = startSpan('analyzer.clone', {
    'git.repository.url': repoUrl,
    'git.clone.target_dir': targetDir,
  });

  if (!JSON_PROGRESS) {
    console.log(`\n📦 Cloning repository: ${repoUrl}`);
  }
  emitProgress('cloning', 5, `Cloning repository: ${repoUrl}`);
  
  try {
    exec(`git clone "${repoUrl}" "${targetDir}"`);
    
    if (!JSON_PROGRESS) {
      console.log('✓ Clone complete');
    }
    emitProgress('cloning', 10, 'Clone complete');
    span.setStatus('ok');
  } catch (err) {
    span.setStatus('error', err.message);
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

function getCommitHistory(repoDir, branch = 'main', afterCommit = null) {
  const span = startSpan('analyzer.get_commits', {
    'git.branch': branch,
    'git.after_commit': afterCommit || 'none',
  });

  const label = afterCommit ? 'new commits' : 'commit history';
  if (!JSON_PROGRESS) {
    console.log(`\n📜 Getting ${label} from branch: ${branch}`);
  }
  
  try {
    // Determine the actual branch to use
    // Priority: requested branch -> main -> master -> default branch (from origin/HEAD)
    const branches = exec(`git -C "${repoDir}" branch -r`, { silent: true });
    const hasMain = branches.includes('origin/main');
    const hasMaster = branches.includes('origin/master');
    
    let actualBranch = branch;
    if (branch === 'main' && !hasMain) {
      if (hasMaster) {
        actualBranch = 'master';
        if (!JSON_PROGRESS) {
          console.log('  (using master branch instead)');
        }
      } else {
        // Neither main nor master exists - try to get the default branch from origin/HEAD
        const defaultBranchRef = exec(`git -C "${repoDir}" symbolic-ref refs/remotes/origin/HEAD`, { silent: true, ignoreError: true });
        if (defaultBranchRef && defaultBranchRef.trim()) {
          // Extract branch name from "refs/remotes/origin/dev" -> "dev"
          const match = defaultBranchRef.trim().match(/refs\/remotes\/origin\/(.+)/);
          if (match) {
            actualBranch = match[1];
            if (!JSON_PROGRESS) {
              console.log(`  (using default branch '${actualBranch}' instead)`);
            }
          }
        }
      }
    }
    
    span.setAttributes({ 'git.actual_branch': actualBranch });
    
    // Get commits in chronological order (oldest first)
    // If afterCommit is provided, only get commits after that hash
    let logCmd = `git -C "${repoDir}" log ${actualBranch} --reverse --pretty=format:"%H|%ad|%s" --date=short`;
    if (afterCommit) {
      logCmd = `git -C "${repoDir}" log ${afterCommit}..${actualBranch} --reverse --pretty=format:"%H|%ad|%s" --date=short`;
    }
    
    const commits = exec(logCmd, { silent: true, ignoreError: true })
      .split('\n')
      .filter(line => line.trim());
    
    if (!JSON_PROGRESS) {
      console.log(`✓ Found ${commits.length} commits`);
    }
    emitProgress('analyzing', 12, `Found ${commits.length} commits`, { total_commits: commits.length });
    
    span.setAttributes({ 'git.commits.count': commits.length });
    span.setStatus('ok');
    
    return commits.map(line => {
      const [hash, date, ...messageParts] = line.split('|');
      return {
        hash: hash.trim(),
        date: date.trim(),
        message: messageParts.join('|').trim()
      };
    });
  } catch (err) {
    span.setStatus('error', err.message);
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Run scc (Succinct Code Counter) - ~80x faster than cloc
 * @param {string} repoDir - Directory to analyze
 * @returns {object} Analysis results with languages and metadata
 */
function runScc(repoDir) {
  try {
    const startTime = Date.now();
    
    // Build exclude args for scc
    const excludeArgs = EXCLUDE_DIRS.map(d => `--exclude-dir "${d}"`).join(' ');
    
    // scc options:
    // --format json: JSON output
    // --no-cocomo: Skip COCOMO cost estimation (not needed)
    // --count-as: Map common config files to their types
    const result = exec(
      `scc "${repoDir}" --format json --no-cocomo ${excludeArgs} --count-as "editorconfig:INI"`,
      { silent: true, ignoreError: true }
    );
    
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    
    if (!result) {
      return { 
        languages: {},
        analysis: {
          elapsed_seconds: elapsedSeconds,
          n_files: 0,
          n_lines: 0,
          files_per_second: 0,
          lines_per_second: 0,
          counter_tool: 'scc',
          counter_version: 'unknown'
        }
      };
    }
    
    const data = JSON.parse(result);
    
    // Calculate totals from scc output
    let totalFiles = 0;
    let totalLines = 0;
    
    // Extract language data from scc array format
    const languages = {};
    for (const entry of data) {
      const langName = entry.Name;
      
      languages[langName] = {
        files: entry.Count || 0,
        blank: entry.Blank || 0,
        comment: entry.Comment || 0,
        code: entry.Code || 0,
        // Extra fields only available from scc
        complexity: entry.Complexity || 0,
        bytes: entry.Bytes || 0,
        lines: entry.Lines || 0
      };
      
      totalFiles += entry.Count || 0;
      totalLines += entry.Lines || 0;
    }
    
    const analysis = {
      elapsed_seconds: elapsedSeconds,
      n_files: totalFiles,
      n_lines: totalLines,
      files_per_second: elapsedSeconds > 0 ? totalFiles / elapsedSeconds : 0,
      lines_per_second: elapsedSeconds > 0 ? totalLines / elapsedSeconds : 0,
      counter_tool: 'scc',
      counter_version: '3.x' // scc doesn't include version in JSON output
    };
    
    return { languages, analysis };
  } catch (error) {
    console.error(`    ⚠ Warning: scc failed - ${error.message}`);
    return { 
      languages: {},
      analysis: {
        elapsed_seconds: 0,
        n_files: 0,
        n_lines: 0,
        files_per_second: 0,
        lines_per_second: 0,
        counter_tool: 'scc',
        counter_version: 'unknown'
      }
    };
  }
}

/**
 * Run cloc (Count Lines of Code) - traditional tool, more thorough but slower
 * @param {string} repoDir - Directory to analyze
 * @returns {object} Analysis results with languages and metadata
 */
function runCloc(repoDir) {
  try {
    const excludeDirs = EXCLUDE_DIRS.join(',');
    const result = exec(
      `cloc "${repoDir}" --json --quiet --exclude-dir=${excludeDirs}`,
      { silent: true, ignoreError: true }
    );
    
    if (!result) {
      return { 
        languages: {},
        analysis: {
          elapsed_seconds: 0,
          n_files: 0,
          n_lines: 0,
          files_per_second: 0,
          lines_per_second: 0,
          counter_tool: 'cloc',
          counter_version: 'unknown'
        }
      };
    }
    
    const data = JSON.parse(result);
    
    // Extract header metadata
    const header = data.header || {};
    const analysis = {
      elapsed_seconds: header.elapsed_seconds || 0,
      n_files: header.n_files || 0,
      n_lines: header.n_lines || 0,
      files_per_second: header.files_per_second || 0,
      lines_per_second: header.lines_per_second || 0,
      counter_tool: 'cloc',
      counter_version: header.cloc_version || 'unknown'
    };
    
    // Extract language data (skip header and SUM entries)
    const languages = {};
    for (const [lang, stats] of Object.entries(data)) {
      if (lang !== 'header' && lang !== 'SUM') {
        languages[lang] = {
          files: stats.nFiles || 0,
          blank: stats.blank || 0,
          comment: stats.comment || 0,
          code: stats.code || 0
        };
      }
    }
    
    return { languages, analysis };
  } catch (error) {
    console.error(`    ⚠ Warning: cloc failed - ${error.message}`);
    return { 
      languages: {},
      analysis: {
        elapsed_seconds: 0,
        n_files: 0,
        n_lines: 0,
        files_per_second: 0,
        lines_per_second: 0,
        counter_tool: 'cloc',
        counter_version: 'unknown'
      }
    };
  }
}

/**
 * Run the configured code counter tool (scc or cloc)
 * @param {string} repoDir - Directory to analyze
 * @returns {object} Analysis results with languages and metadata
 */
function runCounter(repoDir) {
  if (COUNTER_TOOL === 'scc') {
    return runScc(repoDir);
  } else {
    return runCloc(repoDir);
  }
}

function analyzeCommits(repoDir, commits, existingResults = []) {
  const span = startSpan('analyzer.analyze_commits', {
    'analyzer.commits.new': commits.length,
    'analyzer.commits.existing': existingResults.length,
  });

  if (!JSON_PROGRESS) {
    console.log(`\n🔍 Analyzing ${commits.length} commits...\n`);
  }
  
  const results = [...existingResults]; // Start with existing results
  const allLanguages = new Set();
  
  // Track languages from existing results
  for (const result of existingResults) {
    Object.keys(result.languages).forEach(lang => allLanguages.add(lang));
  }
  
  const startTime = Date.now();
  const totalCommits = commits.length;
  
  try {
    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i];
      const progress = `[${i + 1}/${commits.length}]`;
      
      // Calculate progress percentage (15% to 85% of total progress)
      const commitProgress = 15 + Math.floor((i / totalCommits) * 70);
      
      if (!JSON_PROGRESS) {
        process.stdout.write(`${progress} ${commit.hash.substring(0, 8)} (${commit.date})...`);
      }
      
      emitProgress('analyzing', commitProgress, `Analyzing commit ${i + 1} of ${totalCommits}`, {
        current_commit: i + 1,
        total_commits: totalCommits,
        commit_hash: commit.hash.substring(0, 8),
        commit_date: commit.date
      });
      
      // Checkout commit
      exec(`git -C "${repoDir}" checkout -q ${commit.hash}`, { silent: true });
      
      // Run counter (scc or cloc based on COUNTER_TOOL setting)
      const counterData = runCounter(repoDir);
      
      // Track all languages we've seen
      Object.keys(counterData.languages).forEach(lang => allLanguages.add(lang));
      
      results.push({
        commit: commit.hash,
        date: commit.date,
        message: commit.message,
        analysis: counterData.analysis,
        languages: counterData.languages
      });
      
      if (!JSON_PROGRESS) {
        process.stdout.write(' ✓\n');
      }
    }
    
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    
    if (commits.length > 0) {
      if (!JSON_PROGRESS) {
        console.log(`\n✓ Analysis complete (${elapsedSeconds.toFixed(2)}s)`);
        console.log(`📊 Languages found: ${Array.from(allLanguages).sort().join(', ')}`);
      }
      emitProgress('analyzing', 85, 'Analysis complete', {
        elapsed_seconds: elapsedSeconds,
        languages: Array.from(allLanguages).sort()
      });
    }
    
    // Handle empty results case
    if (results.length === 0) {
      span.setAttributes({
        'analyzer.languages.count': 0,
        'analyzer.total_lines': 0,
        'analyzer.duration_seconds': elapsedSeconds,
      });
      span.setStatus('ok');
      
      return {
        results: [],
        allLanguages: [],
        analysisTime: elapsedSeconds
      };
    }
    
    // Calculate stable sort order based on final commit
    const finalCommit = results[results.length - 1];
    let totalLinesInFinal = 0;
    for (const lang in finalCommit.languages) {
      totalLinesInFinal += finalCommit.languages[lang].code;
    }
    
    // Sort languages by their percentage in the final commit
    const languageOrder = Array.from(allLanguages).sort((a, b) => {
      const linesA = finalCommit.languages[a]?.code || 0;
      const linesB = finalCommit.languages[b]?.code || 0;
      const percA = totalLinesInFinal > 0 ? (linesA / totalLinesInFinal) : 0;
      const percB = totalLinesInFinal > 0 ? (linesB / totalLinesInFinal) : 0;
      
      if (percB !== percA) {
        return percB - percA; // Descending by percentage
      }
      return a.localeCompare(b); // Alphabetical tie-breaker
    });
    
    span.setAttributes({
      'analyzer.languages.count': allLanguages.size,
      'analyzer.total_lines': totalLinesInFinal,
      'analyzer.duration_seconds': elapsedSeconds,
    });
    span.setStatus('ok');
    
    return {
      results,
      allLanguages: languageOrder,
      analysisTime: elapsedSeconds
    };
  } catch (err) {
    span.setStatus('error', err.message);
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Load existing data.json if it exists
 */
function loadExistingData(outputDir) {
  const dataFile = join(outputDir, 'data.json');
  
  if (!existsSync(dataFile)) {
    return null;
  }
  
  try {
    const content = readFileSync(dataFile, 'utf8');
    const data = JSON.parse(content);
    
    // Check schema version
    if (!data.schema_version) {
      console.log('⚠ Warning: Found old data format (v1.0), will regenerate from scratch');
      return null;
    }
    
    if (data.schema_version !== SCHEMA_VERSION) {
      console.log(`⚠ Warning: Data schema mismatch (found ${data.schema_version}, expected ${SCHEMA_VERSION})`);
      console.log('  Will regenerate from scratch');
      return null;
    }
    
    return data;
  } catch (error) {
    console.log(`⚠ Warning: Could not load existing data - ${error.message}`);
    return null;
  }
}

/**
 * Create data structure with metadata
 */
function createDataStructure(repoUrl, results, allLanguages, analysisTime, counterInfo) {
  const lastCommit = results.length > 0 ? results[results.length - 1] : null;
  
  return {
    schema_version: SCHEMA_VERSION,
    metadata: {
      repository_url: repoUrl,
      analyzed_at: new Date().toISOString(),
      total_commits: results.length,
      total_duration_seconds: analysisTime,
      counter_tool: counterInfo?.tool || COUNTER_TOOL,
      counter_version: counterInfo?.version || 'unknown',
      // Keep cloc_version for backward compatibility
      cloc_version: counterInfo?.version || 'unknown',
      last_commit_hash: lastCommit ? lastCommit.commit : null,
      last_commit_date: lastCommit ? lastCommit.date : null
    },
    results: results,
    allLanguages: allLanguages
  };
}

function generateHTML(data, repoUrl) {
  const span = startSpan('analyzer.generate_html', {
    'analyzer.commits.count': data.results.length,
    'analyzer.languages.count': data.allLanguages.length,
  });

  try {
    const { results, allLanguages } = data;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0d1117">
  <title>Code Evolution: ${repoUrl}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {
      /* Terminal dark palette */
      --bg-void: #0a0c10;
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #21262d;
      --bg-elevated: #30363d;

      /* Vivid accent colors for data visualization */
      --accent-cyan: #58d5e3;
      --accent-purple: #a371f7;
      --accent-pink: #f778ba;
      --accent-orange: #f7845e;
      --accent-yellow: #f0c239;
      --accent-green: #3fb950;
      --accent-blue: #58a6ff;

      /* Text hierarchy */
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-tertiary: #6e7681;
      --text-inverse: #0d1117;

      /* Semantic */
      --success: #3fb950;
      --error: #f85149;

      /* Borders */
      --border-default: #30363d;
      --border-muted: #21262d;

      /* Typography */
      --font-display: 'Sora', system-ui, sans-serif;
      --font-mono: 'JetBrains Mono', 'SF Mono', monospace;

      /* Animation */
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--font-display);
      background: var(--bg-void);
      background-image:
        linear-gradient(rgba(88, 213, 227, 0.015) 1px, transparent 1px),
        linear-gradient(90deg, rgba(88, 213, 227, 0.015) 1px, transparent 1px);
      background-size: 40px 40px;
      min-height: 100vh;
      padding: 1rem;
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
    }

    .container {
      background: var(--bg-primary);
      border: 1px solid var(--border-default);
      border-radius: 12px;
      max-width: 1800px;
      width: 100%;
      margin: 0 auto;
      overflow: hidden;
      position: relative;
    }

    /* Rainbow accent bar */
    .container::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg,
        var(--accent-cyan) 0%,
        var(--accent-purple) 25%,
        var(--accent-pink) 50%,
        var(--accent-orange) 75%,
        var(--accent-yellow) 100%
      );
    }

    .header {
      padding: 1.5rem 1.5rem 1rem;
      border-bottom: 1px solid var(--border-muted);
    }

    h1 {
      font-family: var(--font-mono);
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    h1::before {
      content: '>';
      color: var(--accent-cyan);
      font-weight: 400;
    }

    .repo-url {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-tertiary);
      word-break: break-all;
      padding-left: 1.1rem;
    }

    .content-wrapper {
      padding: 1rem 1.5rem 1.5rem;
    }

    .main-content {
      display: flex;
      gap: 1.25rem;
      margin-top: 1rem;
    }

    .left-panel {
      flex: 0 0 420px;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .right-panel {
      flex: 1;
      min-width: 0;
    }

    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      transition: border-color 0.25s var(--ease-out);
    }

    .card:hover {
      border-color: var(--accent-cyan);
    }

    .chart-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      padding: 1rem;
      height: 580px;
      position: relative;
    }

    #chart-canvas {
      max-height: 100%;
    }

    .commit-info {
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      padding: 0.75rem 1rem;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.75rem;
    }

    .commit-date {
      font-family: var(--font-mono);
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--accent-cyan);
    }

    .commit-meta {
      text-align: right;
    }

    .commit-hash {
      font-family: var(--font-mono);
      background: var(--bg-tertiary);
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      color: var(--text-secondary);
      display: inline-block;
    }

    .commit-number {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--text-tertiary);
      margin-top: 0.25rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .table-container {
      flex: 1;
      overflow-y: auto;
      max-height: 450px;
      border-radius: 8px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      padding: 0.5rem 0.75rem;
      text-align: left;
      font-family: var(--font-mono);
      font-weight: 600;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      position: sticky;
      top: 0;
      z-index: 10;
      border-bottom: 1px solid var(--border-default);
    }

    th:nth-child(2), th:nth-child(3), th:nth-child(4) {
      text-align: right;
    }

    td {
      padding: 0.4rem 0.75rem;
      border-bottom: 1px solid var(--border-muted);
      font-size: 0.8rem;
    }

    tbody tr {
      transition: background 0.15s;
    }

    tbody tr:hover {
      background: var(--bg-tertiary);
    }

    .language-name {
      font-family: var(--font-mono);
      font-weight: 600;
      font-size: 0.75rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .percentage-text {
      text-align: right;
      font-family: var(--font-mono);
      font-weight: 600;
      color: var(--accent-cyan);
      font-size: 0.75rem;
    }

    .lines-count {
      text-align: right;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      font-weight: 500;
      font-size: 0.75rem;
    }

    .lines-secondary {
      display: block;
      font-size: 0.6rem;
      color: var(--text-tertiary);
      margin-top: 0.15rem;
      font-weight: 400;
    }

    .files-count {
      text-align: right;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      font-size: 0.75rem;
    }

    .row-inactive {
      opacity: 0.35;
    }

    .delta {
      font-size: 0.65rem;
      margin-left: 0.25rem;
      font-weight: 600;
    }

    .delta-positive { color: var(--success); }
    .delta-negative { color: var(--error); }
    .delta-neutral { color: var(--text-tertiary); }

    .summary-stats {
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      padding: 0.75rem;
      border-radius: 8px;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
    }

    .stat-item {
      text-align: center;
      padding: 0.5rem;
      background: var(--bg-tertiary);
      border-radius: 6px;
    }

    .stat-label {
      font-family: var(--font-mono);
      font-size: 0.6rem;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 0.25rem;
    }

    .stat-value {
      font-family: var(--font-mono);
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--accent-cyan);
    }

    .stat-delta {
      font-size: 0.7rem;
      font-weight: 600;
      margin-top: 0.15rem;
    }

    .controls {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .controls-primary {
      display: flex;
      gap: 0.5rem;
    }

    .controls-secondary {
      display: flex;
      gap: 0.35rem;
      padding-left: 0.5rem;
      border-left: 1px solid var(--border-muted);
    }

    button {
      font-family: var(--font-mono);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-default);
      padding: 0.5rem 0.875rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s var(--ease-out);
    }

    button:hover {
      background: var(--bg-elevated);
      border-color: var(--accent-cyan);
    }

    button.primary {
      background: linear-gradient(135deg, var(--accent-cyan) 0%, var(--accent-blue) 100%);
      color: var(--text-inverse);
      border: none;
      padding: 0.6rem 1.25rem;
      font-size: 0.8rem;
      box-shadow: 0 0 15px rgba(88, 213, 227, 0.25);
    }

    button.primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 20px rgba(88, 213, 227, 0.35);
    }

    button.secondary {
      background: transparent;
      color: var(--text-tertiary);
      border: 1px solid var(--border-muted);
      padding: 0.35rem 0.6rem;
      font-size: 0.65rem;
      opacity: 0.7;
    }

    button.secondary:hover {
      opacity: 1;
      color: var(--text-secondary);
      border-color: var(--border-default);
      background: var(--bg-tertiary);
    }

    button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }

    .speed-control {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      margin-left: 0.5rem;
      padding-left: 0.5rem;
      border-left: 1px solid var(--border-default);
    }

    .speed-control label {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .speed-control select {
      font-family: var(--font-mono);
      padding: 0.35rem 0.5rem;
      border: 1px solid var(--border-default);
      border-radius: 4px;
      font-size: 0.7rem;
      cursor: pointer;
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .sound-control {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      margin-left: 0.5rem;
      padding-left: 0.5rem;
      border-left: 1px solid var(--border-default);
    }

    .sound-control.hidden {
      display: none;
    }

    .sound-btn {
      padding: 0.35rem 0.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .sound-btn.active {
      background: var(--accent-purple);
      border-color: var(--accent-purple);
      color: white;
    }

    .sound-icon {
      display: block;
    }

    #sound-volume {
      width: 60px;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: var(--bg-tertiary);
      border-radius: 2px;
      cursor: pointer;
    }

    #sound-volume::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      background: var(--accent-cyan);
      border-radius: 50%;
      cursor: pointer;
    }

    #sound-volume::-moz-range-thumb {
      width: 12px;
      height: 12px;
      background: var(--accent-cyan);
      border-radius: 50%;
      cursor: pointer;
      border: none;
    }

    .empty-state {
      text-align: center;
      padding: 2rem;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      font-size: 0.8rem;
    }

    .timeline {
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      padding: 0.75rem 1rem;
      border-radius: 8px;
    }

    .timeline-bar {
      width: 100%;
      height: 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      overflow: hidden;
      cursor: pointer;
      position: relative;
    }

    .timeline-bar:hover {
      height: 10px;
    }

    .timeline-bar:active {
      cursor: grabbing;
    }

    .timeline-progress {
      height: 100%;
      background: linear-gradient(90deg, var(--accent-cyan) 0%, var(--accent-purple) 100%);
      border-radius: 4px;
      transition: width 0.1s linear;
      position: relative;
      pointer-events: none;
    }

    .timeline-progress::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
      animation: shimmer 1.5s infinite;
    }

    @keyframes shimmer {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }

    .top-bar {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 1rem;
      align-items: center;
      margin-bottom: 0.75rem;
    }

    .top-bar .commit-info {
      margin: 0;
    }

    .top-bar .timeline {
      margin: 0;
    }

    .footer {
      padding: 1rem 1.5rem;
      border-top: 1px solid var(--border-muted);
      text-align: center;
      font-size: 0.7rem;
      color: var(--text-tertiary);
    }

    .footer a {
      color: var(--accent-cyan);
      text-decoration: none;
    }

    .footer a:hover {
      color: var(--text-primary);
    }

    @media (max-width: 1200px) {
      .main-content {
        flex-direction: column;
      }

      .left-panel {
        flex: none;
        width: 100%;
      }

      .table-container {
        max-height: 350px;
      }

      .chart-container {
        height: 400px;
      }

      .top-bar {
        grid-template-columns: 1fr;
        gap: 0.75rem;
      }
    }

    @media (max-width: 600px) {
      body {
        padding: 0.5rem;
      }

      .header, .content-wrapper {
        padding: 1rem;
      }

      h1 {
        font-size: 1rem;
      }

      .controls {
        gap: 0.5rem;
      }

      .controls-primary {
        gap: 0.35rem;
      }

      .controls-secondary {
        padding-left: 0.35rem;
      }

      button.primary {
        padding: 0.5rem 0.9rem;
        font-size: 0.7rem;
      }

      button.secondary {
        padding: 0.3rem 0.5rem;
        font-size: 0.6rem;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Code Evolution</h1>
      <div class="repo-url">${escapeHtml(repoUrl)}</div>
    </div>

    <div class="content-wrapper">
      <div class="top-bar">
        <div class="commit-info">
          <div class="commit-date" id="commit-date">Loading...</div>
          <div class="commit-meta">
            <div class="commit-hash" id="commit-hash">--------</div>
            <div class="commit-number" id="commit-number">Commit 0 of 0</div>
          </div>
        </div>

        <div class="controls">
          <div class="controls-primary">
            <button id="play-pause" class="primary">Play</button>
            <button id="go-latest" class="primary">Latest</button>
          </div>
          <div class="controls-secondary">
            <button id="prev" class="secondary">Prev</button>
            <button id="next" class="secondary">Next</button>
            <button id="reset" class="secondary">Reset</button>
          </div>
          <div class="speed-control">
            <label>Speed</label>
            <select id="speed">
              <option value="0.5">0.5x</option>
              <option value="1" selected>1x</option>
              <option value="2">2x</option>
              <option value="4">4x</option>
            </select>
          </div>
          <div class="sound-control" id="sound-control">
            <button id="sound-toggle" class="secondary sound-btn" title="Toggle sound">
              <svg class="sound-icon sound-off" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </svg>
              <svg class="sound-icon sound-on" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="display:none">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
              </svg>
            </button>
            <input type="range" id="sound-volume" min="0" max="100" value="70" title="Volume">
          </div>
        </div>

        <div class="timeline">
          <div class="timeline-bar">
            <div class="timeline-progress" id="timeline-progress"></div>
          </div>
        </div>
      </div>

      <div class="main-content">
        <div class="left-panel">
          <div class="summary-stats" id="summary-stats">
            <div class="stat-item">
              <div class="stat-label">Total Lines</div>
              <div class="stat-value" id="total-lines">0</div>
              <div class="stat-delta" id="total-delta"></div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Total Files</div>
              <div class="stat-value" id="total-files">0</div>
              <div class="stat-delta" id="files-delta"></div>
            </div>
          </div>

          <div class="card table-container">
            <table id="stats-table">
              <thead>
                <tr>
                  <th>Language</th>
                  <th>%</th>
                  <th>Lines</th>
                  <th>Files</th>
                </tr>
              </thead>
              <tbody id="table-body">
                <tr>
                  <td colspan="4" class="empty-state">Loading data...</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="right-panel">
          <div class="chart-container">
            <canvas id="chart-canvas"></canvas>
          </div>
        </div>
      </div>
    </div>

    <div class="footer">
      Generated by <a href="https://github.com/slepp/cloc-history-analyzer">CLOC History Analyzer</a>
      &mdash; &copy; 2026 <a href="https://slepp.ca/">slepp</a>
    </div>
  </div>

  <script>
    const DATA = ${JSON.stringify(results)};
    const ALL_LANGUAGES = ${JSON.stringify(allLanguages)};

    let currentIndex = 0;
    let isPlaying = false;
    let animationInterval = null;
    let chart = null;
    let lastChartIndex = -1; // Track last chart update index for incremental updates
    let isSeeking = false; // Track if user is dragging timeline

    // Dynamic frame delay: 20 second max playback at 1x, max 500ms per frame, min 50ms
    const TARGET_DURATION_MS = 20000;
    const MAX_FRAME_DELAY = 500;
    const MIN_FRAME_DELAY = 50;
    const baseFrameDelay = Math.min(MAX_FRAME_DELAY, Math.max(MIN_FRAME_DELAY, Math.floor(TARGET_DURATION_MS / DATA.length)));
    let speedMultiplier = 1;

    // Audio sonification
    const AUDIO_SUPPORTED = !!(window.AudioContext || window.webkitAudioContext);
    // Major scale starting from C4 (261.63 Hz) - audible on all speakers
    // Using C4 (middle C) instead of C2 for better audibility
    // C, D, E, F, G, A, B, C, D, E, F, G, A, B, C, D...
    const C4 = 261.63;  // Middle C - 2 octaves higher than C2 for audibility
    const MAJOR_SCALE_SEMITONES = [0, 2, 4, 5, 7, 9, 11]; // Major scale intervals
    const FILTER_CUTOFF = 2500;        // Hz - saw brightness cap
    const FILTER_Q_BASE = 1;           // Resonance minimum
    const FILTER_Q_MAX = 8;            // Resonance at max intensity
    const RAMP_TIME_MS = 50;           // Smooth parameter transitions
    const MAX_VOICES = 16;             // Limit oscillators (matches color palette)
    const VOLUME_MIN = 0.8;            // Minimum volume scaling (80%)
    const VOLUME_MAX = 1.0;            // Maximum volume scaling (100%)
    const REVERB_DECAY = 1.5;          // Reverb decay time in seconds
    const REVERB_PREDELAY = 0.02;      // Reverb predelay in seconds
    const REVERB_WET = 0.15;           // Reverb wet mix (0-1)

    let audioCtx = null;
    let soundEnabled = false;
    let masterGain = null;
    let filter = null;
    let reverb = null;
    let reverbWetGain = null;
    let reverbDryGain = null;
    let voices = [];
    let languageVoiceMap = {};  // Map language name to voice index (stable assignment)

    // Data visualization color palette - vivid, distinct colors
    const LANGUAGE_COLORS = {};
    const colorPalette = [
      '#58d5e3', '#a371f7', '#f778ba', '#f7845e',
      '#f0c239', '#3fb950', '#58a6ff', '#ff7b72',
      '#79c0ff', '#d2a8ff', '#7ee787', '#ffa657',
      '#a5d6ff', '#ffbedd', '#56d4dd', '#ffd33d'
    ];
    ALL_LANGUAGES.forEach((lang, i) => {
      LANGUAGE_COLORS[lang] = colorPalette[i % colorPalette.length];
    });
    
    const elements = {
      date: document.getElementById('commit-date'),
      hash: document.getElementById('commit-hash'),
      number: document.getElementById('commit-number'),
      tableBody: document.getElementById('table-body'),
      playPause: document.getElementById('play-pause'),
      goLatest: document.getElementById('go-latest'),
      prev: document.getElementById('prev'),
      next: document.getElementById('next'),
      reset: document.getElementById('reset'),
      speed: document.getElementById('speed'),
      timeline: document.getElementById('timeline-progress'),
      timelineBar: document.querySelector('.timeline-bar'),
      soundControl: document.getElementById('sound-control'),
      soundToggle: document.getElementById('sound-toggle'),
      soundVolume: document.getElementById('sound-volume'),
      soundIconOff: document.querySelector('.sound-off'),
      soundIconOn: document.querySelector('.sound-on'),
      totalLines: document.getElementById('total-lines'),
      totalDelta: document.getElementById('total-delta'),
      totalFiles: document.getElementById('total-files'),
      filesDelta: document.getElementById('files-delta')
    };
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function formatNumber(num) {
      return num.toLocaleString();
    }
    
    function formatDelta(current, previous) {
      if (previous === undefined || previous === null) {
        return '';
      }
      const delta = current - previous;
      if (delta === 0) {
        return '<span class="delta delta-neutral">±0</span>';
      } else if (delta > 0) {
        return \`<span class="delta delta-positive">+\${formatNumber(delta)}</span>\`;
      } else {
        return \`<span class="delta delta-negative">\${formatNumber(delta)}</span>\`;
      }
    }
    
    function initChart() {
      const ctx = document.getElementById('chart-canvas').getContext('2d');

      // Chart.js dark theme configuration
      Chart.defaults.color = '#8b949e';
      Chart.defaults.borderColor = '#30363d';

      // Prepare datasets for each language
      const datasets = ALL_LANGUAGES.map(lang => ({
        label: lang,
        data: [],
        borderColor: LANGUAGE_COLORS[lang],
        backgroundColor: LANGUAGE_COLORS[lang] + '15',
        borderWidth: 2,
        tension: 0.2,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: LANGUAGE_COLORS[lang],
        pointHoverBorderColor: '#e6edf3',
        pointHoverBorderWidth: 2,
        fill: false
      }));

      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: {
            duration: 0
          },
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: {
                boxWidth: 10,
                boxHeight: 10,
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                padding: 12,
                usePointStyle: true,
                pointStyle: 'circle',
                color: '#8b949e'
              }
            },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: '#161b22',
              borderColor: '#30363d',
              borderWidth: 1,
              titleFont: { family: "'JetBrains Mono', monospace", size: 11, weight: '600' },
              bodyFont: { family: "'JetBrains Mono', monospace", size: 10 },
              titleColor: '#e6edf3',
              bodyColor: '#8b949e',
              padding: 10,
              cornerRadius: 6,
              callbacks: {
                label: function(context) {
                  return ' ' + context.dataset.label + ': ' + formatNumber(context.parsed.y) + ' lines';
                }
              }
            }
          },
          scales: {
            x: {
              title: {
                display: true,
                text: 'COMMIT',
                font: { family: "'JetBrains Mono', monospace", size: 9, weight: '600' },
                color: '#6e7681',
                padding: { top: 8 }
              },
              ticks: {
                font: { family: "'JetBrains Mono', monospace", size: 9 },
                color: '#6e7681',
                maxRotation: 0
              },
              grid: {
                color: '#21262d',
                lineWidth: 1
              }
            },
            y: {
              title: {
                display: true,
                text: 'LINES OF CODE',
                font: { family: "'JetBrains Mono', monospace", size: 9, weight: '600' },
                color: '#6e7681',
                padding: { bottom: 8 }
              },
              ticks: {
                font: { family: "'JetBrains Mono', monospace", size: 9 },
                color: '#6e7681',
                callback: function(value) {
                  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
                  if (value >= 1000) return (value / 1000).toFixed(0) + 'k';
                  return value;
                }
              },
              grid: {
                color: '#21262d',
                lineWidth: 1
              },
              beginAtZero: true
            }
          },
          interaction: {
            mode: 'nearest',
            axis: 'x',
            intersect: false
          }
        }
      });
    }
    
    function updateChart() {
      if (!chart) return;
      
      // Reset if going backwards (e.g., user clicked reset or moved timeline back)
      if (currentIndex < lastChartIndex) {
        lastChartIndex = -1;
        chart.data.labels = [];
        chart.data.datasets.forEach(dataset => {
          dataset.data = [];
        });
      }
      
      // Optimized O(n) incremental update - only add new data points
      if (currentIndex > lastChartIndex) {
        for (let i = lastChartIndex + 1; i <= currentIndex; i++) {
          chart.data.labels.push(i + 1);
          
          chart.data.datasets.forEach((dataset, idx) => {
            const lang = ALL_LANGUAGES[idx];
            const stats = DATA[i].languages[lang];
            dataset.data.push(stats ? stats.code : 0);
          });
        }
      }
      
      lastChartIndex = currentIndex;
      chart.update('none'); // No animation for smoother playback
    }

    // Audio sonification functions
    
    // Generate impulse response for convolution reverb
    function createReverbImpulse(sampleRate, decayTime, preDelay) {
      const preDelaySamples = Math.floor(preDelay * sampleRate);
      const decaySamples = Math.floor(decayTime * sampleRate);
      const totalLength = preDelaySamples + decaySamples;
      const impulse = audioCtx.createBuffer(2, totalLength, sampleRate);
      
      for (let channel = 0; channel < 2; channel++) {
        const channelData = impulse.getChannelData(channel);
        for (let i = 0; i < totalLength; i++) {
          if (i < preDelaySamples) {
            channelData[i] = 0;
          } else {
            const decayIndex = i - preDelaySamples;
            const decay = Math.exp(-3 * decayIndex / decaySamples);
            channelData[i] = (Math.random() * 2 - 1) * decay;
          }
        }
      }
      return impulse;
    }
    
    function initAudio() {
      if (audioCtx) {
        console.log('initAudio: Already initialized');
        return;
      }

      console.log('initAudio: Creating AudioContext...');
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      console.log('initAudio: AudioContext created, state=' + audioCtx.state + ', sampleRate=' + audioCtx.sampleRate);

      // Create master gain (final output)
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0;
      masterGain.connect(audioCtx.destination);
      console.log('initAudio: Master gain created and connected to destination');

      // Create reverb convolver
      reverb = audioCtx.createConvolver();
      reverb.buffer = createReverbImpulse(audioCtx.sampleRate, REVERB_DECAY, REVERB_PREDELAY);
      console.log('initAudio: Reverb created with buffer length=' + reverb.buffer.length);
      
      // Create wet/dry mix gains
      reverbWetGain = audioCtx.createGain();
      reverbWetGain.gain.value = REVERB_WET;
      reverbDryGain = audioCtx.createGain();
      reverbDryGain.gain.value = 1 - REVERB_WET;
      
      // Connect reverb to wet gain to master
      reverb.connect(reverbWetGain);
      reverbWetGain.connect(masterGain);
      
      // Connect dry gain directly to master
      reverbDryGain.connect(masterGain);
      console.log('initAudio: Reverb wet/dry paths connected');

      // Create shared lowpass filter - connects to both wet and dry paths
      filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = FILTER_CUTOFF;
      filter.Q.value = FILTER_Q_BASE;
      filter.connect(reverb);      // Wet path through reverb
      filter.connect(reverbDryGain); // Dry path bypasses reverb
      console.log('initAudio: Filter created at ' + FILTER_CUTOFF + 'Hz, Q=' + FILTER_Q_BASE);

      // Create voice pool (oscillator + individual gain per voice)
      // Assign frequencies from major scale: C, D, E, F, G, A, B, C, D, E...
      // Each language gets a stable voice assignment
      console.log('initAudio: Creating ' + MAX_VOICES + ' voices...');
      for (let i = 0; i < MAX_VOICES; i++) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.type = 'sine';  // Sine waves for smoother harmonic sound
        
        // Calculate frequency from major scale
        const octave = Math.floor(i / 7);
        const scaleStep = i % 7;
        const semitones = MAJOR_SCALE_SEMITONES[scaleStep] + (octave * 12);
        const frequency = C4 * Math.pow(2, semitones / 12);
        
        osc.frequency.value = frequency;
        // Detune each note by 0.3 to 1 cent for subtle chorusing
        osc.detune.value = 0.3 + (Math.random() * 0.7);
        gain.gain.value = 0;

        osc.connect(gain);
        gain.connect(filter);
        osc.start();

        voices.push({ osc, gain, lang: null });  // Track which language owns this voice
        
        if (i === 0 || i === MAX_VOICES - 1) {
          console.log('initAudio: Voice ' + i + ' frequency=' + frequency.toFixed(2) + 'Hz, detune=' + osc.detune.value.toFixed(2) + ' cents');
        }
      }
      console.log('initAudio: All ' + voices.length + ' voices created and started');
      
      // Assign each language to a voice based on its index in ALL_LANGUAGES
      // This gives each language a stable pitch throughout the animation
      ALL_LANGUAGES.forEach((lang, i) => {
        if (i < MAX_VOICES) {
          languageVoiceMap[lang] = i;
          voices[i].lang = lang;
        }
      });
      console.log('initAudio: Language-to-voice mapping complete. Mapped ' + Object.keys(languageVoiceMap).length + ' languages');
      console.log('initAudio: INITIALIZATION COMPLETE');
    }

    function updateAudio() {
      if (!audioCtx) return;

      const now = audioCtx.currentTime;
      const rampEnd = now + (RAMP_TIME_MS / 1000);
      const commit = DATA[currentIndex];

      // Calculate total lines for this commit
      let totalLines = 0;
      const languageData = {};
      ALL_LANGUAGES.forEach(lang => {
        const lines = commit.languages[lang]?.code || 0;
        languageData[lang] = lines;
        totalLines += lines;
      });

      console.log('updateAudio:', { currentIndex, totalLines, soundEnabled, voicesCount: voices.length });

      // Update each voice based on its assigned language's proportion at this commit
      ALL_LANGUAGES.forEach((lang, i) => {
        if (i >= MAX_VOICES) return;
        
        const voice = voices[i];
        const lines = languageData[lang];
        // Proportion is per-commit: this language's lines / total lines at this commit
        const proportion = totalLines > 0 ? lines / totalLines : 0;
        
        console.log('Voice ' + i + ' (' + lang + '): lines=' + lines + ', proportion=' + proportion.toFixed(3));
        
        // Voice frequency never changes - only gain modulates
        // This creates the THX-like effect where each tone independently fades in/out
        voice.gain.gain.linearRampToValueAtTime(proportion, rampEnd);
      });

      // Master gain with 20% volume variation based on total lines
      // Find min/max lines across all commits for scaling
      let minLines = Infinity, maxLines = 0;
      DATA.forEach(c => {
        const lines = Object.values(c.languages).reduce((sum, lang) => sum + (lang.code || 0), 0);
        minLines = Math.min(minLines, lines);
        maxLines = Math.max(maxLines, lines);
      });
      
      // Scale current total lines to 0.8-1.0 range (20% variation)
      const normalizedIntensity = maxLines > minLines 
        ? (totalLines - minLines) / (maxLines - minLines)
        : 1;
      const intensityScale = VOLUME_MIN + (normalizedIntensity * (VOLUME_MAX - VOLUME_MIN));
      
      const volume = elements.soundVolume.value / 100;
      
      // Master gain controls audibility
      const targetGain = soundEnabled ? intensityScale * volume * 0.5 : 0;
      console.log('Master gain: intensityScale=' + intensityScale.toFixed(3) + ', volume=' + volume.toFixed(2) + ', targetGain=' + targetGain.toFixed(3) + ', soundEnabled=' + soundEnabled);
      masterGain.gain.linearRampToValueAtTime(targetGain, rampEnd);
      
      // Filter Q still varies with intensity for brightness
      filter.Q.linearRampToValueAtTime(FILTER_Q_BASE + normalizedIntensity * FILTER_Q_MAX, rampEnd);
    }

    function resumeAudioContext() {
      if (!audioCtx) {
        console.log('resumeAudioContext: No audioCtx yet');
        return;
      }
      console.log('resumeAudioContext: AudioContext state=' + audioCtx.state);
      if (audioCtx.state === 'suspended') {
        console.log('resumeAudioContext: Resuming suspended context...');
        audioCtx.resume().then(() => {
          console.log('resumeAudioContext: Resumed! New state=' + audioCtx.state);
        });
      }
    }

    function toggleSound() {
      if (!AUDIO_SUPPORTED) {
        console.log('toggleSound: Audio not supported');
        return;
      }

      console.log('toggleSound: Called, current soundEnabled=' + soundEnabled);

      if (!audioCtx) {
        console.log('toggleSound: Initializing audio for first time...');
        initAudio();
      }

      soundEnabled = !soundEnabled;
      console.log('toggleSound: New soundEnabled=' + soundEnabled);

      // Update UI
      elements.soundToggle.classList.toggle('active', soundEnabled);
      elements.soundIconOff.style.display = soundEnabled ? 'none' : 'block';
      elements.soundIconOn.style.display = soundEnabled ? 'block' : 'none';

      // Resume audio context if needed (browser autoplay policy)
      if (soundEnabled) {
        resumeAudioContext();
      }
      
      // Update audio immediately to reflect new enabled state
      updateAudio();
    }

    function updateDisplay() {
      if (DATA.length === 0) {
        elements.tableBody.innerHTML = '<tr><td colspan="4" class="empty-state">No data available</td></tr>';
        return;
      }
      
      const frame = DATA[currentIndex];
      const prevFrame = currentIndex > 0 ? DATA[currentIndex - 1] : null;
      
      // Update commit info
      elements.date.textContent = frame.date;
      elements.hash.textContent = frame.commit.substring(0, 8);
      elements.number.textContent = \`Commit \${currentIndex + 1} of \${DATA.length}\`;
      
      // Update timeline
      const progress = ((currentIndex + 1) / DATA.length) * 100;
      elements.timeline.style.width = progress + '%';

      // Update audio sonification
      updateAudio();

      // Calculate total lines of code and files
      let totalLines = 0;
      let totalFiles = 0;
      for (const lang in frame.languages) {
        totalLines += frame.languages[lang].code;
        totalFiles += frame.languages[lang].files;
      }
      
      // Calculate previous totals
      let prevTotalLines = 0;
      let prevTotalFiles = 0;
      if (prevFrame) {
        for (const lang in prevFrame.languages) {
          prevTotalLines += prevFrame.languages[lang].code;
          prevTotalFiles += prevFrame.languages[lang].files;
        }
      }
      
      // Update summary stats
      elements.totalLines.textContent = formatNumber(totalLines);
      elements.totalFiles.textContent = formatNumber(totalFiles);
      
      if (prevFrame) {
        elements.totalDelta.innerHTML = formatDelta(totalLines, prevTotalLines);
        elements.filesDelta.innerHTML = formatDelta(totalFiles, prevTotalFiles);
      } else {
        elements.totalDelta.innerHTML = '';
        elements.filesDelta.innerHTML = '';
      }
      
      // Build rows for all languages (stable sort - already sorted by final commit)
      const rows = [];
      for (const lang of ALL_LANGUAGES) {
        const stats = frame.languages[lang];
        const prevStats = prevFrame ? prevFrame.languages[lang] : null;
        
        const lines = stats ? stats.code : 0;
        const files = stats ? stats.files : 0;
        const blank = stats ? stats.blank : 0;
        const comment = stats ? stats.comment : 0;
        const prevLines = prevStats ? prevStats.code : 0;
        const prevFiles = prevStats ? prevStats.files : 0;
        
        const percentage = totalLines > 0 ? (lines / totalLines) * 100 : 0;
        
        rows.push({
          lang,
          lines,
          files,
          blank,
          comment,
          prevLines,
          prevFiles,
          percentage,
          active: lines > 0
        });
      }
      
      // Languages are already in stable sort order (from ALL_LANGUAGES)
      // No need to sort - they maintain their final-commit-based order
      
      // Render table
      let html = '';
      for (const row of rows) {
        const linesDelta = prevFrame ? formatDelta(row.lines, row.prevLines) : '';
        const filesDelta = prevFrame ? formatDelta(row.files, row.prevFiles) : '';
        
        const rowClass = row.active ? '' : 'row-inactive';
        const secondaryInfo = row.active && (row.blank > 0 || row.comment > 0) 
          ? \`<span class="lines-secondary">\${formatNumber(row.blank)}b \${formatNumber(row.comment)}c</span>\`
          : '';
        
        html += \`
          <tr class="\${rowClass}">
            <td class="language-name" style="color: \${LANGUAGE_COLORS[row.lang]}">\${escapeHtml(row.lang)}</td>
            <td class="percentage-text">\${row.percentage.toFixed(1)}%</td>
            <td class="lines-count">
              \${formatNumber(row.lines)} \${linesDelta}
              \${secondaryInfo}
            </td>
            <td class="files-count">\${formatNumber(row.files)} \${filesDelta}</td>
          </tr>
        \`;
      }
      
      if (html === '') {
        html = '<tr><td colspan="4" class="empty-state">No code detected</td></tr>';
      }
      
      elements.tableBody.innerHTML = html;
      
      // Update chart
      updateChart();
    }
    
    function play() {
      if (isPlaying) return;
      isPlaying = true;
      elements.playPause.textContent = 'Pause';
      elements.playPause.classList.remove('primary');

      // Resume audio context if sound is enabled
      if (soundEnabled) {
        resumeAudioContext();
      }

      const effectiveDelay = Math.max(MIN_FRAME_DELAY, Math.floor(baseFrameDelay / speedMultiplier));
      animationInterval = setInterval(() => {
        currentIndex++;
        if (currentIndex >= DATA.length) {
          currentIndex = DATA.length - 1;
          pause();
        }
        updateDisplay();
      }, effectiveDelay);
    }

    function pause() {
      isPlaying = false;
      elements.playPause.textContent = 'Play';
      elements.playPause.classList.add('primary');
      if (animationInterval) {
        clearInterval(animationInterval);
        animationInterval = null;
      }
      // Audio continues running, oscillators stay alive
    }
    
    function next() {
      pause();
      currentIndex = Math.min(currentIndex + 1, DATA.length - 1);
      updateDisplay();
    }
    
    function prev() {
      pause();
      currentIndex = Math.max(currentIndex - 1, 0);
      updateDisplay();
    }
    
    function reset() {
      pause();
      currentIndex = 0;
      updateDisplay();
    }

    function goLatest() {
      pause();
      currentIndex = DATA.length - 1;
      updateDisplay();
    }

    // Event listeners
    elements.playPause.addEventListener('click', () => {
      if (isPlaying) pause();
      else play();
    });
    
    elements.next.addEventListener('click', next);
    elements.prev.addEventListener('click', prev);
    elements.reset.addEventListener('click', reset);
    elements.goLatest.addEventListener('click', goLatest);
    
    elements.speed.addEventListener('change', (e) => {
      speedMultiplier = parseFloat(e.target.value);
      if (isPlaying) {
        pause();
        play();
      }
    });

    // Sound controls
    if (AUDIO_SUPPORTED) {
      elements.soundToggle.addEventListener('click', toggleSound);
      elements.soundVolume.addEventListener('input', () => {
        // Update audio to reflect new volume
        if (audioCtx) {
          updateAudio();
        }
      });
    } else {
      // Hide sound controls if Web Audio not supported
      elements.soundControl.classList.add('hidden');
    }

    // Keyboard controls
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (isPlaying) pause();
        else play();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        next();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        prev();
      } else if (e.code === 'Home') {
        e.preventDefault();
        reset();
      } else if (e.code === 'End') {
        e.preventDefault();
        goLatest();
      }
    });

    // Timeline seek (click and drag)
    function seekToPosition(e) {
      const rect = elements.timelineBar.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const percent = x / rect.width;
      currentIndex = Math.round(percent * (DATA.length - 1));
      updateDisplay();
    }

    elements.timelineBar.addEventListener('click', (e) => {
      if (!isSeeking) {
        seekToPosition(e);
      }
    });

    elements.timelineBar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isSeeking = true;
      pause();
      seekToPosition(e);
    });

    document.addEventListener('mousemove', (e) => {
      if (isSeeking) {
        seekToPosition(e);
      }
    });

    document.addEventListener('mouseup', () => {
      isSeeking = false;
    });

    // Touch support for mobile
    elements.timelineBar.addEventListener('touchstart', (e) => {
      e.preventDefault();
      isSeeking = true;
      pause();
      const touch = e.touches[0];
      seekToPosition(touch);
    }, { passive: false });

    document.addEventListener('touchmove', (e) => {
      if (isSeeking) {
        const touch = e.touches[0];
        seekToPosition(touch);
      }
    });

    document.addEventListener('touchend', () => {
      isSeeking = false;
    });

    // Initialize
    initChart();
    updateDisplay();
  </script>
</body>
</html>`;

    span.setStatus('ok');
    span.end();
    return html;
  } catch (err) {
    span.setStatus('error', err.message);
    span.recordException(err);
    span.end();
    throw err;
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
📊 CLOC History Analyzer v${SCHEMA_VERSION}
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
  --local-repo      Path to already cloned repository (skips cloning)
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
  - output/data.json          Raw code count data for all commits (v2.0 format)
  - output/visualization.html Interactive HTML animation

Incremental Updates:
  If data.json exists, only new commits will be analyzed and appended.
  This makes updates very fast for repos with long histories.
`);
    process.exit(args.length === 0 ? 1 : 0);
  }
  
  // Parse arguments
  const repoUrl = args[0];
  let outputDir = './output';
  let forceFull = false;
  let localRepoPath = null;
  
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--force-full') {
      forceFull = true;
    } else if (args[i] === '--json-progress') {
      JSON_PROGRESS = true;
    } else if (args[i] === '--local-repo' && args[i + 1]) {
      localRepoPath = args[++i];
    } else if (args[i] === '--counter' && args[i + 1]) {
      const tool = args[++i].toLowerCase();
      if (tool === 'scc' || tool === 'cloc') {
        COUNTER_TOOL = tool;
      } else {
        console.error(`Error: Invalid counter tool '${tool}'. Use 'scc' or 'cloc'.`);
        process.exit(1);
      }
    } else if (!args[i].startsWith('--')) {
      outputDir = args[i];
    }
  }
  
  // Initialize OpenTelemetry tracing (if enabled via environment)
  const tracingEnabled = await initTracing();
  if (tracingEnabled && rootSpan) {
    rootSpan.setAttribute('analyzer.repository.url', repoUrl);
    rootSpan.setAttribute('analyzer.output_dir', outputDir);
    rootSpan.setAttribute('analyzer.force_full', forceFull);
    rootSpan.setAttribute('analyzer.local_repo', localRepoPath || 'none');
    rootSpan.setAttribute('analyzer.counter_tool', COUNTER_TOOL);
  }
  
  let success = false;
  
  emitProgress('validating', 0, 'Starting analysis...');
  
  if (!JSON_PROGRESS) {
    console.log(`📊 CLOC History Analyzer v${SCHEMA_VERSION}`);
    console.log('========================\n');
    console.log(`Repository: ${repoUrl}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Counter: ${COUNTER_TOOL}${COUNTER_TOOL === 'scc' ? ' (fast)' : ''}`);
    if (forceFull) {
      console.log('Mode: Full analysis (--force-full)');
    }
    if (tracingEnabled) {
      console.log('Tracing: enabled');
    }
    console.log();
  }
  
  // Create output directory
  exec(`mkdir -p "${outputDir}"`, { silent: true });
  
  // Try to load existing data
  let existingData = null;
  if (!forceFull) {
    existingData = loadExistingData(outputDir);
    if (existingData) {
      if (!JSON_PROGRESS) {
        console.log(`✓ Found existing data (${existingData.results.length} commits)`);
        console.log(`  Last analyzed: ${existingData.metadata.last_commit_date}`);
        console.log(`  Last commit: ${existingData.metadata.last_commit_hash.substring(0, 8)}`);
      }
      emitProgress('validating', 3, 'Found existing analysis data', {
        existing_commits: existingData.results.length
      });
    }
  }
  
  // Create temp directory for repo (or use local repo)
  let tempDir = null;
  let repoDir;
  let shouldCleanup = false;
  
  if (localRepoPath) {
    // Use existing local repository
    repoDir = localRepoPath;
    if (!JSON_PROGRESS) {
      console.log(`📂 Using local repository: ${localRepoPath}`);
    }
    emitProgress('validating', 5, 'Using local repository', { local_repo: localRepoPath });
  } else {
    // Clone repository to temp directory
    tempDir = mkdtempSync(join(tmpdir(), 'cloc-analysis-'));
    repoDir = join(tempDir, 'repo');
    shouldCleanup = true;
  }
  
  try {
    // Clone repository (only if not using local repo)
    if (!localRepoPath) {
      cloneRepo(repoUrl, repoDir);
    }
    
    // Get commits (incremental or full)
    let commits;
    if (existingData && existingData.metadata.last_commit_hash) {
      console.log('\n🔄 Incremental mode: checking for new commits...');
      commits = getCommitHistory(repoDir, 'main', existingData.metadata.last_commit_hash);
      
      if (commits.length === 0) {
        console.log('\n✅ Already up to date! No new commits to analyze.');
        console.log(`\nVisualization: ${join(outputDir, 'visualization.html')}`);
        success = true;
        return;
      }
      
      console.log(`📝 Found ${commits.length} new commits to analyze`);
    } else {
      commits = getCommitHistory(repoDir);
    }
    
    // Analyze commits (append to existing or start fresh)
    const existingResults = existingData ? existingData.results : [];
    const analysisData = analyzeCommits(repoDir, commits, existingResults);
    
    // Get counter info from first analyzed commit
    const counterInfo = analysisData.results.length > 0 
      ? {
          tool: analysisData.results[0].analysis.counter_tool || COUNTER_TOOL,
          version: analysisData.results[0].analysis.counter_version || 'unknown'
        }
      : { tool: COUNTER_TOOL, version: 'unknown' };
    
    // Create data structure with metadata
    const data = createDataStructure(
      repoUrl,
      analysisData.results,
      analysisData.allLanguages,
      analysisData.analysisTime,
      counterInfo
    );
    
    // Save data
    emitProgress('generating', 90, 'Saving analysis data...');
    const dataFile = join(outputDir, 'data.json');
    writeFileSync(dataFile, JSON.stringify(data, null, 2));
    if (!JSON_PROGRESS) {
      console.log(`\n💾 Data saved: ${dataFile}`);
      console.log(`   Schema version: ${data.schema_version}`);
      console.log(`   Total commits: ${data.results.length}`);
      console.log(`   Languages: ${data.allLanguages.length}`);
    }
    
    // Generate HTML
    emitProgress('generating', 95, 'Generating HTML visualization...');
    const html = generateHTML(data, repoUrl);
    const htmlFile = join(outputDir, 'visualization.html');
    writeFileSync(htmlFile, html);
    if (!JSON_PROGRESS) {
      console.log(`🎨 Visualization generated: ${htmlFile}`);
    }
    
    // Update root span with final metrics
    if (rootSpan) {
      rootSpan.setAttribute('analyzer.total_commits', data.results.length);
      rootSpan.setAttribute('analyzer.languages_count', data.allLanguages.length);
      rootSpan.setAttribute('analyzer.duration_seconds', analysisData.analysisTime);
    }
    
    emitProgress('complete', 100, 'Analysis complete!', {
      total_commits: data.results.length,
      languages: data.allLanguages.length,
      output_dir: outputDir
    });
    
    if (!JSON_PROGRESS) {
      console.log('\n✅ Analysis complete!');
      console.log(`\nOpen ${htmlFile} in a browser to view the animation.`);
    }
    
    success = true;
    
  } catch (error) {
    if (!JSON_PROGRESS) {
      console.error('\n❌ Error:', error.message);
    }
    emitProgress('failed', 0, `Analysis failed: ${error.message}`, {
      error: error.message,
      stack: error.stack
    });
    
    // Record error on root span
    if (rootSpan && otelApi) {
      rootSpan.recordException(error);
    }
    
    process.exit(1);
  } finally {
    // Cleanup (only if we created a temp directory)
    if (shouldCleanup && tempDir) {
      if (!JSON_PROGRESS) {
        console.log('\n🧹 Cleaning up temporary files...');
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
    
    // Shutdown tracing and flush spans
    await shutdownTracing(success);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
