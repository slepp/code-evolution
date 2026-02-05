import { exec } from './exec.mjs';
import { startSpan } from './tracing.mjs';
import { runCounter } from './counter.mjs';

export function analyzeCommits(repoDir, commits, existingResults = [], options) {
  const { emitProgress, jsonProgress, counterTool } = options;
  const span = startSpan('analyzer.analyze_commits', {
    'analyzer.commits.new': commits.length,
    'analyzer.commits.existing': existingResults.length
  });

  if (!jsonProgress) {
    console.log(`\n🔍 Analyzing ${commits.length} commits...\n`);
  }

  const results = [...existingResults];
  const allLanguages = new Set();

  for (const result of existingResults) {
    Object.keys(result.languages).forEach(lang => allLanguages.add(lang));
  }

  const startTime = Date.now();
  const totalCommits = commits.length;

  try {
    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i];
      const progress = `[${i + 1}/${commits.length}]`;

      const commitProgress = 15 + Math.floor((i / totalCommits) * 70);

      if (!jsonProgress) {
        process.stdout.write(`${progress} ${commit.hash.substring(0, 8)} (${commit.date})...`);
      }

      emitProgress('analyzing', commitProgress, `Analyzing commit ${i + 1} of ${totalCommits}`, {
        current_commit: i + 1,
        total_commits: totalCommits,
        commit_hash: commit.hash.substring(0, 8),
        commit_date: commit.date
      });

      exec(`git -C "${repoDir}" checkout -q ${commit.hash}`, { silent: true });

      const counterData = runCounter(repoDir, { tool: counterTool, emitProgress, jsonProgress });

      Object.keys(counterData.languages).forEach(lang => allLanguages.add(lang));

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

      if (!jsonProgress) {
        process.stdout.write(' ✓\n');
      }
    }

    const elapsedSeconds = (Date.now() - startTime) / 1000;

    if (commits.length > 0) {
      if (!jsonProgress) {
        console.log(`\n✓ Analysis complete (${elapsedSeconds.toFixed(2)}s)`);
        console.log(`📊 Languages found: ${Array.from(allLanguages).sort().join(', ')}`);
      }
      emitProgress('analyzing', 85, 'Analysis complete', {
        elapsed_seconds: elapsedSeconds,
        languages: Array.from(allLanguages).sort()
      });
    }

    if (results.length === 0) {
      span.setAttributes({
        'analyzer.languages.count': 0,
        'analyzer.total_lines': 0,
        'analyzer.duration_seconds': elapsedSeconds
      });
      span.setStatus('ok');

      return {
        results: [],
        allLanguages: [],
        analysisTime: elapsedSeconds
      };
    }

    const finalCommit = results[results.length - 1];
    let totalLinesInFinal = 0;
    for (const lang in finalCommit.languages) {
      totalLinesInFinal += finalCommit.languages[lang].code;
    }

    const languageOrder = Array.from(allLanguages).sort((a, b) => {
      const linesA = finalCommit.languages[a]?.code || 0;
      const linesB = finalCommit.languages[b]?.code || 0;
      const percA = totalLinesInFinal > 0 ? (linesA / totalLinesInFinal) : 0;
      const percB = totalLinesInFinal > 0 ? (linesB / totalLinesInFinal) : 0;

      if (percB !== percA) {
        return percB - percA;
      }
      return a.localeCompare(b);
    });

    span.setAttributes({
      'analyzer.languages.count': allLanguages.size,
      'analyzer.total_lines': totalLinesInFinal,
      'analyzer.duration_seconds': elapsedSeconds
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
