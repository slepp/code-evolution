#!/bin/bash

# Test runner for Code Evolution Analyzer
# Runs both unit and integration tests

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🧪 Code Evolution Analyzer Test Suite"
echo "===================================="
echo ""

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
  echo "❌ Node.js 16+ required for built-in test runner"
  echo "   Current version: $(node --version)"
  exit 1
fi

# Check prerequisites
echo "Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "❌ git not found"; exit 1; }

# Check for code counter (scc or cloc)
if command -v scc >/dev/null 2>&1; then
  echo "✓ scc found ($(scc --version | head -1))"
elif command -v cloc >/dev/null 2>&1; then
  echo "✓ cloc found ($(cloc --version | head -1))"
else
  echo "❌ Neither scc nor cloc found"
  echo "   Install scc: https://github.com/boyter/scc#install"
  echo "   Or install cloc: https://github.com/AlDanial/cloc"
  exit 1
fi

echo "✓ Node.js $(node --version)"
echo "✓ Git $(git --version | cut -d' ' -f3)"
echo ""

# Run unit tests
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Running Unit Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if node --test "$SCRIPT_DIR/unit.test.mjs"; then
  echo ""
  echo "✅ Unit tests passed"
else
  echo ""
  echo "❌ Unit tests failed"
  exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Running Integration Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if node --test "$SCRIPT_DIR/integration.test.mjs"; then
  echo ""
  echo "✅ Integration tests passed"
else
  echo ""
  echo "❌ Integration tests failed"
  exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All tests passed!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
