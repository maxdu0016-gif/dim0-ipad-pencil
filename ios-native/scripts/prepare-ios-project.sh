#!/usr/bin/env bash
set -euo pipefail

if [ ! -s Dim0Native/Resources/offline-app.html ]; then
  echo "Missing offline app. Run the Vite offline build and scripts/package-offline-web.ts before submitting this archive." >&2
  exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  HOMEBREW_NO_AUTO_UPDATE=1 brew install xcodegen
fi

(cd ios && xcodegen generate)
