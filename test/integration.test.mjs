#!/usr/bin/env node

/**
 * Integration tests for Code Evolution Analyzer
 * Tests the full workflow from git clone to HTML generation
 * 
 * Run with: node test/integration.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execSync, spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// Test configuration
const TEST_REPO = 'https://github.com/octocat/Hello-World';
const TEST_OUTPUT = join(PROJECT_ROOT, 'test', 'integration-output');

// Helper to run analyzer
function runAnalyzer(args = [], timeout = 60000) {
  const analyzerPath = join(PROJECT_ROOT, 'analyze.mjs');
  const fullArgs = [analyzerPath, ...args];
  
  try {
    const result = execSync(`node ${fullArgs.join(' ')}`, {
      cwd: PROJECT_ROOT,
      timeout,
      stdio: 'pipe',
      encoding: 'utf8'
    });
    return { success: true, output: result };
  } catch (error) {
    return { success: false, error: error.message, output: error.stdout || '' };
  }
}

describe('Integration Tests - Full Workflow', () => {
  test('should analyze a repository end-to-end', async (t) => {
    // Clean up any previous test output
    if (existsSync(TEST_OUTPUT)) {
      rmSync(TEST_OUTPUT, { recursive: true });
    }

    // Run analyzer
    const result = runAnalyzer([TEST_REPO, TEST_OUTPUT], 120000);
    
    if (!result.success) {
      console.log('Analyzer output:', result.output);
      console.log('Error:', result.error);
    }
    
    assert.ok(result.success, 'Analyzer should complete successfully');
    
    // Verify output files exist
    const dataPath = join(TEST_OUTPUT, 'data.json');
    const htmlPath = join(TEST_OUTPUT, 'visualization.html');
    
    assert.ok(existsSync(dataPath), 'data.json should be created');
    assert.ok(existsSync(htmlPath), 'visualization.html should be created');
    
    // Verify data.json structure
    const data = JSON.parse(readFileSync(dataPath, 'utf8'));
    assert.ok(data.results, 'Should have results');
    assert.ok(Array.isArray(data.results), 'Results should be an array');
    assert.ok(data.results.length > 0, 'Should have at least one result');
    assert.ok(data.allLanguages, 'Should have allLanguages');
    assert.ok(Array.isArray(data.allLanguages), 'allLanguages should be an array');
    
    // Verify HTML content
    const html = readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('<!DOCTYPE html>'), 'HTML should be valid');
    assert.ok(html.includes('Code Evolution'), 'HTML should have title');
    assert.ok(html.includes('const DATA = '), 'HTML should embed data');
    
    console.log(`✓ Successfully analyzed ${data.results.length} commits`);
    console.log(`✓ Found languages: ${data.allLanguages.join(', ')}`);
  });

  test('should support incremental updates', async (t) => {
    // Ensure test output exists from previous test
    const dataPath = join(TEST_OUTPUT, 'data.json');
    const localRepo = join(TEST_OUTPUT, 'cloc-history');

    if (existsSync(dataPath) && existsSync(localRepo)) {
      const dataBefore = JSON.parse(readFileSync(dataPath, 'utf8'));
      const commitsBefore = dataBefore.results.length;

      // Run again (should be incremental)
      const result = runAnalyzer([TEST_REPO, TEST_OUTPUT, '--local-repo', localRepo], 60000);

      assert.ok(result.success, 'Incremental update should succeed');

      const dataAfter = JSON.parse(readFileSync(dataPath, 'utf8'));

      // Should have same number of commits (stable test repo)
      assert.strictEqual(dataAfter.results.length, commitsBefore, 'Commit count should be stable');

      console.log(`✓ Incremental update verified (${commitsBefore} commits)`);
    } else {
      // Local repo was cleaned up, skip this test
      t.skip('Local repo not available (cleaned up by previous test run)');
    }
  });

  test('should handle --force-full flag', async (t) => {
    if (existsSync(TEST_OUTPUT)) {
      const result = runAnalyzer([TEST_REPO, TEST_OUTPUT, '--force-full'], 120000);
      
      // Should succeed even with existing data
      assert.ok(result.output.includes('Full analysis') || result.success, 'Should perform full analysis');
    }
  });
});

describe('Integration Tests - Error Handling', () => {
  test('should handle invalid repository URL', async (t) => {
    const invalidOutput = join(PROJECT_ROOT, 'test', 'invalid-output');
    const result = runAnalyzer(['https://github.com/nonexistent/fakerepo12345', invalidOutput], 30000);
    
    // Should fail gracefully
    assert.ok(!result.success || result.output.includes('Error') || result.output.includes('Failed'), 
      'Should report error for invalid repo');
    
    // Clean up
    if (existsSync(invalidOutput)) {
      rmSync(invalidOutput, { recursive: true });
    }
  });

  test('should validate required arguments', async (t) => {
    const result = runAnalyzer([], 5000);
    
    // Should show usage or error
    assert.ok(result.output.includes('Usage') || result.output.includes('usage') || !result.success,
      'Should show usage when no arguments provided');
  });
});

describe('Integration Tests - Output Validation', () => {
  test('data.json should have valid metadata', async (t) => {
    const dataPath = join(TEST_OUTPUT, 'data.json');

    if (existsSync(dataPath)) {
      const data = JSON.parse(readFileSync(dataPath, 'utf8'));

      assert.ok(data.metadata, 'Should have metadata');
      assert.ok(data.schema_version, 'Should have schema_version');
      assert.ok(data.metadata.repository_url, 'Should have repository URL');
      assert.ok(data.metadata.analyzed_at, 'Should have analyzed_at timestamp');
      assert.ok(data.metadata.last_commit_hash, 'Should have last_commit_hash');
      assert.ok(data.metadata.counter_tool, 'Should have counter_tool');

      console.log(`✓ Metadata validated`);
      console.log(`  Schema: ${data.schema_version}`);
      console.log(`  Counter: ${data.metadata.counter_tool} ${data.metadata.counter_version}`);
    }
  });

  test('each commit should have complete language data', async (t) => {
    const dataPath = join(TEST_OUTPUT, 'data.json');
    
    if (existsSync(dataPath)) {
      const data = JSON.parse(readFileSync(dataPath, 'utf8'));
      
      for (const result of data.results) {
        assert.ok(result.commit, 'Each result should have commit hash');
        assert.ok(result.date, 'Each result should have date');
        assert.ok(result.languages, 'Each result should have languages');
        assert.strictEqual(typeof result.languages, 'object', 'Languages should be object');
        
        // Validate each language entry
        for (const [lang, stats] of Object.entries(result.languages)) {
          assert.ok('code' in stats, `${lang} should have code count`);
          assert.ok('comment' in stats, `${lang} should have comment count`);
          assert.ok('blank' in stats, `${lang} should have blank count`);
          assert.ok('files' in stats, `${lang} should have file count`);
          
          assert.ok(typeof stats.code === 'number', 'code should be number');
          assert.ok(typeof stats.files === 'number', 'files should be number');
        }
      }
      
      console.log(`✓ Validated ${data.results.length} commit entries`);
    }
  });

  test('audio data should be generated correctly', async (t) => {
    const dataPath = join(TEST_OUTPUT, 'data.json');

    if (existsSync(dataPath)) {
      const data = JSON.parse(readFileSync(dataPath, 'utf8'));

      if (data.audioData) {
        assert.ok(Array.isArray(data.audioData), 'audioData should be array');
        assert.strictEqual(data.audioData.length, data.results.length,
          'audioData should match results length');

        const metrics = ['lines', 'files', 'bytes'];

        for (let i = 0; i < data.audioData.length; i++) {
          const frame = data.audioData[i];
          const result = data.results[i];

          // Each frame should have audio data for all metrics
          // Optimized sparse format: [masterIntensity, [langIndex, gain, detune], ...]
          for (const metric of metrics) {
            assert.ok(metric in frame, `Frame should have ${metric} audio data`);
            const metricData = frame[metric];

            assert.ok(Array.isArray(metricData), `${metric} should be array (sparse format)`);
            assert.ok(metricData.length >= 1, `${metric} should have at least masterIntensity`);

            const masterIntensity = metricData[0];
            assert.ok(typeof masterIntensity === 'number', `${metric} masterIntensity should be number`);
            assert.ok(masterIntensity >= 0 && masterIntensity <= 1,
              `${metric} masterIntensity should be 0-1`);

            // Validate voice entries (sparse format: [langIndex, gain, detune])
            for (let j = 1; j < metricData.length; j++) {
              const voice = metricData[j];
              assert.ok(Array.isArray(voice) && voice.length === 3,
                `Voice should be [langIndex, gain, detune]`);
              assert.ok(typeof voice[0] === 'number', 'langIndex should be number');
              assert.ok(typeof voice[1] === 'number', 'gain should be number');
              assert.ok(typeof voice[2] === 'number', 'detune should be number');
            }
          }

          // Validate voice gains sum to ~1.0 for lines metric (when there are lines)
          if (result.totalLines > 0 && frame.lines.length > 1) {
            const gainSum = frame.lines.slice(1).reduce((sum, v) => sum + v[1], 0);
            assert.ok(Math.abs(gainSum - 1.0) < 0.02,
              `Voice gains should sum to ~1.0 at frame ${i}, got ${gainSum}`);
          }
        }

        console.log(`✓ Audio data validated for ${data.audioData.length} frames (sparse format)`);
      }

      // Validate pre-computed totals in results (schema 2.2+)
      for (const result of data.results) {
        assert.ok('totalLines' in result, 'Result should have totalLines');
        assert.ok('totalFiles' in result, 'Result should have totalFiles');
        assert.ok('totalBytes' in result, 'Result should have totalBytes');
        assert.ok(typeof result.totalLines === 'number', 'totalLines should be number');
        assert.ok(typeof result.totalFiles === 'number', 'totalFiles should be number');
        assert.ok(typeof result.totalBytes === 'number', 'totalBytes should be number');
      }

      console.log(`✓ Pre-computed totals validated for ${data.results.length} commits`);
    }
  });

  test('HTML should be well-formed and complete', async (t) => {
    const htmlPath = join(TEST_OUTPUT, 'visualization.html');
    
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, 'utf8');
      
      // Structure checks
      assert.ok(html.includes('<!DOCTYPE html>'), 'Should have DOCTYPE');
      assert.ok(html.match(/<html[^>]*>/), 'Should have opening html tag');
      assert.ok(html.includes('</html>'), 'Should have closing html tag');
      assert.ok(html.includes('<head>'), 'Should have head');
      assert.ok(html.includes('</head>'), 'Should close head');
      assert.ok(html.includes('<body>'), 'Should have body');
      assert.ok(html.includes('</body>'), 'Should close body');
      
      // Content checks
      assert.ok(html.includes('<title>'), 'Should have title');
      assert.ok(html.includes('Code Evolution'), 'Should have main heading');
      assert.ok(html.includes('const DATA = '), 'Should embed data');
      assert.ok(html.includes('const ALL_LANGUAGES = '), 'Should embed languages');
      
      // Audio checks
      assert.ok(html.includes('AudioContext'), 'Should have audio code');
      assert.ok(html.includes('130.81'), 'Should use C3 frequency (130.81 Hz)');
      assert.ok(html.includes('createOscillator'), 'Should create oscillators');
      
      // Control checks
      assert.ok(html.includes('Play'), 'Should have play button');
      assert.ok(html.includes('Pause') || html.includes('play/pause'), 'Should have pause control');
      assert.ok(html.includes('Volume') || html.includes('volume'), 'Should have volume control');
      
      const sizeKB = (html.length / 1024).toFixed(1);
      console.log(`✓ HTML validated (${sizeKB} KB)`);
    }
  });
});

// Cleanup after all tests
test('cleanup test artifacts', async (t) => {
  if (existsSync(TEST_OUTPUT)) {
    console.log('\n🧹 Cleaning up test output...');
    rmSync(TEST_OUTPUT, { recursive: true });
    console.log('✓ Cleanup complete\n');
  }
});

console.log('\n🧪 Running integration tests...');
console.log('This may take a few minutes as it clones and analyzes a real repository.\n');
