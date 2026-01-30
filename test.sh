#!/bin/bash

# Quick test script to verify the analyzer works
# Tests on a small public repository

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_OUTPUT="/tmp/cloc-analyzer-test-$$"
TEST_REPO="https://github.com/octocat/Hello-World"

echo "🧪 Testing CLOC History Analyzer"
echo "================================"
echo ""

# Check prerequisites
echo "Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "❌ git not found"; exit 1; }
command -v scc >/dev/null 2>&1 || command -v cloc >/dev/null 2>&1 || { echo "❌ scc or cloc not found"; exit 1; }
echo "✓ All prerequisites found"
echo ""

# Run analyzer on small test repo
echo "Running analyzer on test repository..."
node "$SCRIPT_DIR/analyze.mjs" \
  "$TEST_REPO" \
  "$TEST_OUTPUT"

echo ""
echo "Verifying output files..."
[ -f "$TEST_OUTPUT/data.json" ] || { echo "❌ data.json not found"; exit 1; }
[ -f "$TEST_OUTPUT/visualization.html" ] || { echo "❌ visualization.html not found"; exit 1; }

# Check file sizes
DATA_SIZE=$(stat -f%z "$TEST_OUTPUT/data.json" 2>/dev/null || stat -c%s "$TEST_OUTPUT/data.json")
HTML_SIZE=$(stat -f%z "$TEST_OUTPUT/visualization.html" 2>/dev/null || stat -c%s "$TEST_OUTPUT/visualization.html")

[ "$DATA_SIZE" -gt 100 ] || { echo "❌ data.json too small"; exit 1; }
[ "$HTML_SIZE" -gt 1000 ] || { echo "❌ visualization.html too small"; exit 1; }

echo "✓ data.json: $DATA_SIZE bytes"
echo "✓ visualization.html: $HTML_SIZE bytes"
echo ""

# Validate JSON structure
echo "Validating JSON structure..."
node -e "
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync('$TEST_OUTPUT/data.json', 'utf8'));
  if (!data.results || !Array.isArray(data.results)) {
    console.error('❌ Invalid JSON structure: missing results array');
    process.exit(1);
  }
  if (!data.allLanguages || !Array.isArray(data.allLanguages)) {
    console.error('❌ Invalid JSON structure: missing allLanguages array');
    process.exit(1);
  }
  console.log('✓ Valid JSON structure');
  console.log('✓ Commits analyzed:', data.results.length);
  console.log('✓ Languages found:', data.allLanguages.join(', '));
"
echo ""

# Cleanup
echo "Cleaning up test output..."
rm -rf "$TEST_OUTPUT"
echo "✓ Cleanup complete"
echo ""

echo "✅ All tests passed!"
echo ""
echo "You can now run the analyzer on any repository:"
echo "  node $SCRIPT_DIR/analyze.mjs <git-repo-url> [output-dir]"
