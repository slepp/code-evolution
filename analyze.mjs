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
 * 
 * Usage: node analyze.mjs <git-repo-url> [output-dir] [--force-full]
 */

import { execSync, spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const FRAME_DELAY_MS = 200;
const SCHEMA_VERSION = '2.0';

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
  console.log(`\n📦 Cloning repository: ${repoUrl}`);
  exec(`git clone "${repoUrl}" "${targetDir}"`);
  console.log('✓ Clone complete');
}

function getCommitHistory(repoDir, branch = 'main', afterCommit = null) {
  const label = afterCommit ? 'new commits' : 'commit history';
  console.log(`\n📜 Getting ${label} from branch: ${branch}`);
  
  // Try main first, fall back to master
  const branches = exec(`git -C "${repoDir}" branch -r`, { silent: true });
  const hasMain = branches.includes('origin/main');
  const hasMaster = branches.includes('origin/master');
  
  let actualBranch = branch;
  if (branch === 'main' && !hasMain && hasMaster) {
    actualBranch = 'master';
    console.log('  (using master branch instead)');
  }
  
  // Get commits in chronological order (oldest first)
  // If afterCommit is provided, only get commits after that hash
  let logCmd = `git -C "${repoDir}" log ${actualBranch} --reverse --pretty=format:"%H|%ad|%s" --date=short`;
  if (afterCommit) {
    logCmd = `git -C "${repoDir}" log ${afterCommit}..${actualBranch} --reverse --pretty=format:"%H|%ad|%s" --date=short`;
  }
  
  const commits = exec(logCmd, { silent: true, ignoreError: true })
    .split('\n')
    .filter(line => line.trim());
  
  console.log(`✓ Found ${commits.length} commits`);
  
  return commits.map(line => {
    const [hash, date, ...messageParts] = line.split('|');
    return {
      hash: hash.trim(),
      date: date.trim(),
      message: messageParts.join('|').trim()
    };
  });
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
  console.log(`\n🔍 Analyzing ${commits.length} commits...\n`);
  
  const results = [...existingResults]; // Start with existing results
  const allLanguages = new Set();
  
  // Track languages from existing results
  for (const result of existingResults) {
    Object.keys(result.languages).forEach(lang => allLanguages.add(lang));
  }
  
  const startTime = Date.now();
  
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const progress = `[${i + 1}/${commits.length}]`;
    
    process.stdout.write(`${progress} ${commit.hash.substring(0, 8)} (${commit.date})...`);
    
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
    
    process.stdout.write(' ✓\n');
  }
  
  const elapsedSeconds = (Date.now() - startTime) / 1000;
  
  if (commits.length > 0) {
    console.log(`\n✓ Analysis complete (${elapsedSeconds.toFixed(2)}s)`);
    console.log(`📊 Languages found: ${Array.from(allLanguages).sort().join(', ')}`);
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
  
  return {
    results,
    allLanguages: languageOrder,
    analysisTime: elapsedSeconds
  };
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
  const { results, allLanguages } = data;
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Evolution: ${repoUrl}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 15px;
    }
    
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 1800px;
      width: 100%;
      padding: 20px;
      margin: 0 auto;
    }
    
    .header {
      text-align: center;
      margin-bottom: 10px;
    }
    
    h1 {
      color: #333;
      font-size: 20px;
      margin-bottom: 3px;
    }
    
    .repo-url {
      color: #666;
      font-size: 11px;
      word-break: break-all;
    }
    
    .main-content {
      display: flex;
      gap: 20px;
      margin-top: 15px;
    }
    
    .left-panel {
      flex: 0 0 500px;
      display: flex;
      flex-direction: column;
    }
    
    .right-panel {
      flex: 1;
      min-width: 0;
    }
    
    .chart-container {
      background: #f8f9fa;
      border-radius: 6px;
      padding: 15px;
      height: 600px;
      position: relative;
    }
    
    #chart-canvas {
      max-height: 100%;
    }
    
    .commit-info {
      background: #f8f9fa;
      padding: 8px 12px;
      border-radius: 6px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    
    .commit-date {
      font-size: 15px;
      font-weight: 600;
      color: #667eea;
    }
    
    .commit-hash {
      font-family: 'Courier New', monospace;
      background: #e9ecef;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 12px;
      color: #495057;
    }
    
    .commit-number {
      font-size: 11px;
      color: #6c757d;
      margin-top: 2px;
    }
    
    .table-container {
      flex: 1;
      overflow-y: auto;
      max-height: 600px;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    
    th {
      background: #667eea;
      color: white;
      padding: 6px 8px;
      text-align: left;
      font-weight: 600;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    
    th:nth-child(2) {
      width: 100px;
    }
    
    th:nth-child(3), th:nth-child(4) {
      text-align: right;
      width: 70px;
    }
    
    td {
      padding: 4px 8px;
      border-bottom: 1px solid #e9ecef;
    }
    
    tr:hover {
      background: #f8f9fa;
    }
    
    .language-name {
      font-weight: 600;
      color: #333;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .percentage-text {
      text-align: right;
      font-weight: 600;
      color: #667eea;
      font-size: 11px;
      white-space: nowrap;
    }
    
    .lines-count {
      text-align: right;
      font-family: 'Courier New', monospace;
      color: #495057;
      font-weight: 500;
      font-size: 11px;
      white-space: nowrap;
    }
    
    .lines-secondary {
      display: block;
      font-size: 9px;
      color: #adb5bd;
      margin-top: 2px;
      font-weight: normal;
    }
    
    .files-count {
      text-align: right;
      font-family: 'Courier New', monospace;
      color: #6c757d;
      font-size: 11px;
      white-space: nowrap;
    }
    
    .row-inactive {
      opacity: 0.4;
    }
    
    .row-inactive .language-name {
      font-style: italic;
    }
    
    .delta {
      font-size: 10px;
      margin-left: 4px;
      font-weight: 600;
      display: inline-block;
    }
    
    .delta-positive {
      color: #28a745;
    }
    
    .delta-negative {
      color: #dc3545;
    }
    
    .delta-neutral {
      color: #6c757d;
    }
    
    .summary-stats {
      background: #f8f9fa;
      padding: 10px;
      border-radius: 6px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-around;
      align-items: center;
      gap: 10px;
    }
    
    .stat-item {
      text-align: center;
      flex: 1;
    }
    
    .stat-label {
      font-size: 9px;
      color: #6c757d;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-bottom: 3px;
    }
    
    .stat-value {
      font-size: 16px;
      font-weight: 700;
      color: #333;
      font-family: 'Courier New', monospace;
    }
    
    .stat-delta {
      font-size: 11px;
      font-weight: 600;
      margin-top: 2px;
    }
    
    .controls {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    
    button {
      background: #667eea;
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.3s;
      box-shadow: 0 2px 4px rgba(102, 126, 234, 0.3);
    }
    
    button:hover {
      background: #5568d3;
    }
    
    button:disabled {
      background: #adb5bd;
      cursor: not-allowed;
      box-shadow: none;
    }
    
    .speed-control {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .speed-control label {
      font-size: 11px;
      color: #495057;
      font-weight: 600;
    }
    
    .speed-control select {
      padding: 4px 8px;
      border: 2px solid #e9ecef;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      background: white;
    }
    
    .empty-state {
      text-align: center;
      padding: 40px;
      color: #6c757d;
    }
    
    .timeline {
      background: #f8f9fa;
      padding: 8px 12px;
      border-radius: 6px;
      margin-bottom: 10px;
    }
    
    .timeline-bar {
      width: 100%;
      height: 6px;
      background: #e9ecef;
      border-radius: 3px;
      overflow: hidden;
    }
    
    .timeline-progress {
      height: 100%;
      background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
      transition: width 0.2s ease;
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
        max-height: 400px;
      }
      
      .chart-container {
        height: 400px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Code Evolution Timeline</h1>
      <div class="repo-url">${escapeHtml(repoUrl)}</div>
    </div>
    
    <div class="commit-info">
      <div class="commit-date" id="commit-date">Loading...</div>
      <div>
        <div class="commit-hash" id="commit-hash">--------</div>
        <div class="commit-number" id="commit-number">Commit 0 of 0</div>
      </div>
    </div>
    
    <div class="timeline">
      <div class="timeline-bar">
        <div class="timeline-progress" id="timeline-progress"></div>
      </div>
    </div>
    
    <div class="controls">
      <button id="play-pause">▶ Play</button>
      <button id="prev">⏮ Previous</button>
      <button id="next">⏭ Next</button>
      <button id="reset">⏪ Reset</button>
      <div class="speed-control">
        <label>Speed:</label>
        <select id="speed">
          <option value="500">0.5x</option>
          <option value="200" selected>1x</option>
          <option value="100">2x</option>
          <option value="50">4x</option>
        </select>
      </div>
    </div>
    
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
    
    <div class="main-content">
      <div class="left-panel">
        <div class="table-container">
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

  <script>
    const DATA = ${JSON.stringify(results)};
    const ALL_LANGUAGES = ${JSON.stringify(allLanguages)};
    
    let currentIndex = 0;
    let isPlaying = false;
    let animationInterval = null;
    let frameDelay = ${FRAME_DELAY_MS};
    let chart = null;
    
    // Generate colors for languages
    const LANGUAGE_COLORS = {};
    const colorPalette = [
      '#667eea', '#764ba2', '#f093fb', '#4facfe', 
      '#43e97b', '#fa709a', '#fee140', '#30cfd0',
      '#a8edea', '#fed6e3', '#c471f5', '#fa8bff',
      '#ffc371', '#ff5f6d', '#ffc3a0', '#ffafbd'
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
      
      // Prepare datasets for each language
      const datasets = ALL_LANGUAGES.map(lang => ({
        label: lang,
        data: [],
        borderColor: LANGUAGE_COLORS[lang],
        backgroundColor: LANGUAGE_COLORS[lang] + '20',
        borderWidth: 2,
        tension: 0.1,
        pointRadius: 0,
        pointHoverRadius: 4
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
                boxWidth: 12,
                font: { size: 10 },
                padding: 8,
                usePointStyle: true
              }
            },
            tooltip: {
              mode: 'index',
              intersect: false,
              callbacks: {
                label: function(context) {
                  return context.dataset.label + ': ' + formatNumber(context.parsed.y) + ' lines';
                }
              }
            }
          },
          scales: {
            x: {
              title: {
                display: true,
                text: 'Commit Number',
                font: { size: 11 }
              },
              ticks: {
                font: { size: 10 }
              }
            },
            y: {
              title: {
                display: true,
                text: 'Lines of Code',
                font: { size: 11 }
              },
              ticks: {
                font: { size: 10 },
                callback: function(value) {
                  return formatNumber(value);
                }
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
      elements.playPause.textContent = '⏸ Pause';
      
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
      elements.playPause.textContent = '▶ Play';
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
    
    // Event listeners
    elements.playPause.addEventListener('click', () => {
      if (isPlaying) pause();
      else play();
    });
    
    elements.next.addEventListener('click', next);
    elements.prev.addEventListener('click', prev);
    elements.reset.addEventListener('click', reset);
    
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
      }
    });
    
    // Initialize
    initChart();
    updateDisplay();
  </script>
</body>
</html>`;

  return html;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
📊 CLOC History Analyzer v${SCHEMA_VERSION}
========================

Analyzes code evolution over time by running cloc on every commit.
Supports incremental updates - only analyzes new commits on subsequent runs.

Usage:
  node analyze.mjs <git-repo-url> [output-dir] [--force-full]

Arguments:
  git-repo-url    URL of the git repository to analyze
  output-dir      Output directory (default: ./output)
  --force-full    Force full analysis, ignore existing data

Example:
  node analyze.mjs https://github.com/user/repo
  node analyze.mjs https://github.com/user/repo ./my-output
  node analyze.mjs https://github.com/user/repo ./output --force-full

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
  
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--force-full') {
      forceFull = true;
    } else if (!args[i].startsWith('--')) {
      outputDir = args[i];
    }
  }
  
  console.log(`📊 CLOC History Analyzer v${SCHEMA_VERSION}`);
  console.log('========================\n');
  console.log(`Repository: ${repoUrl}`);
  console.log(`Output: ${outputDir}`);
  if (forceFull) {
    console.log('Mode: Full analysis (--force-full)');
  }
  console.log();
  
  // Create output directory
  exec(`mkdir -p "${outputDir}"`, { silent: true });
  
  // Try to load existing data
  let existingData = null;
  if (!forceFull) {
    existingData = loadExistingData(outputDir);
    if (existingData) {
      console.log(`✓ Found existing data (${existingData.results.length} commits)`);
      console.log(`  Last analyzed: ${existingData.metadata.last_commit_date}`);
      console.log(`  Last commit: ${existingData.metadata.last_commit_hash.substring(0, 8)}`);
    }
  }
  
  // Create temp directory for repo
  const tempDir = mkdtempSync(join(tmpdir(), 'cloc-analysis-'));
  const repoDir = join(tempDir, 'repo');
  
  try {
    // Clone repository
    cloneRepo(repoUrl, repoDir);
    
    // Get commits (incremental or full)
    let commits;
    if (existingData && existingData.metadata.last_commit_hash) {
      console.log('\n🔄 Incremental mode: checking for new commits...');
      commits = getCommitHistory(repoDir, 'main', existingData.metadata.last_commit_hash);
      
      if (commits.length === 0) {
        console.log('\n✅ Already up to date! No new commits to analyze.');
        console.log(`\nVisualization: ${join(outputDir, 'visualization.html')}`);
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
    const dataFile = join(outputDir, 'data.json');
    writeFileSync(dataFile, JSON.stringify(data, null, 2));
    console.log(`\n💾 Data saved: ${dataFile}`);
    console.log(`   Schema version: ${data.schema_version}`);
    console.log(`   Total commits: ${data.results.length}`);
    console.log(`   Languages: ${data.allLanguages.length}`);
    
    // Generate HTML
    const html = generateHTML(data, repoUrl);
    const htmlFile = join(outputDir, 'visualization.html');
    writeFileSync(htmlFile, html);
    console.log(`🎨 Visualization generated: ${htmlFile}`);
    
    console.log('\n✅ Analysis complete!');
    console.log(`\nOpen ${htmlFile} in a browser to view the animation.`);
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up temporary files...');
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
