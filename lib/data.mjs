import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { computeAudioData } from './audio.mjs';

export function loadExistingData(outputDir, options) {
  const { schemaVersion, emitProgress, jsonProgress } = options;
  const dataFile = join(outputDir, 'data.json');

  if (!existsSync(dataFile)) {
    return null;
  }

  try {
    const content = readFileSync(dataFile, 'utf8');
    const data = JSON.parse(content);

    if (!data.schema_version) {
      if (!jsonProgress) {
        console.log('⚠ Warning: Found old data format (v1.0), will regenerate from scratch');
      } else {
        emitProgress('validating', 1, 'Found old data format (v1.0), regenerating');
      }
      return null;
    }

    if (data.schema_version !== schemaVersion) {
      if (!jsonProgress) {
        console.log(`⚠ Warning: Data schema mismatch (found ${data.schema_version}, expected ${schemaVersion})`);
        console.log('  Will regenerate from scratch');
      } else {
        emitProgress('validating', 1, 'Data schema mismatch, regenerating', {
          found_schema: data.schema_version,
          expected_schema: schemaVersion
        });
      }
      return null;
    }

    return data;
  } catch (error) {
    if (!jsonProgress) {
      console.log(`⚠ Warning: Could not load existing data - ${error.message}`);
    } else {
      emitProgress('validating', 1, 'Could not load existing data, regenerating', {
        error: error.message
      });
    }
    return null;
  }
}

export function createDataStructure(repoUrl, results, allLanguages, analysisTime, counterInfo, options) {
  const { counterTool, schemaVersion } = options;
  const lastCommit = results.length > 0 ? results[results.length - 1] : null;

  const audioData = computeAudioData(results, allLanguages);

  return {
    schema_version: schemaVersion,
    metadata: {
      repository_url: repoUrl,
      analyzed_at: new Date().toISOString(),
      total_commits: results.length,
      total_duration_seconds: analysisTime,
      counter_tool: counterInfo?.tool || counterTool,
      counter_version: counterInfo?.version || 'unknown',
      cloc_version: counterInfo?.version || 'unknown',
      last_commit_hash: lastCommit ? lastCommit.commit : null,
      last_commit_date: lastCommit ? lastCommit.date : null
    },
    results,
    allLanguages,
    audioData
  };
}
