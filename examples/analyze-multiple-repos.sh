#!/bin/bash

# Example: Analyze multiple repositories and generate dashboard
# This script demonstrates analyzing several repos and organizing outputs

echo "📊 Multi-Repository Analysis Example"
echo "====================================="
echo

# Define repositories to analyze
REPOS=(
  "https://github.com/kelseyhightower/nocode"
  "https://github.com/sindresorhus/is"
)

OUTPUT_DIR="./example-output"

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Analyze each repository
for repo in "${REPOS[@]}"; do
  # Extract repository name
  name=$(basename "$repo" .git)
  output="$OUTPUT_DIR/$name"
  
  echo "Analyzing: $name"
  echo "Repository: $repo"
  echo "Output: $output"
  echo
  
  # Run analyzer
  node ../analyze.mjs "$repo" "$output"
  
  echo
  echo "✓ Completed: $name"
  echo "  View: $output/visualization.html"
  echo
  echo "---"
  echo
done

echo "✅ All repositories analyzed!"
echo
echo "Results:"
for repo in "${REPOS[@]}"; do
  name=$(basename "$repo" .git)
  echo "  - $name: $OUTPUT_DIR/$name/visualization.html"
done
echo
echo "Open the HTML files in your browser to view the visualizations."
