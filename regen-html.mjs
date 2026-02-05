#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Import the generateHTML function from analyze.mjs
// Since we can't easily extract it, we'll just re-run analyze with existing data

const dataPath = process.argv[2] || './express-output/data.json';
const repoUrl = process.argv[3] || 'https://github.com/expressjs/express';

console.log(`Reading data from: ${dataPath}`);
const data = JSON.parse(readFileSync(dataPath, 'utf8'));

console.log(`Loaded ${data.results.length} commits`);
console.log(`Schema version: ${data.schema_version}`);

// Re-run analyze.mjs on the local data to regenerate HTML
import('./analyze.mjs').then(module => {
  console.log('Module loaded, but generateHTML is not exported');
  console.log('We need to run the full analysis instead');
  process.exit(1);
});
