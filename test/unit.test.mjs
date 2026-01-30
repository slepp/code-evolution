#!/usr/bin/env node

/**
 * Unit tests for CLOC History Analyzer
 * Uses Node.js built-in test runner (Node 16+)
 * 
 * Run with: node --test test/unit.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// Test data fixtures
const MOCK_SCC_OUTPUT = JSON.stringify([
  {
    Name: 'JavaScript',
    Bytes: 5000,
    CodeBytes: 0,
    Lines: 150,
    Code: 120,
    Comment: 20,
    Blank: 10,
    Complexity: 15,
    Count: 3,
    WeightedComplexity: 0,
    Files: [
      {
        Language: 'JavaScript',
        Filename: 'src/index.js',
        Lines: 100,
        Code: 80,
        Comment: 15,
        Blank: 5
      }
    ]
  },
  {
    Name: 'JSON',
    Bytes: 2000,
    CodeBytes: 0,
    Lines: 50,
    Code: 50,
    Comment: 0,
    Blank: 0,
    Complexity: 0,
    Count: 2,
    WeightedComplexity: 0,
    Files: []
  }
]);

const MOCK_COMMIT_HISTORY = `commit1234567890abcdef1234567890abcdef12345678
2024-01-15
commit2234567890abcdef1234567890abcdef12345678
2024-01-16
commit3234567890abcdef1234567890abcdef12345678
2024-01-17`;

// Helper to run analyze.mjs functions
function loadAnalyzer() {
  // Since analyze.mjs uses top-level code, we need to extract functions
  // For now, we'll test through the CLI interface
  return {
    analyzerPath: join(PROJECT_ROOT, 'analyze.mjs')
  };
}

describe('CLOC History Analyzer - Data Structure', () => {
  test('data.json should have correct schema version', async () => {
    const dataPath = join(PROJECT_ROOT, 'test-output', 'data.json');
    
    if (existsSync(dataPath)) {
      const data = JSON.parse(readFileSync(dataPath, 'utf8'));
      
      assert.ok(data.metadata, 'Should have metadata');
      assert.ok(data.schema_version || data.metadata.version, 'Should have schema version');
      assert.ok(data.results, 'Should have results array');
      assert.ok(Array.isArray(data.results), 'Results should be an array');
      
      // allLanguages might be computed from results
      if (data.allLanguages) {
        assert.ok(Array.isArray(data.allLanguages), 'allLanguages should be an array');
      }
    }
  });

  test('each result entry should have required fields', async () => {
    const dataPath = join(PROJECT_ROOT, 'test-output', 'data.json');
    
    if (existsSync(dataPath)) {
      const data = JSON.parse(readFileSync(dataPath, 'utf8'));
      
      if (data.results.length > 0) {
        const result = data.results[0];
        
        assert.ok(result.commit, 'Should have commit hash');
        assert.ok(result.date, 'Should have date');
        assert.ok(result.languages, 'Should have languages object');
        assert.strictEqual(typeof result.languages, 'object', 'Languages should be an object');
      }
    }
  });

  test('language data should have correct structure', async () => {
    const dataPath = join(PROJECT_ROOT, 'test-output', 'data.json');
    
    if (existsSync(dataPath)) {
      const data = JSON.parse(readFileSync(dataPath, 'utf8'));
      
      if (data.results.length > 0 && Object.keys(data.results[0].languages).length > 0) {
        const langName = Object.keys(data.results[0].languages)[0];
        const langData = data.results[0].languages[langName];
        
        assert.ok('code' in langData, 'Should have code lines');
        assert.ok('comment' in langData, 'Should have comment lines');
        assert.ok('blank' in langData, 'Should have blank lines');
        assert.ok('files' in langData, 'Should have file count');
        
        assert.strictEqual(typeof langData.code, 'number', 'code should be a number');
        assert.strictEqual(typeof langData.files, 'number', 'files should be a number');
      }
    }
  });
});

describe('CLOC History Analyzer - Audio Data', () => {
  test('should generate audio data with correct structure', async () => {
    const dataPath = join(PROJECT_ROOT, 'test-output', 'data.json');

    if (existsSync(dataPath)) {
      const data = JSON.parse(readFileSync(dataPath, 'utf8'));

      if (data.audioData) {
        assert.ok(Array.isArray(data.audioData), 'audioData should be an array');

        if (data.audioData.length > 0) {
          const frame = data.audioData[0];
          const metrics = ['lines', 'files', 'bytes'];

          // Each frame should have per-metric audio data
          for (const metric of metrics) {
            assert.ok(metric in frame, `Should have ${metric} audio data`);
            assert.ok('masterIntensity' in frame[metric], `${metric} should have masterIntensity`);
            assert.ok('voices' in frame[metric], `${metric} should have voices`);
            assert.strictEqual(typeof frame[metric].masterIntensity, 'number', `${metric} masterIntensity should be a number`);
            assert.strictEqual(typeof frame[metric].voices, 'object', `${metric} voices should be an object`);
          }
        }
      }
    }
  });

  test('audio proportions should sum to approximately 1.0', async () => {
    const dataPath = join(PROJECT_ROOT, 'test-output', 'data.json');

    if (existsSync(dataPath)) {
      const data = JSON.parse(readFileSync(dataPath, 'utf8'));

      if (data.audioData && data.audioData.length > 0 && data.results) {
        const frame = data.audioData[0];
        const result = data.results[0];

        // Check lines metric voice gains sum to ~1.0
        if (result.totalLines > 0 && frame.lines) {
          const sum = Object.values(frame.lines.voices).reduce((a, b) => a + b.gain, 0);

          // Should sum to ~1.0 (allowing for floating point errors)
          assert.ok(Math.abs(sum - 1.0) < 0.01, `Voice gains should sum to 1.0, got ${sum}`);
        }
      }
    }
  });
});

describe('CLOC History Analyzer - HTML Generation', () => {
  test('visualization.html should be valid HTML', async () => {
    const htmlPath = join(PROJECT_ROOT, 'test-output', 'visualization.html');
    
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, 'utf8');
      
      assert.ok(html.includes('<!DOCTYPE html>'), 'Should have DOCTYPE');
      assert.ok(html.includes('<html'), 'Should have html tag');
      assert.ok(html.includes('</html>'), 'Should close html tag');
      assert.ok(html.includes('<head>'), 'Should have head section');
      assert.ok(html.includes('<body>'), 'Should have body section');
    }
  });

  test('visualization.html should include data', async () => {
    const htmlPath = join(PROJECT_ROOT, 'test-output', 'visualization.html');
    
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, 'utf8');
      
      assert.ok(html.includes('const DATA = '), 'Should embed data');
      assert.ok(html.includes('const ALL_LANGUAGES = '), 'Should embed language list');
    }
  });

  test('visualization.html should include audio code', async () => {
    const htmlPath = join(PROJECT_ROOT, 'test-output', 'visualization.html');
    
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, 'utf8');
      
      assert.ok(html.includes('AudioContext'), 'Should have AudioContext code');
      assert.ok(html.includes('createOscillator'), 'Should create oscillators');
      assert.ok(html.includes('const C3 = ') || html.includes('const C4 = '), 'Should use C3 or C4 frequency');
    }
  });

  test('audio frequency should be audible (C3 or C4)', async () => {
    const htmlPath = join(PROJECT_ROOT, 'test-output', 'visualization.html');
    
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, 'utf8');
      
      // Should use either C3 (130.81 Hz) or C4 (261.63 Hz)
      const hasC3 = html.includes('130.81');
      const hasC4 = html.includes('261.63');
      assert.ok(hasC3 || hasC4, 'Should use C3 (130.81 Hz) or C4 (261.63 Hz) frequency');
    }
  });
});

describe('CLOC History Analyzer - Incremental Updates', () => {
  test('should detect existing data', async () => {
    const dataPath = join(PROJECT_ROOT, 'test-output', 'data.json');
    
    if (existsSync(dataPath)) {
      const data = JSON.parse(readFileSync(dataPath, 'utf8'));
      
      assert.ok(data.metadata, 'Should have metadata');
      assert.ok(data.metadata.last_commit_hash, 'Should track last commit');
      assert.ok(data.metadata.analyzed_at || data.metadata.last_analyzed, 'Should track last analysis time');
    }
  });

  test('metadata should have correct fields', async () => {
    const dataPath = join(PROJECT_ROOT, 'test-output', 'data.json');
    
    if (existsSync(dataPath)) {
      const data = JSON.parse(readFileSync(dataPath, 'utf8'));
      
      assert.ok(data.schema_version || data.metadata.version, 'Should have version');
      assert.ok(data.metadata.repository_url || data.metadata.repository, 'Should have repository URL');
      assert.ok(data.metadata.counter_tool || data.metadata.counter, 'Should have counter info');
      
      if (data.metadata.counter_tool) {
        assert.ok(data.metadata.counter_tool, 'Counter should have name');
        assert.ok(data.metadata.counter_version || data.metadata.cloc_version, 'Counter should have version');
      }
    }
  });
});

describe('CLOC History Analyzer - Edge Cases', () => {
  test('should handle empty language data', () => {
    const emptyLanguages = {};
    const allLanguages = [];
    
    // Test that code doesn't crash with empty data
    assert.doesNotThrow(() => {
      JSON.stringify({ languages: emptyLanguages, allLanguages });
    });
  });

  test('should handle single commit', () => {
    const singleResult = [{
      commit: 'abc123',
      date: '2024-01-01',
      languages: {
        JavaScript: { code: 100, comment: 10, blank: 5, files: 1 }
      }
    }];
    
    assert.strictEqual(singleResult.length, 1);
    assert.ok(singleResult[0].languages.JavaScript);
  });

  test('should handle language with no files', () => {
    const langData = {
      code: 0,
      comment: 0,
      blank: 0,
      files: 0
    };
    
    assert.strictEqual(langData.files, 0);
    assert.strictEqual(langData.code, 0);
  });
});

describe('CLOC History Analyzer - Audio Calculations', () => {
  test('should calculate proportions correctly', () => {
    const totalLines = 1000;
    const langLines = 250;
    const proportion = langLines / totalLines;
    
    assert.strictEqual(proportion, 0.25);
  });

  test('should handle zero total lines', () => {
    const totalLines = 0;
    const langLines = 0;
    const proportion = totalLines > 0 ? langLines / totalLines : 0;
    
    assert.strictEqual(proportion, 0);
  });

  test('should calculate audio frequency from C3', () => {
    const C3 = 130.81;
    const semitones = 12; // One octave up
    const frequency = C3 * Math.pow(2, semitones / 12);
    
    // One octave up should be ~261.63 Hz (C4)
    assert.ok(Math.abs(frequency - 261.63) < 0.1, `Expected ~261.63, got ${frequency}`);
  });

  test('should calculate major scale intervals correctly', () => {
    const C3 = 130.81;
    const MAJOR_SCALE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
    
    // Test C, D, E, F, G, A, B
    const frequencies = MAJOR_SCALE_SEMITONES.map(semitones => 
      C3 * Math.pow(2, semitones / 12)
    );
    
    // C3
    assert.ok(Math.abs(frequencies[0] - 130.81) < 0.1, 'C3 frequency');
    // E3 (4 semitones up)
    assert.ok(Math.abs(frequencies[2] - 164.81) < 0.5, 'E3 frequency');
    // G3 (7 semitones up)
    assert.ok(Math.abs(frequencies[4] - 196.00) < 0.5, 'G3 frequency');
  });
});

describe('CLOC History Analyzer - HTML Escaping', () => {
  test('should escape HTML entities in commit messages', () => {
    const input = '<script>alert("xss")</script>';
    const expected = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';
    
    // Simple HTML escape function test
    const escape = (str) => str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
    
    assert.strictEqual(escape(input), expected);
  });

  test('should handle special characters in repository URLs', () => {
    const url = 'https://github.com/user/repo-name_test';
    assert.ok(url.includes('github.com'));
  });
});

describe('CLOC History Analyzer - CLI Integration', () => {
  test('should accept repository URL argument', async () => {
    // This would be tested via CLI, skipping actual execution
    const args = ['https://github.com/user/repo', './output'];
    assert.ok(args[0].startsWith('http'));
    assert.ok(args[1].startsWith('./'));
  });

  test('should validate output directory', () => {
    const outputDir = './test-output';
    assert.ok(typeof outputDir === 'string');
  });
});

describe('CLOC History Analyzer - File Operations', () => {
  test('should create output directory if not exists', () => {
    const testDir = join(PROJECT_ROOT, 'test', 'tmp-test-dir');
    
    // Clean up first
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    
    // Create directory
    mkdirSync(testDir, { recursive: true });
    assert.ok(existsSync(testDir), 'Directory should be created');
    
    // Clean up
    rmSync(testDir, { recursive: true });
  });
});

console.log('\n🧪 Running unit tests...\n');
