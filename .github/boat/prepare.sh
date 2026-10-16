#!/usr/bin/env bash
set -euo pipefail

# Run only in a credential-free disposable Boat sandbox. A snapshot prepares
# tools, not passing test results; the executor fetches its exact revision.
repo=/home/user/cubby-ci
export PLAYWRIGHT_BROWSERS_PATH=/home/user/.local/share/ms-playwright
export NX_CACHE_DIRECTORY=/home/user/.local/share/cubby-nx
export NX_SKIP_REMOTE_CACHE=true
export NX_DAEMON=false
export CARGO_BUILD_WARNINGS=deny
export CI=true

if [[ ! -d "$repo/.git" ]]; then
  git clone --depth=1 https://github.com/nickysemenza/cubby.git "$repo"
fi
# shellcheck source=/dev/null
source /home/user/.nvm/nvm.sh
nvm install "$(cat "$repo/.nvmrc")"
nvm alias default "$(cat "$repo/.nvmrc")"
npm install --global "$(node --input-type=commonjs -p "require('$repo/package.json').packageManager")"
pnpm config set store-dir /home/user/.local/share/pnpm/store
if ! command -v wasm-pack >/dev/null; then
  cargo install wasm-pack --locked
  sudo ln -sf /home/user/.cargo/bin/wasm-pack /usr/local/bin/wasm-pack
fi
pnpm --dir "$repo" install --frozen-lockfile --prefer-offline
pnpm --dir "$repo/apps/web" exec playwright install --with-deps chromium
pnpm --dir "$repo" exec nx run cubby-checks:wasm --outputStyle=stream

# Boat retains image references through containers; pulled layers can still
# hydrate after ready. The executor probes Docker and database readiness.
postgres="$(node --input-type=commonjs -p "require('$repo/.github/boat/images.json').postgres")"
integresql="$(node --input-type=commonjs -p "require('$repo/.github/boat/images.json').integresql")"
docker pull "$postgres"
docker pull "$integresql"
docker inspect cubby-ci-keep-postgres >/dev/null 2>&1 || docker create --name cubby-ci-keep-postgres "$postgres"
docker inspect cubby-ci-keep-integresql >/dev/null 2>&1 || docker create --name cubby-ci-keep-integresql "$integresql"
node --version
pnpm --version
rustc --version
wasm-pack --version
