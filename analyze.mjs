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

const FRAME_DELAY_MS = 200;
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
    // Try main first, fall back to master
    const branches = exec(`git -C "${repoDir}" branch -r`, { silent: true });
    const hasMain = branches.includes('origin/main');
    const hasMaster = branches.includes('origin/master');
    
    let actualBranch = branch;
    if (branch === 'main' && !hasMain && hasMaster) {
      actualBranch = 'master';
      if (!JSON_PROGRESS) {
        console.log('  (using master branch instead)');
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

function runCloc(repoDir) {
  try {
    const result = exec(
      `cloc "${repoDir}" --json --quiet --exclude-dir=node_modules,.git,dist,build,target,pkg,.venv,venv,__pycache__,.pytest_cache,.mypy_cache,vendor`,
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
          lines_per_second: 0
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
      cloc_version: header.cloc_version || 'unknown'
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
        cloc_version: 'unknown'
      }
    };
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
      
      // Run cloc
      const clocData = runCloc(repoDir);
      
      // Track all languages we've seen
      Object.keys(clocData.languages).forEach(lang => allLanguages.add(lang));
      
      results.push({
        commit: commit.hash,
        date: commit.date,
        message: commit.message,
        analysis: clocData.analysis,
        languages: clocData.languages
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
function createDataStructure(repoUrl, results, allLanguages, analysisTime, clocVersion) {
  const lastCommit = results.length > 0 ? results[results.length - 1] : null;
  
  return {
    schema_version: SCHEMA_VERSION,
    metadata: {
      repository_url: repoUrl,
      analyzed_at: new Date().toISOString(),
      total_commits: results.length,
      total_duration_seconds: analysisTime,
      cloc_version: clocVersion || 'unknown',
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
      height: 6px;
      background: var(--bg-tertiary);
      border-radius: 3px;
      overflow: hidden;
    }

    .timeline-progress {
      height: 100%;
      background: linear-gradient(90deg, var(--accent-cyan) 0%, var(--accent-purple) 100%);
      border-radius: 3px;
      transition: width 0.2s var(--ease-out);
      position: relative;
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
              <option value="500">0.5x</option>
              <option value="200" selected>1x</option>
              <option value="100">2x</option>
              <option value="50">4x</option>
            </select>
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
    let frameDelay = ${FRAME_DELAY_MS};
    let chart = null;

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
      
      // Update data up to current index
      const labels = [];
      const dataByLanguage = {};
      
      ALL_LANGUAGES.forEach(lang => {
        dataByLanguage[lang] = [];
      });
      
      for (let i = 0; i <= currentIndex; i++) {
        labels.push(i + 1);
        
        ALL_LANGUAGES.forEach(lang => {
          const stats = DATA[i].languages[lang];
          dataByLanguage[lang].push(stats ? stats.code : 0);
        });
      }
      
      chart.data.labels = labels;
      chart.data.datasets.forEach((dataset, idx) => {
        dataset.data = dataByLanguage[ALL_LANGUAGES[idx]];
      });
      
      chart.update('none'); // No animation for smoother playback
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

      animationInterval = setInterval(() => {
        currentIndex++;
        if (currentIndex >= DATA.length) {
          currentIndex = DATA.length - 1;
          pause();
        }
        updateDisplay();
      }, frameDelay);
    }

    function pause() {
      isPlaying = false;
      elements.playPause.textContent = 'Play';
      elements.playPause.classList.add('primary');
      if (animationInterval) {
        clearInterval(animationInterval);
        animationInterval = null;
      }
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
      frameDelay = parseInt(e.target.value);
      if (isPlaying) {
        pause();
        play();
      }
    });
    
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

Analyzes code evolution over time by running cloc on every commit.
Supports incremental updates - only analyzes new commits on subsequent runs.

Usage:
  node analyze.mjs <git-repo-url> [output-dir] [--force-full] [--json-progress] [--local-repo <path>]

Arguments:
  git-repo-url      URL of the git repository to analyze (used for metadata)
  output-dir        Output directory (default: ./output)
  --force-full      Force full analysis, ignore existing data
  --json-progress   Output progress as JSONL to stderr for machine parsing
  --local-repo      Path to already cloned repository (skips cloning)

Environment Variables (for distributed tracing):
  OTEL_TRACING_ENABLED        Set to 'true' to enable OpenTelemetry tracing
  OTEL_EXPORTER_OTLP_ENDPOINT OTLP endpoint URL (e.g., http://tempo:4318)
  OTEL_TRACE_PARENT           W3C traceparent for trace context propagation

Example:
  node analyze.mjs https://github.com/user/repo
  node analyze.mjs https://github.com/user/repo ./my-output
  node analyze.mjs https://github.com/user/repo ./output --force-full
  node analyze.mjs https://github.com/user/repo ./output --json-progress
  node analyze.mjs https://github.com/user/repo ./output --local-repo /tmp/cloned-repo

Output:
  - output/data.json          Raw cloc data for all commits (v2.0 format)
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
  }
  
  let success = false;
  
  emitProgress('validating', 0, 'Starting analysis...');
  
  if (!JSON_PROGRESS) {
    console.log(`📊 CLOC History Analyzer v${SCHEMA_VERSION}`);
    console.log('========================\n');
    console.log(`Repository: ${repoUrl}`);
    console.log(`Output: ${outputDir}`);
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
    
    // Get cloc version from first analyzed commit
    const clocVersion = analysisData.results.length > 0 
      ? analysisData.results[0].analysis.cloc_version
      : 'unknown';
    
    // Create data structure with metadata
    const data = createDataStructure(
      repoUrl,
      analysisData.results,
      analysisData.allLanguages,
      analysisData.analysisTime,
      clocVersion
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
