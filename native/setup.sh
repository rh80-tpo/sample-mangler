#!/usr/bin/env bash
# Fetch JUCE. Not vendored into git: it is a 100MB upstream checkout.
set -euo pipefail
cd "$(dirname "$0")"
if [ -d vendor/JUCE ]; then
  echo "JUCE already present at native/vendor/JUCE"
  exit 0
fi
mkdir -p vendor
git clone --depth 1 --branch 8.0.4 https://github.com/juce-framework/JUCE.git vendor/JUCE
echo "JUCE 8.0.4 fetched."
