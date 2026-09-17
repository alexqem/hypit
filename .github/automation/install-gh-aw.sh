#!/usr/bin/env bash
set -euo pipefail
# Linux x64 GitHub-hosted runners; update the version and checksum together.
destination="${1:?Pass a destination binary path}"
mkdir -p "$(dirname "$destination")"
curl --fail --location --retry 3 --output "$destination" \
  https://github.com/github/gh-aw/releases/download/v0.88.7/linux-amd64
printf '%s  %s\n' 37faaaa95f622b910568bc878452f6036f01e951380fdfc41441944a95da43bf "$destination" | sha256sum --check --status
chmod +x "$destination"
