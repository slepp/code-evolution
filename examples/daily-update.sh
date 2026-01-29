#!/bin/bash

# Example: Daily update script for CI/CD
# Demonstrates incremental updates for fast daily metrics

REPO_URL="https://github.com/kelseyhightower/nocode"
OUTPUT_DIR="./daily-metrics"

echo "📊 Daily Metrics Update"
echo "======================="
echo

# Check if this is first run or update
if [ -f "$OUTPUT_DIR/data.json" ]; then
  echo "🔄 Incremental update mode"
  echo "Existing data found - will only analyze new commits"
else
  echo "🆕 First run - full analysis"
fi

echo

# Run analyzer (automatically detects incremental vs full)
node ../analyze.mjs "$REPO_URL" "$OUTPUT_DIR"

echo
echo "✅ Daily update complete!"
echo "📊 View: $OUTPUT_DIR/visualization.html"

# Optional: Deploy to hosting (GitHub Pages, S3, etc.)
# Example for GitHub Pages:
# git add $OUTPUT_DIR/*
# git commit -m "Update metrics $(date +%Y-%m-%d)"
# git push

# Example for S3:
# aws s3 sync $OUTPUT_DIR s3://my-bucket/metrics/ --acl public-read
