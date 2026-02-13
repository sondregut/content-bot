#!/bin/bash
# Generate all slideshow concepts

echo "🎬 Generating all Athlete Mindset TikTok slideshows..."
echo ""

concepts=("sports-psych-cost" "visualization-science" "breakthrough-story" "elite-secret" "before-after")

for concept in "${concepts[@]}"; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Generating: $concept"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  node generator.js "$concept"
  echo ""
  echo "⏳ Waiting 10 seconds before next slideshow (rate limiting)..."
  sleep 10
  echo ""
done

echo "✨ All slideshows generated!"
echo "📂 Check output/ directory for all slides"
