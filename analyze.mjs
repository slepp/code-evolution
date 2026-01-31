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

const SCHEMA_VERSION = '2.2';  // Added pre-computed totals per commit

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

// Audio sonification constants (used for pre-computing audio data)
const AUDIO_MAX_VOICES = 16;           // Max languages with audio
const AUDIO_DETUNE_MAX = 25;           // Max pitch variation in cents (+/- 25)

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
      
      // Pre-compute totals for visualization performance
      let totalLines = 0;
      let totalFiles = 0;
      let totalBytes = 0;
      for (const lang in counterData.languages) {
        totalLines += counterData.languages[lang].code || 0;
        totalFiles += counterData.languages[lang].files || 0;
        totalBytes += counterData.languages[lang].bytes || 0;
      }

      results.push({
        commit: commit.hash,
        date: commit.date,
        message: commit.message,
        analysis: counterData.analysis,
        languages: counterData.languages,
        totalLines,
        totalFiles,
        totalBytes
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
 * Compute pre-baked audio data for all commits and all metrics.
 * This moves audio state calculation from browser runtime to build time.
 *
 * Optimized sparse format for each metric:
 * [masterIntensity, [langIndex, gain, detune], [langIndex, gain, detune], ...]
 * - Only non-zero gain voices are included (sparse)
 * - Array-based format reduces JSON overhead
 * - Gains rounded to 2 decimals, detune to 1 decimal
 *
 * @param {Array} results - Analysis results array
 * @param {Array} allLanguages - Sorted language list (determines voice assignment)
 * @returns {Array} Audio data array, one entry per commit
 */
function computeAudioData(results, allLanguages) {
  if (results.length === 0) return [];

  const metrics = ['lines', 'files', 'bytes'];
  const metricKeys = { lines: 'code', files: 'files', bytes: 'bytes' };

  // Find global min/max for each metric (for intensity normalization)
  const minMax = {};
  for (const metric of metrics) {
    let min = Infinity, max = 0;
    for (const commit of results) {
      let total = 0;
      for (const lang in commit.languages) {
        total += commit.languages[lang][metricKeys[metric]] || 0;
      }
      min = Math.min(min, total);
      max = Math.max(max, total);
    }
    minMax[metric] = { min, max };
  }

  const audioData = [];
  const maxVoices = Math.min(allLanguages.length, AUDIO_MAX_VOICES);

  for (let i = 0; i < results.length; i++) {
    const commit = results[i];
    const prevCommit = i > 0 ? results[i - 1] : null;

    const frameData = {};

    for (const metric of metrics) {
      const key = metricKeys[metric];
      const { min, max } = minMax[metric];

      // Calculate total for this commit
      let total = 0;
      for (const lang in commit.languages) {
        total += commit.languages[lang][key] || 0;
      }

      // Compute normalized intensity (0-1), rounded to 2 decimals
      const masterIntensity = max > min
        ? Math.round(((total - min) / (max - min)) * 100) / 100
        : 1;

      // Compute voice data - sparse array format [langIndex, gain, detune]
      const activeVoices = [];

      for (let v = 0; v < maxVoices; v++) {
        const lang = allLanguages[v];
        const value = commit.languages[lang]?.[key] || 0;
        const prevValue = prevCommit?.languages[lang]?.[key] || 0;

        // Gain is proportion of total (0-1)
        const gain = total > 0 ? value / total : 0;

        // Skip zero-gain voices (sparse optimization)
        if (gain === 0) continue;

        // Detune based on growth trend (+/- AUDIO_DETUNE_MAX cents)
        let detune = 0;
        if (prevCommit && prevValue > 0) {
          const growthRate = (value - prevValue) / prevValue;
          detune = Math.max(-AUDIO_DETUNE_MAX, Math.min(AUDIO_DETUNE_MAX, growthRate * AUDIO_DETUNE_MAX));
        } else if (value > 0 && prevValue === 0) {
          detune = AUDIO_DETUNE_MAX * 0.5;
        }

        // Store as [langIndex, gain (2 decimals), detune (1 decimal)]
        activeVoices.push([v, Math.round(gain * 100) / 100, Math.round(detune * 10) / 10]);
      }

      // Format: [masterIntensity, ...activeVoices]
      frameData[metric] = [masterIntensity, ...activeVoices];
    }

    audioData.push(frameData);
  }

  return audioData;
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
  
  // Compute pre-baked audio data for all commits
  const audioData = computeAudioData(results, allLanguages);
  
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
    allLanguages: allLanguages,
    audioData: audioData  // Pre-computed audio state per commit
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
  <!-- Chart.js removed - using custom high-performance Canvas renderer -->
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
      width: 100%;
      height: calc(100% - 32px);
    }

    .chart-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1rem;
      padding: 0.5rem 0 0;
      justify-content: center;
    }

    .chart-legend-item {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-family: var(--font-mono);
      font-size: 0.6rem;
      color: var(--text-secondary);
      cursor: default;
      transition: opacity 0.15s;
    }

    .chart-legend-item:hover {
      opacity: 0.7;
    }

    .chart-legend-item.inactive {
      opacity: 0.3;
    }

    .chart-legend-color {
      width: 8px;
      height: 8px;
      border-radius: 2px;
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
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .language-color {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex-shrink: 0;
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
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .controls-row {
      display: flex;
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

    .controls-options {
      gap: 1rem;
    }

    .audio-tip {
      font-size: 0.65rem;
      font-family: var(--font-mono);
      color: var(--text-tertiary);
      opacity: 0.6;
    }

    .audio-tip kbd {
      display: inline-block;
      padding: 0.1rem 0.35rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-default);
      border-radius: 3px;
      font-size: 0.6rem;
      font-weight: 600;
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

    .metric-control {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      margin-left: 0.5rem;
      padding-left: 0.5rem;
      border-left: 1px solid var(--border-default);
    }

    .metric-control label {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .metric-control select {
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

    .audio-controls {
      display: flex;
      gap: 1rem;
      margin-top: 0.5rem;
      padding: 0.75rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 0.7rem;
    }

    .audio-controls.hidden {
      display: none;
    }

    .audio-control-group {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      flex: 1;
    }

    .audio-control-group label {
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 0.65rem;
    }

    .audio-control-group input[type="range"] {
      width: 100%;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: var(--bg-tertiary);
      border-radius: 2px;
      cursor: pointer;
    }

    .audio-control-group input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      background: var(--accent-purple);
      border-radius: 50%;
      cursor: pointer;
    }

    .audio-control-group input[type="range"]::-moz-range-thumb {
      width: 12px;
      height: 12px;
      background: var(--accent-purple);
      border-radius: 50%;
      cursor: pointer;
      border: none;
    }

    .audio-control-group select {
      padding: 0.35rem 0.5rem;
      border: 1px solid var(--border-default);
      border-radius: 4px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 0.7rem;
      cursor: pointer;
    }

    .audio-control-value {
      color: var(--text-secondary);
      font-size: 0.65rem;
      margin-top: 0.2rem;
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
          <div class="controls-row">
            <div class="controls-primary">
              <button id="play-pause" class="primary">Play</button>
              <button id="go-latest" class="primary">Latest</button>
            </div>
            <div class="controls-secondary">
              <button id="prev" class="secondary">Prev</button>
              <button id="next" class="secondary">Next</button>
              <button id="reset" class="secondary">Reset</button>
            </div>
          </div>
          <div class="audio-tip" id="audio-tip">Press <kbd>space</kbd> to play · <kbd>S</kbd> to toggle sound</div>
          <div class="controls-row controls-options">
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
            <div class="speed-control">
              <label>Speed</label>
              <select id="speed">
                <option value="0.5">0.5x</option>
                <option value="1" selected>1x</option>
                <option value="2">2x</option>
                <option value="4">4x</option>
              </select>
            </div>
            <div class="metric-control">
              <label>Metric</label>
              <select id="metric">
                <option value="lines" selected>Lines</option>
                <option value="files">Files</option>
                <option value="bytes">Bytes</option>
              </select>
            </div>
          </div>
        </div>

        <div class="timeline">
          <div class="timeline-bar">
            <div class="timeline-progress" id="timeline-progress"></div>
          </div>
        </div>

        <div class="audio-controls" id="audio-controls">
          <div class="audio-control-group">
            <label>Gain Curve <span class="audio-control-value" id="gain-curve-value">0.4</span></label>
            <input type="range" id="gain-curve" min="0.2" max="1.0" step="0.05" value="0.4">
          </div>
          <div class="audio-control-group">
            <label>Intensity Curve</label>
            <select id="intensity-curve">
              <option value="log" selected>Logarithmic (recommended)</option>
              <option value="linear">Linear</option>
              <option value="exp">Exponential</option>
            </select>
          </div>
          <div class="audio-control-group">
            <label>Stereo Width <span class="audio-control-value" id="stereo-width-value">70%</span></label>
            <input type="range" id="stereo-width" min="0" max="100" step="5" value="70">
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
            <div class="chart-legend" id="chart-legend"></div>
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
    const AUDIO_DATA = ${JSON.stringify(data.audioData || [])};  // Pre-computed audio state

    let currentIndex = 0;
    let isPlaying = false;
    let animationInterval = null;
    // Chart.js removed - using custom Canvas renderer for performance
    let isSeeking = false; // Track if user is dragging timeline

    // Dynamic frame delay: 20 second max playback at 1x, max 500ms per frame, min 50ms
    const TARGET_DURATION_MS = 20000;
    const MAX_FRAME_DELAY = 500;
    const MIN_FRAME_DELAY = 50;
    const baseFrameDelay = Math.min(MAX_FRAME_DELAY, Math.max(MIN_FRAME_DELAY, Math.floor(TARGET_DURATION_MS / DATA.length)));
    let speedMultiplier = 1;

    // Audio sonification
    const AUDIO_SUPPORTED = !!(window.AudioContext || window.webkitAudioContext);

    const FILTER_CUTOFF = 2500;        // Hz - saw brightness cap
    const FILTER_Q_BASE = 1;           // Resonance minimum
    const FILTER_Q_MAX = 8;            // Resonance at max intensity
    const RAMP_TIME_MS = 50;           // Smooth parameter transitions
    const MAX_VOICES = 16;             // Limit oscillators (matches color palette)
    const VOLUME_MIN = 0.2;            // Minimum volume scaling (20%)
    const VOLUME_MAX = 1.0;            // Maximum volume scaling (100%)
    const REVERB_DECAY = 1.5;          // Reverb decay time in seconds
    const REVERB_PREDELAY = 0.02;      // Reverb predelay in seconds
    const REVERB_WET = 0.15;           // Reverb wet mix (0-1)
    const FADE_OUT_TIME_MS = 500;      // Time to fade out audio at end

    // === UNIFIED TIMING SYSTEM ===
    // Everything syncs to beats for musical coherence
    // Base tempo: 60 BPM = 1 beat per second (scales with playback speed)
    const BASE_BPM = 60;
    const BEATS_PER_BAR = 4;                     // 4/4 time signature
    const BARS_PER_CHORD = 1;                    // Chord changes every bar
    const BEATS_PER_CHORD = BEATS_PER_BAR * BARS_PER_CHORD;  // 4 beats per chord
    const CHORD_GLIDE_TIME_MS = 75;              // Quick 75ms glide between chords

    // Drum volumes
    const KICK_VOLUME = 0.16;                    // Bass drum - needs to be audible
    const SNARE_VOLUME = 0.10;                   // Snare - gentle texture
    const HIHAT_VOLUME = 0.06;                   // Hihat - light texture for fast speeds

    // Cymbal crash: triggered on major code changes
    const CYMBAL_VOLUME = 0.072;                 // Light cymbal - texture only
    const CYMBAL_THRESHOLD = 0.15;               // 15% change triggers cymbal

    // I-V-vi-IV progression frequencies (C-G-Am-F)
    // Each chord has 16 frequencies spanning ~3 octaves for rich harmonic texture
    const CHORD_PROGRESSION = [
      // I - C Major (C-E-G): warm, stable home chord
      [
        130.81,  // C3  - root
        164.81,  // E3  - major 3rd
        196.00,  // G3  - perfect 5th
        261.63,  // C4  - root (octave)
        329.63,  // E4  - major 3rd
        392.00,  // G4  - perfect 5th
        523.25,  // C5  - root (2 octaves)
        659.25,  // E5  - major 3rd (high)
        196.00,  // G3  - 5th (doubled)
        261.63,  // C4  - root (doubled)
        329.63,  // E4  - 3rd (doubled)
        392.00,  // G4  - 5th (doubled)
        440.00,  // A4  - added 6th (color)
        493.88,  // B4  - major 7th (color)
        349.23,  // F4  - sus4 color
        293.66   // D4  - added 9th (color)
      ],
      // V - G Major (G-B-D): bright, uplifting dominant
      [
        196.00,  // G3  - root
        246.94,  // B3  - major 3rd
        293.66,  // D4  - perfect 5th
        392.00,  // G4  - root (octave)
        493.88,  // B4  - major 3rd
        587.33,  // D5  - perfect 5th
        783.99,  // G5  - root (2 octaves)
        987.77,  // B5  - major 3rd (high)
        293.66,  // D4  - 5th (doubled)
        392.00,  // G4  - root (doubled)
        493.88,  // B4  - 3rd (doubled)
        587.33,  // D5  - 5th (doubled)
        659.25,  // E5  - added 6th (color)
        739.99,  // F#5 - major 7th (color)
        523.25,  // C5  - sus4 color
        440.00   // A4  - added 9th (color)
      ],
      // vi - A Minor (A-C-E): melancholic, introspective relative minor
      [
        220.00,  // A3  - root
        261.63,  // C4  - minor 3rd
        329.63,  // E4  - perfect 5th
        440.00,  // A4  - root (octave)
        523.25,  // C5  - minor 3rd
        659.25,  // E5  - perfect 5th
        880.00,  // A5  - root (2 octaves)
        1046.50, // C6  - minor 3rd (high)
        329.63,  // E4  - 5th (doubled)
        440.00,  // A4  - root (doubled)
        523.25,  // C5  - 3rd (doubled)
        659.25,  // E5  - 5th (doubled)
        739.99,  // F#5 - added 6th (dorian color)
        783.99,  // G5  - minor 7th (color)
        587.33,  // D5  - sus4 color
        493.88   // B4  - added 9th (color)
      ],
      // IV - F Major (F-A-C): warm, subdominant resolution
      [
        174.61,  // F3  - root
        220.00,  // A3  - major 3rd
        261.63,  // C4  - perfect 5th
        349.23,  // F4  - root (octave)
        440.00,  // A4  - major 3rd
        523.25,  // C5  - perfect 5th
        698.46,  // F5  - root (2 octaves)
        880.00,  // A5  - major 3rd (high)
        261.63,  // C4  - 5th (doubled)
        349.23,  // F4  - root (doubled)
        440.00,  // A4  - 3rd (doubled)
        523.25,  // C5  - 5th (doubled)
        587.33,  // D5  - added 6th (color)
        659.25,  // E5  - major 7th (color)
        466.16,  // Bb4 - sus4 color
        392.00   // G4  - added 9th (color)
      ]
    ];

    let audioCtx = null;
    let soundEnabled = false;
    let masterGain = null;
    let filter = null;
    let reverb = null;
    let reverbWetGain = null;
    let reverbDryGain = null;
    let voices = [];
    let languageVoiceMap = {};  // Map language name to voice index (stable assignment)
    let isFadingOut = false;    // Track if we're fading out audio

    // Unified timing state (all synced to beats)
    let playbackStartTime = null;   // performance.now() when playback started
    let totalBeatsElapsed = 0;      // Total beats since playback started
    let currentBeat = 0;            // Current beat in bar (0-3)
    let currentChordIndex = 0;      // Which chord in progression
    let lastScheduledBeat = -1;     // Last beat we scheduled audio for
    let animationFrameId = null;    // requestAnimationFrame ID for visual updates
    let audioSchedulerInterval = null; // setInterval ID for audio (runs even when hidden)
    let lastFrameTime = 0;          // Last frame timestamp for delta calculation
    let accumulatedTime = 0;        // Accumulated time for frame advancement
    let lastVisualUpdateTime = 0;   // Track last visual update for throttling

    // Cymbal state
    let lastCymbalBeat = -1;        // Last beat a cymbal was triggered
    let lastFrameTotal = 0;         // Track previous frame total for change detection

    // Pre-created noise buffers for drum sounds (avoids GC pressure)
    let snareNoiseBuffer = null;
    let hihatNoiseBuffer = null;
    let cymbalNoiseBuffer = null;

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
      metric: document.getElementById('metric'),
      totalLines: document.getElementById('total-lines'),
      totalDelta: document.getElementById('total-delta'),
      totalFiles: document.getElementById('total-files'),
      filesDelta: document.getElementById('files-delta'),
      summaryStats: document.getElementById('summary-stats'),
      audioControls: document.getElementById('audio-controls'),
      gainCurve: document.getElementById('gain-curve'),
      gainCurveValue: document.getElementById('gain-curve-value'),
      intensityCurve: document.getElementById('intensity-curve'),
      stereoWidth: document.getElementById('stereo-width'),
      stereoWidthValue: document.getElementById('stereo-width-value')
    };

    // Current metric: 'lines', 'files', or 'bytes'
    let currentMetric = 'lines';

    // Audio enhancement settings
    let audioSettings = {
      gainCurvePower: 0.4,      // Power curve for gain (lower = more boost for quiet languages)
      intensityCurve: 'log',     // 'linear', 'log', or 'exp'
      stereoWidth: 0.7           // 0-1, how much to spread voices in stereo field
    };
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function formatNumber(num) {
      return num.toLocaleString();
    }

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function formatMetricValue(value, metric) {
      if (metric === 'bytes') return formatBytes(value);
      return formatNumber(value);
    }

    function formatMetricDelta(current, previous, metric) {
      if (previous === undefined || previous === null) return '';
      const delta = current - previous;
      if (delta === 0) {
        return '<span class="delta delta-neutral">±0</span>';
      } else if (delta > 0) {
        const formatted = metric === 'bytes' ? formatBytes(delta) : formatNumber(delta);
        return \`<span class="delta delta-positive">+\${formatted}</span>\`;
      } else {
        const formatted = metric === 'bytes' ? formatBytes(Math.abs(delta)) : formatNumber(delta);
        return \`<span class="delta delta-negative">\${metric === 'bytes' ? '-' + formatted : formatted}</span>\`;
      }
    }

    // Get metric value from language stats
    function getMetricValue(stats, metric) {
      if (!stats) return 0;
      switch (metric) {
        case 'lines': return stats.code || 0;
        case 'files': return stats.files || 0;
        case 'bytes': return stats.bytes || 0;
        default: return stats.code || 0;
      }
    }

    // Get total metric from frame
    function getFrameTotal(frame, metric) {
      switch (metric) {
        case 'lines': return frame.totalLines || 0;
        case 'files': return frame.totalFiles || 0;
        case 'bytes': return frame.totalBytes || 0;
        default: return frame.totalLines || 0;
      }
    }

    // Get metric label for display
    function getMetricLabel(metric) {
      switch (metric) {
        case 'lines': return 'Lines';
        case 'files': return 'Files';
        case 'bytes': return 'Bytes';
        default: return 'Lines';
      }
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

    // Table DOM cache for efficient updates (DOM diffing)
    const tableRowCache = [];

    function initTable() {
      // Create table rows once, store references to updateable cells
      elements.tableBody.innerHTML = '';

      for (let i = 0; i < ALL_LANGUAGES.length; i++) {
        const lang = ALL_LANGUAGES[i];
        const tr = document.createElement('tr');

        // Language name cell (static after init) with color indicator
        const tdLang = document.createElement('td');
        tdLang.className = 'language-name';
        const colorDot = document.createElement('span');
        colorDot.className = 'language-color';
        colorDot.style.backgroundColor = LANGUAGE_COLORS[lang];
        tdLang.appendChild(colorDot);
        const langText = document.createElement('span');
        langText.style.color = LANGUAGE_COLORS[lang];
        langText.textContent = lang;
        tdLang.appendChild(langText);
        tr.appendChild(tdLang);

        // Percentage cell
        const tdPercent = document.createElement('td');
        tdPercent.className = 'percentage-text';
        tr.appendChild(tdPercent);

        // Lines count cell (with delta and secondary info)
        const tdLines = document.createElement('td');
        tdLines.className = 'lines-count';
        const linesMain = document.createElement('span');
        const linesDelta = document.createElement('span');
        const linesSecondary = document.createElement('span');
        linesSecondary.className = 'lines-secondary';
        tdLines.appendChild(linesMain);
        tdLines.appendChild(document.createTextNode(' '));
        tdLines.appendChild(linesDelta);
        tdLines.appendChild(document.createTextNode(' '));
        tdLines.appendChild(linesSecondary);
        tr.appendChild(tdLines);

        // Files count cell (with delta)
        const tdFiles = document.createElement('td');
        tdFiles.className = 'files-count';
        const filesMain = document.createElement('span');
        const filesDelta = document.createElement('span');
        tdFiles.appendChild(filesMain);
        tdFiles.appendChild(document.createTextNode(' '));
        tdFiles.appendChild(filesDelta);
        tr.appendChild(tdFiles);

        elements.tableBody.appendChild(tr);

        // Cache references for fast updates
        tableRowCache.push({
          row: tr,
          lang,
          percent: tdPercent,
          linesMain,
          linesDelta,
          linesSecondary,
          filesMain,
          filesDelta,
          lastMetric: null,  // Track which metric was last rendered
          // Track previous values to skip unchanged updates
          prevValues: { metricValue: -1, files: -1, percentage: -1, blank: -1, comment: -1 }
        });
      }
    }

    // High-performance custom Canvas chart (replaces Chart.js for 30fps streaming)
    let chartCanvas = null;
    let chartCtx = null;
    let chartWidth = 0;
    let chartHeight = 0;
    const CHART_PADDING = { top: 40, right: 20, bottom: 40, left: 60 };
    const MAX_RENDER_POINTS = 800; // Max points to render (decimation threshold)

    function initChart() {
      chartCanvas = document.getElementById('chart-canvas');
      chartCtx = chartCanvas.getContext('2d');

      // Handle high-DPI displays
      const dpr = window.devicePixelRatio || 1;
      const rect = chartCanvas.getBoundingClientRect();
      chartWidth = rect.width;
      chartHeight = rect.height;
      chartCanvas.width = chartWidth * dpr;
      chartCanvas.height = chartHeight * dpr;
      chartCtx.scale(dpr, dpr);

      // Handle resize
      const resizeObserver = new ResizeObserver(entries => {
        const rect = chartCanvas.getBoundingClientRect();
        chartWidth = rect.width;
        chartHeight = rect.height;
        const dpr = window.devicePixelRatio || 1;
        chartCanvas.width = chartWidth * dpr;
        chartCanvas.height = chartHeight * dpr;
        chartCtx.setTransform(1, 0, 0, 1, 0, 0);
        chartCtx.scale(dpr, dpr);
        renderChart();
      });
      resizeObserver.observe(chartCanvas);

      // Initial render
      renderChart();

      // Initialize chart legend
      initChartLegend();
    }

    function initChartLegend() {
      const legend = document.getElementById('chart-legend');
      if (!legend) return;

      legend.innerHTML = '';

      // Show only active languages in legend (sorted by current value)
      const frame = DATA[DATA.length - 1];
      const langsWithValues = ALL_LANGUAGES
        .map(lang => ({
          lang,
          value: getMetricValue(frame.languages[lang], 'lines'),
          color: LANGUAGE_COLORS[lang]
        }))
        .filter(l => l.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 8); // Show top 8 in legend

      for (const { lang, color } of langsWithValues) {
        const item = document.createElement('div');
        item.className = 'chart-legend-item';
        item.innerHTML = \`<span class="chart-legend-color" style="background:\${color}"></span>\${lang}\`;
        legend.appendChild(item);
      }
    }

    function formatAxisValue(value) {
      if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
      if (value >= 1000) return (value / 1000).toFixed(0) + 'k';
      return value.toString();
    }

    function renderChart() {
      if (!chartCtx || currentIndex < 0) return;

      const ctx = chartCtx;
      const w = chartWidth;
      const h = chartHeight;
      const plotLeft = CHART_PADDING.left;
      const plotTop = CHART_PADDING.top;
      const plotWidth = w - CHART_PADDING.left - CHART_PADDING.right;
      const plotHeight = h - CHART_PADDING.top - CHART_PADDING.bottom;

      // Clear canvas
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, w, h);

      // Find data range and max value across all languages
      const endIdx = currentIndex;
      const startIdx = 0;
      let maxValue = 0;

      for (let i = startIdx; i <= endIdx; i++) {
        const frame = DATA[i];
        for (const lang of ALL_LANGUAGES) {
          const val = getMetricValue(frame.languages[lang], currentMetric);
          if (val > maxValue) maxValue = val;
        }
      }

      // Add 10% headroom
      maxValue = maxValue * 1.1 || 100;

      // Calculate decimation step
      const totalPoints = endIdx - startIdx + 1;
      const step = Math.max(1, Math.ceil(totalPoints / MAX_RENDER_POINTS));

      // Draw grid lines
      ctx.strokeStyle = '#21262d';
      ctx.lineWidth = 1;

      // Y-axis grid (5 lines)
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.fillStyle = '#6e7681';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      for (let i = 0; i <= 5; i++) {
        const y = plotTop + plotHeight - (i / 5) * plotHeight;
        const value = (i / 5) * maxValue;

        ctx.beginPath();
        ctx.moveTo(plotLeft, y);
        ctx.lineTo(plotLeft + plotWidth, y);
        ctx.stroke();

        ctx.fillText(formatAxisValue(Math.round(value)), plotLeft - 8, y);
      }

      // X-axis labels (5-7 labels)
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xLabelCount = Math.min(7, totalPoints);
      const xLabelStep = Math.max(1, Math.floor(totalPoints / xLabelCount));

      for (let i = 0; i <= totalPoints; i += xLabelStep) {
        if (i > endIdx) break;
        const x = plotLeft + (i / Math.max(1, endIdx)) * plotWidth;
        ctx.fillText((i + 1).toString(), x, plotTop + plotHeight + 8);
      }

      // Axis labels
      ctx.fillStyle = '#6e7681';
      ctx.font = "bold 9px 'JetBrains Mono', monospace";

      // X-axis title
      ctx.textAlign = 'center';
      ctx.fillText('COMMIT', plotLeft + plotWidth / 2, h - 8);

      // Y-axis title
      ctx.save();
      ctx.translate(12, plotTop + plotHeight / 2);
      ctx.rotate(-Math.PI / 2);
      const yAxisLabels = { lines: 'LINES OF CODE', files: 'NUMBER OF FILES', bytes: 'SIZE IN BYTES' };
      ctx.fillText(yAxisLabels[currentMetric] || 'VALUE', 0, 0);
      ctx.restore();

      // Draw data lines for each language (from bottom to top by current value for better visibility)
      const langValues = ALL_LANGUAGES.map(lang => ({
        lang,
        color: LANGUAGE_COLORS[lang],
        currentValue: getMetricValue(DATA[endIdx].languages[lang], currentMetric)
      })).sort((a, b) => a.currentValue - b.currentValue);

      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (const { lang, color } of langValues) {
        ctx.strokeStyle = color;
        ctx.beginPath();

        let firstPoint = true;
        for (let i = startIdx; i <= endIdx; i += step) {
          const frame = DATA[i];
          const val = getMetricValue(frame.languages[lang], currentMetric);
          const x = plotLeft + ((i - startIdx) / Math.max(1, endIdx - startIdx)) * plotWidth;
          const y = plotTop + plotHeight - (val / maxValue) * plotHeight;

          if (firstPoint) {
            ctx.moveTo(x, y);
            firstPoint = false;
          } else {
            ctx.lineTo(x, y);
          }
        }

        // Always include the current point
        if (step > 1) {
          const val = getMetricValue(DATA[endIdx].languages[lang], currentMetric);
          const x = plotLeft + plotWidth;
          const y = plotTop + plotHeight - (val / maxValue) * plotHeight;
          ctx.lineTo(x, y);
        }

        ctx.stroke();
      }

      // Draw border
      ctx.strokeStyle = '#30363d';
      ctx.lineWidth = 1;
      ctx.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);
    }
    
    let lastChartMetric = null;
    let lastChartUpdateTime = 0;
    const CHART_UPDATE_INTERVAL_MS = 33; // Target 30fps for chart updates

    function updateChart() {
      if (!chartCtx) return;

      // Throttle chart renders to maintain 30fps
      const now = performance.now();
      if (now - lastChartUpdateTime < CHART_UPDATE_INTERVAL_MS) {
        return;
      }
      lastChartUpdateTime = now;

      // Render the chart
      renderChart();
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
      if (audioCtx) return;

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      // Pre-create noise buffers for drum sounds (avoids allocations during playback)
      const snareBufferSize = Math.floor(audioCtx.sampleRate * 0.1);  // 100ms
      snareNoiseBuffer = audioCtx.createBuffer(1, snareBufferSize, audioCtx.sampleRate);
      const snareData = snareNoiseBuffer.getChannelData(0);
      for (let i = 0; i < snareBufferSize; i++) {
        snareData[i] = Math.random() * 2 - 1;
      }

      const hihatBufferSize = Math.floor(audioCtx.sampleRate * 0.05);  // 50ms
      hihatNoiseBuffer = audioCtx.createBuffer(1, hihatBufferSize, audioCtx.sampleRate);
      const hihatData = hihatNoiseBuffer.getChannelData(0);
      for (let i = 0; i < hihatBufferSize; i++) {
        hihatData[i] = Math.random() * 2 - 1;
      }

      const cymbalBufferSize = Math.floor(audioCtx.sampleRate * 0.8);  // 800ms
      cymbalNoiseBuffer = audioCtx.createBuffer(1, cymbalBufferSize, audioCtx.sampleRate);
      const cymbalData = cymbalNoiseBuffer.getChannelData(0);
      for (let i = 0; i < cymbalBufferSize; i++) {
        cymbalData[i] = Math.random() * 2 - 1;
      }

      // Create master gain (final output)
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0;
      masterGain.connect(audioCtx.destination);

      // Create reverb convolver
      reverb = audioCtx.createConvolver();
      reverb.buffer = createReverbImpulse(audioCtx.sampleRate, REVERB_DECAY, REVERB_PREDELAY);
      
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

      // Create shared lowpass filter - connects to both wet and dry paths
      filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = FILTER_CUTOFF;
      filter.Q.value = FILTER_Q_BASE;
      filter.connect(reverb);      // Wet path through reverb
      filter.connect(reverbDryGain); // Dry path bypasses reverb

      // Create voice pool (oscillator + individual gain + stereo panner per voice)
      // Each language gets assigned to a voice based on its rank in ALL_LANGUAGES
      // Voices start on first chord and progress through I-V-vi-IV every 4 seconds
      for (let i = 0; i < MAX_VOICES; i++) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const panner = audioCtx.createStereoPanner();

        osc.type = 'sine';  // Sine waves for smoother harmonic sound

        // Initialize to first chord in progression (C Major)
        const frequency = CHORD_PROGRESSION[0][i] || 440.0;  // Fallback to A4
        osc.frequency.value = frequency;
        
        // Base detune: add slight random offset to prevent phase interference
        // This eliminates "thrumming" / beating effects from phase-aligned oscillators
        // Range: ±3 cents (subtle, imperceptible pitch variation)
        const baseDetune = (Math.random() - 0.5) * 6;
        osc.detune.value = baseDetune;
        gain.gain.value = 0;

        // Calculate stereo position: spread voices across stereo field
        // Map voice index to -1 (left) ... +1 (right)
        const panPosition = MAX_VOICES > 1 
          ? (i / (MAX_VOICES - 1)) * 2 - 1  // Spread from -1 to +1
          : 0;  // Center if only one voice
        panner.pan.value = panPosition;

        // Chain: oscillator -> gain -> panner -> filter
        osc.connect(gain);
        gain.connect(panner);
        panner.connect(filter);
        osc.start();

        voices.push({ osc, gain, panner, lang: null, baseDetune, basePan: panPosition });
      }
      
      // Assign each language to a voice based on its index in ALL_LANGUAGES
      // This gives each language a stable pitch throughout the animation
      ALL_LANGUAGES.forEach((lang, i) => {
        if (i < MAX_VOICES) {
          languageVoiceMap[lang] = i;
          voices[i].lang = lang;
        }
      });
    }

    function updateAudio() {
      if (!audioCtx || isFadingOut) return;

      // Check for major code changes and trigger cymbal
      const frame = DATA[currentIndex];
      if (frame && soundEnabled) {
        const currentTotal = frame.totalLines || frame.total || 0;
        if (checkForMajorChange(currentTotal)) {
          playCymbal();
        }
      }

      const now = audioCtx.currentTime;
      const rampEnd = now + (RAMP_TIME_MS / 1000);
      const audioFrame = AUDIO_DATA[currentIndex];

      // Require pre-computed audio data (schema 2.2+)
      if (!audioFrame) return;

      // Get audio data for current metric
      // Optimized sparse format: [masterIntensity, [langIndex, gain, detune], ...]
      const metricData = audioFrame[currentMetric];
      if (!metricData || !Array.isArray(metricData)) return;

      const masterIntensity = metricData[0];

      // Build set of active voice indices for this frame
      const activeVoices = new Set();
      for (let j = 1; j < metricData.length; j++) {
        const [langIndex] = metricData[j];
        if (langIndex < MAX_VOICES && langIndex < voices.length) {
          activeVoices.add(langIndex);
        }
      }

      // Update all voices: active ones get their target, inactive ones fade to silence
      for (let i = 0; i < MAX_VOICES && i < voices.length; i++) {
        const voice = voices[i];
        const targetPan = voice.basePan * audioSettings.stereoWidth;

        if (!activeVoices.has(i)) {
          // Inactive voice: fade to silence
          voice.gain.gain.linearRampToValueAtTime(0, rampEnd);
          voice.osc.detune.linearRampToValueAtTime(voice.baseDetune, rampEnd);
          voice.panner.pan.linearRampToValueAtTime(targetPan, rampEnd);
        }
      }

      // Apply gains for active voices (sparse data)
      for (let j = 1; j < metricData.length; j++) {
        const [langIndex, gain, detune] = metricData[j];
        if (langIndex >= MAX_VOICES || langIndex >= voices.length) continue;

        const voice = voices[langIndex];

        // Apply gain with perceptual power curve
        const perceivedGain = Math.pow(gain, audioSettings.gainCurvePower);
        voice.gain.gain.linearRampToValueAtTime(perceivedGain, rampEnd);

        // Apply detune: base chorusing + dynamic pitch variation
        voice.osc.detune.linearRampToValueAtTime(voice.baseDetune + detune, rampEnd);

        // Apply stereo width
        const targetPan = voice.basePan * audioSettings.stereoWidth;
        voice.panner.pan.linearRampToValueAtTime(targetPan, rampEnd);
      }

      // Apply intensity curve transformation
      let adjustedIntensity = masterIntensity;
      switch (audioSettings.intensityCurve) {
        case 'log':
          adjustedIntensity = Math.log(1 + masterIntensity) / Math.log(2);
          break;
        case 'exp':
          adjustedIntensity = masterIntensity * masterIntensity;
          break;
        case 'linear':
        default:
          adjustedIntensity = masterIntensity;
          break;
      }

      // Use transformed master intensity
      const intensityScale = VOLUME_MIN + (adjustedIntensity * (VOLUME_MAX - VOLUME_MIN));
      const volume = elements.soundVolume.value / 100;
      const targetGain = soundEnabled ? intensityScale * volume * 0.5 : 0;
      masterGain.gain.linearRampToValueAtTime(targetGain, rampEnd);

      // Filter Q varies with intensity for brightness
      filter.Q.linearRampToValueAtTime(FILTER_Q_BASE + adjustedIntensity * FILTER_Q_MAX, rampEnd);
    }

    function fadeOutAudio() {
      if (!audioCtx || !soundEnabled || isFadingOut) return;
      isFadingOut = true;

      const now = audioCtx.currentTime;
      const fadeEnd = now + (FADE_OUT_TIME_MS / 1000);

      // Fade master gain to zero
      masterGain.gain.linearRampToValueAtTime(0, fadeEnd);

      // After fade completes, silence all voices and reset detune
      setTimeout(() => {
        if (!audioCtx) return;
        voices.forEach(voice => {
          voice.gain.gain.setValueAtTime(0, audioCtx.currentTime);
          voice.osc.detune.setValueAtTime(voice.baseDetune, audioCtx.currentTime);
        });
      }, FADE_OUT_TIME_MS);
    }

    function resetAudioState() {
      isFadingOut = false;
      playbackStartTime = null;
      totalBeatsElapsed = 0;
      currentBeat = 0;
      currentChordIndex = 0;
      lastScheduledBeat = -1;
      lastCymbalBeat = -1;
      lastFrameTotal = 0;
      accumulatedTime = 0;
    }

    // Get current BPM adjusted for playback speed
    function getEffectiveBPM() {
      return BASE_BPM * speedMultiplier;
    }

    // Get beat duration in milliseconds at current speed
    function getBeatDurationMs() {
      return 60000 / getEffectiveBPM();
    }

    // Schedule audio events for upcoming beats (lookahead scheduling)
    function scheduleAudioForBeat(beatNumber, beatTimeInAudioCtx) {
      if (!audioCtx || !soundEnabled || isFadingOut) return;

      const beatInBar = beatNumber % BEATS_PER_BAR;

      // Drum pattern varies by speed:
      // - Normal (1x, 2x): kick on 1,3 / snare on 2,4 (standard rock beat)
      // - Fast (4x+): kick on 1 / snare on 3 (half-time feel)
      if (speedMultiplier >= 4) {
        // Simplified half-time pattern for fast playback
        if (beatInBar === 0) {
          playKick(beatTimeInAudioCtx);
        } else if (beatInBar === 2) {
          playSnare(beatTimeInAudioCtx);
        }
        // beats 1,3 are silent for cleaner fast playback
      } else {
        // Full pattern for normal speeds
        if (beatInBar === 0 || beatInBar === 2) {
          playKick(beatTimeInAudioCtx);
        } else {
          playSnare(beatTimeInAudioCtx);
        }
      }

      // Check for chord change (every BEATS_PER_CHORD beats)
      if (beatNumber % BEATS_PER_CHORD === 0) {
        const newChordIndex = Math.floor(beatNumber / BEATS_PER_CHORD) % CHORD_PROGRESSION.length;
        if (newChordIndex !== currentChordIndex) {
          currentChordIndex = newChordIndex;
          applyChordFrequencies(CHORD_GLIDE_TIME_MS / 1000);
        }
      }
    }

    // Main audio scheduling loop - called from animation frame
    function updateAudioScheduling() {
      if (!audioCtx || !soundEnabled || isFadingOut || playbackStartTime === null) return;

      const now = performance.now();
      const elapsedMs = now - playbackStartTime;
      const beatDurationMs = getBeatDurationMs();

      // Calculate current beat position
      const currentBeatFloat = elapsedMs / beatDurationMs;
      const currentBeatInt = Math.floor(currentBeatFloat);

      // Lookahead: schedule beats up to 100ms ahead
      const lookaheadMs = 100;
      const lookaheadBeats = Math.ceil((elapsedMs + lookaheadMs) / beatDurationMs);

      // Schedule any beats we haven't scheduled yet
      for (let beat = lastScheduledBeat + 1; beat <= lookaheadBeats; beat++) {
        const beatTimeMs = beat * beatDurationMs;
        const beatTimeFromNow = beatTimeMs - elapsedMs;
        const beatTimeInAudioCtx = audioCtx.currentTime + (beatTimeFromNow / 1000);

        if (beatTimeInAudioCtx > audioCtx.currentTime) {
          scheduleAudioForBeat(beat, beatTimeInAudioCtx);
        }
      }

      lastScheduledBeat = lookaheadBeats;
      currentBeat = currentBeatInt % BEATS_PER_BAR;
      totalBeatsElapsed = currentBeatInt;
    }

    function applyChordFrequencies(glideTimeSec) {
      if (!audioCtx || voices.length === 0) return;

      const now = audioCtx.currentTime;
      const chord = CHORD_PROGRESSION[currentChordIndex];

      for (let i = 0; i < MAX_VOICES && i < voices.length && i < chord.length; i++) {
        const voice = voices[i];
        const targetFreq = chord[i];

        if (glideTimeSec > 0) {
          // Smooth glide to new frequency
          voice.osc.frequency.linearRampToValueAtTime(targetFreq, now + glideTimeSec);
        } else {
          // Immediate set (for initialization)
          voice.osc.frequency.setValueAtTime(targetFreq, now);
        }
      }
    }

    // Drum synthesis functions - gentle texture beats
    function playKick(time) {
      if (!audioCtx || !soundEnabled || isFadingOut) return;

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      // Kick: sine wave starting at 150Hz, quickly dropping to 50Hz
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, time);
      osc.frequency.exponentialRampToValueAtTime(50, time + 0.05);

      // Quick attack, medium decay
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(KICK_VOLUME, time + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);

      osc.connect(gain);
      gain.connect(masterGain);

      osc.start(time);
      osc.stop(time + 0.15);

      // Clean up nodes after playback to prevent memory accumulation
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }

    function playSnare(time) {
      if (!audioCtx || !soundEnabled || isFadingOut || !snareNoiseBuffer) return;

      // Snare body: use pre-created noise buffer
      const noise = audioCtx.createBufferSource();
      noise.buffer = snareNoiseBuffer;

      const noiseFilter = audioCtx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = 3000;
      noiseFilter.Q.value = 1;

      const noiseGain = audioCtx.createGain();
      noiseGain.gain.setValueAtTime(0, time);
      noiseGain.gain.linearRampToValueAtTime(SNARE_VOLUME * 0.6, time + 0.002);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);

      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(masterGain);

      noise.start(time);
      noise.stop(time + 0.1);

      // Clean up noise nodes
      noise.onended = () => {
        noise.disconnect();
        noiseFilter.disconnect();
        noiseGain.disconnect();
      };

      // Snare tone: add subtle pitched element
      const tone = audioCtx.createOscillator();
      const toneGain = audioCtx.createGain();

      tone.type = 'triangle';
      tone.frequency.value = 180;

      toneGain.gain.setValueAtTime(0, time);
      toneGain.gain.linearRampToValueAtTime(SNARE_VOLUME * 0.3, time + 0.002);
      toneGain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

      tone.connect(toneGain);
      toneGain.connect(masterGain);

      tone.start(time);
      tone.stop(time + 0.05);

      // Clean up tone nodes
      tone.onended = () => {
        tone.disconnect();
        toneGain.disconnect();
      };
    }

    function playHihat(time) {
      if (!audioCtx || !soundEnabled || isFadingOut || !hihatNoiseBuffer) return;

      // Hihat: use pre-created noise buffer
      const noise = audioCtx.createBufferSource();
      noise.buffer = hihatNoiseBuffer;

      // High-pass filter for crisp hihat sound
      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 8000;
      highpass.Q.value = 0.5;

      const hihatGain = audioCtx.createGain();
      hihatGain.gain.setValueAtTime(0, time);
      hihatGain.gain.linearRampToValueAtTime(HIHAT_VOLUME, time + 0.001);
      hihatGain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

      noise.connect(highpass);
      highpass.connect(hihatGain);
      hihatGain.connect(masterGain);

      noise.start(time);
      noise.stop(time + 0.05);

      // Clean up nodes after playback
      noise.onended = () => {
        noise.disconnect();
        highpass.disconnect();
        hihatGain.disconnect();
      };
    }

    function playCymbal() {
      if (!audioCtx || !soundEnabled || isFadingOut || !cymbalNoiseBuffer) return;

      // Debounce: max 1 cymbal per beat
      if (totalBeatsElapsed <= lastCymbalBeat) return;
      lastCymbalBeat = totalBeatsElapsed;

      const time = audioCtx.currentTime;

      // Cymbal: use pre-created noise buffer
      const noise = audioCtx.createBufferSource();
      noise.buffer = cymbalNoiseBuffer;

      // High-pass filter for bright cymbal sound
      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 7000;
      highpass.Q.value = 0.5;

      // Gentle bandpass for shimmer
      const bandpass = audioCtx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 10000;
      bandpass.Q.value = 0.7;

      const cymbalGain = audioCtx.createGain();
      // Quick attack, long natural decay
      cymbalGain.gain.setValueAtTime(0, time);
      cymbalGain.gain.linearRampToValueAtTime(CYMBAL_VOLUME, time + 0.005);
      cymbalGain.gain.exponentialRampToValueAtTime(CYMBAL_VOLUME * 0.3, time + 0.1);
      cymbalGain.gain.exponentialRampToValueAtTime(0.001, time + 0.6);

      noise.connect(highpass);
      highpass.connect(bandpass);
      bandpass.connect(cymbalGain);
      cymbalGain.connect(masterGain);

      noise.start(time);
      noise.stop(time + 0.8);

      // Clean up nodes after playback
      noise.onended = () => {
        noise.disconnect();
        highpass.disconnect();
        bandpass.disconnect();
        cymbalGain.disconnect();
      };
    }

    function checkForMajorChange(currentTotal) {
      if (lastFrameTotal === 0) {
        lastFrameTotal = currentTotal;
        return false;
      }

      const change = Math.abs(currentTotal - lastFrameTotal) / lastFrameTotal;
      lastFrameTotal = currentTotal;

      return change >= CYMBAL_THRESHOLD;
    }

    function resumeAudioContext() {
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    }

    function toggleSound() {
      if (!AUDIO_SUPPORTED) return;

      if (!audioCtx) {
        initAudio();
      }

      const wasEnabled = soundEnabled;
      soundEnabled = !soundEnabled;

      // Update UI
      elements.soundToggle.classList.toggle('active', soundEnabled);
      elements.soundIconOff.style.display = soundEnabled ? 'none' : 'block';
      elements.soundIconOn.style.display = soundEnabled ? 'block' : 'none';

      // Resume audio context if needed (browser autoplay policy)
      if (soundEnabled) {
        resumeAudioContext();

        // Fade in from silence to prevent clicks/pops
        if (!wasEnabled && masterGain) {
          const now = audioCtx.currentTime;
          masterGain.gain.setValueAtTime(0, now);
          // Will be ramped up in updateAudio() call below
        }

        // Initialize chord on first sound enable during playback
        if (isPlaying && playbackStartTime !== null) {
          applyChordFrequencies(0);
        }

        // Start audio scheduler if playing
        if (isPlaying && !audioSchedulerInterval) {
          audioSchedulerInterval = setInterval(audioSchedulerTick, AUDIO_SCHEDULER_INTERVAL_MS);
        }
      } else {
        // Stop audio scheduler when sound is disabled
        if (audioSchedulerInterval) {
          clearInterval(audioSchedulerInterval);
          audioSchedulerInterval = null;
        }
      }

      // Update audio immediately to reflect new enabled state
      updateAudio();
    }

    function updateDisplay() {
      if (DATA.length === 0) {
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

      // Get totals based on current metric
      const total = getFrameTotal(frame, currentMetric);
      const prevTotal = prevFrame ? getFrameTotal(prevFrame, currentMetric) : 0;
      const totalFiles = frame.totalFiles || 0;
      const prevTotalFiles = prevFrame ? (prevFrame.totalFiles || 0) : 0;

      // Update summary stats (primary stat changes with metric)
      elements.totalLines.textContent = formatMetricValue(total, currentMetric);
      elements.totalFiles.textContent = formatNumber(totalFiles);

      if (prevFrame) {
        elements.totalDelta.innerHTML = formatMetricDelta(total, prevTotal, currentMetric);
        elements.filesDelta.innerHTML = formatDelta(totalFiles, prevTotalFiles);
      } else {
        elements.totalDelta.innerHTML = '';
        elements.filesDelta.innerHTML = '';
      }

      // Update table via DOM diffing - only update changed cells
      for (const cached of tableRowCache) {
        const stats = frame.languages[cached.lang];
        const prevStats = prevFrame ? prevFrame.languages[cached.lang] : null;

        // Get metric value for this language
        const metricValue = getMetricValue(stats, currentMetric);
        const prevMetricValue = getMetricValue(prevStats, currentMetric);
        const files = stats ? stats.files : 0;
        const blank = stats ? stats.blank : 0;
        const comment = stats ? stats.comment : 0;
        const prevFiles = prevStats ? prevStats.files : 0;
        const percentage = total > 0 ? (metricValue / total) * 100 : 0;
        const active = metricValue > 0;

        const prev = cached.prevValues;

        // Update row class only if active state changed
        const wasActive = prev.metricValue > 0;
        if (active !== wasActive) {
          cached.row.className = active ? '' : 'row-inactive';
        }

        // Update percentage if changed (check with tolerance for floating point)
        if (Math.abs(percentage - prev.percentage) > 0.01) {
          cached.percent.textContent = percentage.toFixed(1) + '%';
          prev.percentage = percentage;
        }

        // Update primary metric value if changed
        if (metricValue !== prev.metricValue || cached.lastMetric !== currentMetric) {
          cached.linesMain.textContent = formatMetricValue(metricValue, currentMetric);
          prev.metricValue = metricValue;
          cached.lastMetric = currentMetric;
        }

        // Update metric delta
        if (prevFrame) {
          cached.linesDelta.innerHTML = formatMetricDelta(metricValue, prevMetricValue, currentMetric);
        } else {
          cached.linesDelta.innerHTML = '';
        }

        // Update secondary info (blank/comment) - only show for lines metric
        if (currentMetric === 'lines') {
          if (blank !== prev.blank || comment !== prev.comment) {
            if (active && (blank > 0 || comment > 0)) {
              cached.linesSecondary.textContent = formatNumber(blank) + 'b ' + formatNumber(comment) + 'c';
            } else {
              cached.linesSecondary.textContent = '';
            }
            prev.blank = blank;
            prev.comment = comment;
          }
        } else {
          cached.linesSecondary.textContent = '';
        }

        // Update files if changed
        if (files !== prev.files) {
          cached.filesMain.textContent = formatNumber(files);
          prev.files = files;
        }

        // Update files delta
        if (prevFrame) {
          cached.filesDelta.innerHTML = formatDelta(files, prevFiles);
        } else {
          cached.filesDelta.innerHTML = '';
        }
      }

      // Update chart
      updateChart();
    }
    
    // Audio scheduler tick - runs via setInterval to continue when tab is hidden
    const AUDIO_SCHEDULER_INTERVAL_MS = 25; // Schedule audio every 25ms

    function audioSchedulerTick() {
      if (!isPlaying || !soundEnabled) return;
      updateAudioScheduling();
    }

    // Visual animation loop - uses requestAnimationFrame for smooth rendering
    function animationLoop(timestamp) {
      if (!isPlaying) return;

      // Initialize timing on first frame
      if (lastFrameTime === 0) {
        lastFrameTime = timestamp;
      }

      // Calculate delta time and apply speed multiplier
      const deltaTime = timestamp - lastFrameTime;
      lastFrameTime = timestamp;

      // Accumulate time for frame advancement
      accumulatedTime += deltaTime * speedMultiplier;

      // Calculate frame duration at 1x speed
      const frameDurationMs = Math.max(MIN_FRAME_DELAY, Math.floor(TARGET_DURATION_MS / DATA.length));

      // Advance frames based on accumulated time
      // Only update index here - display update happens once after the loop
      const previousIndex = currentIndex;
      while (accumulatedTime >= frameDurationMs && currentIndex < DATA.length - 1) {
        accumulatedTime -= frameDurationMs;
        currentIndex++;
      }

      // Only update display once per animation frame (not per index increment)
      if (currentIndex !== previousIndex) {
        updateDisplay();
      }

      // Check for end of playback
      if (currentIndex >= DATA.length - 1) {
        currentIndex = DATA.length - 1;
        fadeOutAudio();
        pause();
        return;
      }

      // Continue loop
      animationFrameId = requestAnimationFrame(animationLoop);
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

      // Reset timing state for fresh start
      lastFrameTime = 0;
      accumulatedTime = 0;
      playbackStartTime = performance.now();
      lastScheduledBeat = -1;

      // Set initial chord for audio
      if (soundEnabled) {
        applyChordFrequencies(0);
      }

      // Clear any existing schedulers to prevent dual-scheduling
      if (audioSchedulerInterval) {
        clearInterval(audioSchedulerInterval);
        audioSchedulerInterval = null;
      }
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      // Start audio scheduler (setInterval continues when tab is hidden)
      if (soundEnabled) {
        audioSchedulerInterval = setInterval(audioSchedulerTick, AUDIO_SCHEDULER_INTERVAL_MS);
      }

      // Start the visual animation loop
      animationFrameId = requestAnimationFrame(animationLoop);
    }

    function pause() {
      isPlaying = false;
      elements.playPause.textContent = 'Play';
      elements.playPause.classList.add('primary');

      // Cancel animation frame
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      // Cancel audio scheduler interval
      if (audioSchedulerInterval) {
        clearInterval(audioSchedulerInterval);
        audioSchedulerInterval = null;
      }

      // Reset timing for next play
      lastFrameTime = 0;
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
      resetAudioState();
      currentIndex = 0;
      updateDisplay();
    }

    function goLatest() {
      pause();
      currentIndex = DATA.length - 1;
      fadeOutAudio();
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
      // Speed change takes effect immediately via getEffectiveBPM()
      // Reset beat scheduling to sync with new tempo
      if (isPlaying && playbackStartTime !== null) {
        playbackStartTime = performance.now();
        lastScheduledBeat = -1;
        totalBeatsElapsed = 0;
      }
    });

    // Metric selector
    elements.metric.addEventListener('change', (e) => {
      currentMetric = e.target.value;

      // Update summary stats label
      const labelEl = elements.summaryStats.querySelector('.stat-label');
      if (labelEl) {
        labelEl.textContent = 'Total ' + getMetricLabel(currentMetric);
      }

      // Update chart Y-axis label
      if (chart) {
        const yAxisLabels = { lines: 'LINES OF CODE', files: 'NUMBER OF FILES', bytes: 'SIZE IN BYTES' };
        chart.options.scales.y.title.text = yAxisLabels[currentMetric] || 'LINES OF CODE';
      }

      // Force full table refresh by resetting cached values
      tableRowCache.forEach(cached => {
        cached.prevValues.metricValue = -1;
        cached.prevValues.percentage = -1;
      });

      // Update display immediately
      updateDisplay();
    });

    // Sound controls
    if (AUDIO_SUPPORTED) {
      elements.soundToggle.addEventListener('click', () => {
        toggleSound();
        // Show/hide advanced audio controls based on sound state
        if (soundEnabled) {
          elements.audioControls.classList.remove('hidden');
        } else {
          elements.audioControls.classList.add('hidden');
        }
      });

      elements.soundVolume.addEventListener('input', () => {
        // Update audio to reflect new volume
        if (audioCtx) {
          updateAudio();
        }
      });

      // Audio enhancement controls
      elements.gainCurve.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value);
        audioSettings.gainCurvePower = value;
        elements.gainCurveValue.textContent = value.toFixed(2);
        if (audioCtx && soundEnabled) {
          updateAudio();
        }
        localStorage.setItem('audioGainCurve', value);
      });

      elements.intensityCurve.addEventListener('change', (e) => {
        audioSettings.intensityCurve = e.target.value;
        if (audioCtx && soundEnabled) {
          updateAudio();
        }
        localStorage.setItem('audioIntensityCurve', e.target.value);
      });

      elements.stereoWidth.addEventListener('input', (e) => {
        const value = parseInt(e.target.value) / 100;  // Convert 0-100 to 0-1
        audioSettings.stereoWidth = value;
        elements.stereoWidthValue.textContent = e.target.value + '%';
        if (audioCtx && soundEnabled) {
          updateAudio();
        }
        localStorage.setItem('audioStereoWidth', value);
      });

      // Load settings from localStorage
      const savedGainCurve = localStorage.getItem('audioGainCurve');
      if (savedGainCurve !== null) {
        const value = parseFloat(savedGainCurve);
        audioSettings.gainCurvePower = value;
        elements.gainCurve.value = value;
        elements.gainCurveValue.textContent = value.toFixed(2);
      }

      const savedIntensityCurve = localStorage.getItem('audioIntensityCurve');
      if (savedIntensityCurve !== null) {
        audioSettings.intensityCurve = savedIntensityCurve;
        elements.intensityCurve.value = savedIntensityCurve;
      }

      const savedStereoWidth = localStorage.getItem('audioStereoWidth');
      if (savedStereoWidth !== null) {
        const value = parseFloat(savedStereoWidth);
        audioSettings.stereoWidth = value;
        elements.stereoWidth.value = Math.round(value * 100);
        elements.stereoWidthValue.textContent = Math.round(value * 100) + '%';
      }

      // Initially hide audio controls
      elements.audioControls.classList.add('hidden');
    } else {
      // Hide sound controls if Web Audio not supported
      elements.soundControl.classList.add('hidden');
      elements.audioControls.classList.add('hidden');
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
    initTable();
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
