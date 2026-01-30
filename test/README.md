# CLOC History Analyzer - Test Suite

This directory contains unit and integration tests for the CLOC History Analyzer.

## Test Structure

```
test/
├── unit.test.mjs          # Unit tests for individual components
├── integration.test.mjs   # Integration tests for full workflows
├── run-tests.sh          # Main test runner script
└── README.md             # This file
```

## Running Tests

### All Tests

Run the complete test suite:

```bash
npm test
# or
./test/run-tests.sh
```

### Unit Tests Only

```bash
node --test test/unit.test.mjs
```

### Integration Tests Only

```bash
node --test test/integration.test.mjs
```

## Requirements

- **Node.js 16+** (for built-in test runner)
- **Git** (for cloning repositories)
- **scc** or **cloc** (for code counting)

Install scc (recommended - faster):
- https://github.com/boyter/scc#install

Or install cloc:
- https://github.com/AlDanial/cloc

## Test Coverage

### Unit Tests

Tests for individual components and data structures:

- ✅ Data structure validation (schema, fields, types)
- ✅ Audio data generation and proportions
- ✅ HTML generation and embedding
- ✅ Audio frequency calculations (C3 base note)
- ✅ Incremental update metadata
- ✅ Edge cases (empty data, single commit, zero values)
- ✅ HTML escaping and security
- ✅ File operations

### Integration Tests

Tests for complete workflows:

- ✅ End-to-end repository analysis
- ✅ Incremental update workflow
- ✅ Force-full analysis mode
- ✅ Error handling (invalid repos, missing args)
- ✅ Output file validation (data.json, visualization.html)
- ✅ Audio data validation (proportions, frame count)
- ✅ HTML structure and content validation

## Test Data

Integration tests use the [kelseyhightower/nocode](https://github.com/kelseyhightower/nocode) repository as a test case:
- Small repository (4 commits)
- Fast to clone and analyze
- Stable history (no new commits expected)
- Perfect for testing

## Writing New Tests

Tests use Node.js's built-in test runner (available in Node 16+):

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('My Feature', () => {
  test('should do something', async () => {
    const result = doSomething();
    assert.strictEqual(result, expectedValue);
  });
});
```

### Best Practices

1. **Isolate tests**: Each test should be independent
2. **Clean up**: Remove temporary files/directories after tests
3. **Use descriptive names**: Test names should explain what is being tested
4. **Test edge cases**: Include tests for empty data, errors, boundary conditions
5. **Validate structure**: Check both that fields exist AND have correct types
6. **Use assertions**: Prefer strict equality (`strictEqual`) over loose equality

## Continuous Integration

These tests can be integrated into CI/CD pipelines:

### GitHub Actions Example

```yaml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - name: Install scc
        run: |
          wget https://github.com/boyter/scc/releases/download/v3.1.0/scc_3.1.0_Linux_x86_64.tar.gz
          tar xzf scc_3.1.0_Linux_x86_64.tar.gz
          sudo mv scc /usr/local/bin/
      - name: Run tests
        run: npm test
```

## Debugging Tests

Run tests with verbose output:

```bash
node --test --test-reporter=spec test/unit.test.mjs
```

Run a specific test:

```bash
node --test --test-name-pattern="audio frequency" test/unit.test.mjs
```

## Skipping Tests

Skip slow integration tests during development:

```bash
node --test test/unit.test.mjs
```

## Test Output

Successful run:
```
✓ Data structure validation (12.3ms)
✓ Audio data generation (5.1ms)
✓ HTML generation (8.7ms)
...
✅ All tests passed!
```

Failed run:
```
✗ Audio frequency calculation (10.2ms)
  AssertionError: Expected 130.81, got 131.00
  
❌ Tests failed
```
