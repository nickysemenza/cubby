#!/usr/bin/env bash
set -euo pipefail

# Pin the Linux CLI bytes: a new production release needs an explicit update.
target="${RUNNER_TEMP:-/tmp}/cubby-boat-bin"
mkdir -p "$target"
curl --fail --silent --show-error --location --max-time 90 \
  'https://boat.dev/api/boat/cli/download?platform=linux-x64&channel=prod' \
  --output "$target/boat"
printf '%s  %s\n' ac1583741e7e92117cd14330ac2ceeebee28c20c3dfb68f5e1091de57379b1c7 "$target/boat" | sha256sum --check
chmod +x "$target/boat"
printf '%s\n' "$target" >> "$GITHUB_PATH"
