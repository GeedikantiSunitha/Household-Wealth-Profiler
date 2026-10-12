#!/bin/sh
# Serves the spreadsheet library from your own server instead of a public CDN.
# Version 0.20.3 fixes CVE-2023-30533 and CVE-2024-22363, which affect the
# 0.18.5 build on cdnjs that the app falls back to when this file is missing.
set -e
cd "$(dirname "$0")/.."
mkdir -p apps/web/public/vendor
curl -fsSL -o apps/web/public/vendor/xlsx.full.min.js https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
echo "Saved apps/web/public/vendor/xlsx.full.min.js"
