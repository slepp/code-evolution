import { EXCLUDE_DIRS } from './constants.mjs';
import { exec } from './exec.mjs';

function emptyAnalysis(tool) {
  return {
    languages: {},
    analysis: {
      elapsed_seconds: 0,
      n_files: 0,
      n_lines: 0,
      files_per_second: 0,
      lines_per_second: 0,
      counter_tool: tool,
      counter_version: 'unknown'
    }
  };
}

function runScc(repoDir, { emitProgress, jsonProgress }) {
  try {
    const startTime = Date.now();

    const excludeArgs = EXCLUDE_DIRS.map(d => `--exclude-dir "${d}"`).join(' ');

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

    let totalFiles = 0;
    let totalLines = 0;

    const languages = {};
    for (const entry of data) {
      const langName = entry.Name;

      languages[langName] = {
        files: entry.Count || 0,
        blank: entry.Blank || 0,
        comment: entry.Comment || 0,
        code: entry.Code || 0,
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
      counter_version: '3.x'
    };

    return { languages, analysis };
  } catch (error) {
    if (!jsonProgress) {
      console.error(`    ⚠ Warning: scc failed - ${error.message}`);
    } else {
      emitProgress('analyzing', 0, 'scc failed', { error: error.message });
    }
    return emptyAnalysis('scc');
  }
}

function runCloc(repoDir, { emitProgress, jsonProgress }) {
  try {
    const excludeDirs = EXCLUDE_DIRS.join(',');
    const result = exec(
      `cloc "${repoDir}" --json --quiet --exclude-dir=${excludeDirs}`,
      { silent: true, ignoreError: true }
    );

    if (!result) {
      return emptyAnalysis('cloc');
    }

    const data = JSON.parse(result);

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
    if (!jsonProgress) {
      console.error(`    ⚠ Warning: cloc failed - ${error.message}`);
    } else {
      emitProgress('analyzing', 0, 'cloc failed', { error: error.message });
    }
    return emptyAnalysis('cloc');
  }
}

export function runCounter(repoDir, { tool, emitProgress, jsonProgress }) {
  if (tool === 'scc') {
    return runScc(repoDir, { emitProgress, jsonProgress });
  }
  return runCloc(repoDir, { emitProgress, jsonProgress });
}
