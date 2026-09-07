#!/usr/bin/env bash
set -euo pipefail

# This entrypoint is only for disposable Workers Builds, never a developer host.
fail() { echo "pilot: $*" >&2; exit 1; }
mode=${1:-}
[[ "$mode" == probe || "$mode" == full ]] || fail 'usage: bash scripts/cloudflare-ci-pilot.sh probe|full'
[[ ${WORKERS_CI_BRANCH:-} == codex/cloudflare-ci-pilot ]] || fail 'unexpected build branch'
[[ ${WORKERS_CI:-} == 1 ]] || fail 'Workers Builds environment required'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'Linux x86_64 required'
[[ ${SKIP_DEPENDENCY_INSTALL:-} == 1 ]] || fail 'automatic dependency installation must be disabled'
[[ -f package.json && -f recipebridge/Cargo.toml ]] || fail 'run from repository root'
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || fail 'Node 24 required'
[[ $(pnpm --version) == 10.34.1 ]] || fail 'pnpm 10.34.1 required'

if [[ ${2:-} != --sanitized ]]; then
  # No production credentials or inherited database overrides reach test children.
  exec timeout --signal=TERM --kill-after=20s 18m env -i \
    PATH="$PATH" HOME="$HOME" USER="$(id -un)" LANG=C.UTF-8 CI=1 \
    WORKERS_CI=1 WORKERS_CI_BRANCH="$WORKERS_CI_BRANCH" SKIP_DEPENDENCY_INSTALL=1 \
    CUBBY_PILOT_FAIL="${CUBBY_PILOT_FAIL:-0}" \
    bash "$0" "$mode" --sanitized
fi

[[ ${CUBBY_PILOT_FAIL:-0} == 0 ]] || fail 'intentional failure: deploy sentinel must not run'
pilot_dir=$(mktemp -d /tmp/cubby-ci-pilot.XXXXXX)
current_stage=setup
compose=()
integre_pid=
pg_started=0
cleanup() {
  local result=$?
  trap - EXIT TERM INT
  [[ -z "$integre_pid" ]] || kill "$integre_pid" 2>/dev/null || true
  if [[ $pg_started == 1 ]]; then "$pilot_dir/pgsql/bin/pg_ctl" -D "$pilot_dir/data" -m immediate stop >/dev/null || true; fi
  if [[ ${#compose[@]} -gt 0 ]]; then "${compose[@]}" down --volumes --remove-orphans >/dev/null || true; fi
  df -Pk . /tmp
  if [[ -r /sys/fs/cgroup/memory.peak ]]; then echo "pilot memory_peak_bytes=$(cat /sys/fs/cgroup/memory.peak)"; fi
  echo "pilot stage=$current_stage result=$result elapsed_seconds=$SECONDS"
  rm -rf "$pilot_dir"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
stage() {
  local name=$1 start=$SECONDS
  shift
  echo "pilot stage=$name event=start"
  current_stage=$name
  "$@"
  echo "pilot stage=$name result=0 elapsed_seconds=$((SECONDS-start))"
}
fetch() { curl --fail --silent --show-error --location --retry 2 "$1" -o "$2"; }
export CHECK_MAX_PROCESSES=2 NODE_OPTIONS=--max-old-space-size=4096
export CARGO_TARGET_DIR="$pilot_dir/cargo-target" CARGO_BUILD_JOBS=2
export DATABASE_URL=postgresql://postgres:password@localhost:5432/cubby
export INTEGRESQL_URL=http://localhost:5000 INTEGRESQL_DATABASE_HOST=localhost

uname -srmo
node --version
pnpm --version
id
df -Pk . /tmp
git rev-parse HEAD
node --input-type=module -e '
  import net from "node:net";
  for (const port of [5432, 5000]) {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    await new Promise(resolve => server.close(resolve));
  }
'

toolchain() {
  if ! command -v rustup >/dev/null; then
    fetch https://sh.rustup.rs "$pilot_dir/rustup.sh"
    sh "$pilot_dir/rustup.sh" -y --profile minimal --default-toolchain none
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  rustup show
  rustup component add rustfmt clippy
  rustup target add wasm32-unknown-unknown
  fetch https://github.com/rustwasm/wasm-pack/releases/download/v0.13.1/wasm-pack-v0.13.1-x86_64-unknown-linux-musl.tar.gz "$pilot_dir/wasm-pack.tar.gz"
  tar -xzf "$pilot_dir/wasm-pack.tar.gz" -C "$pilot_dir"
  export PATH="$pilot_dir/wasm-pack-v0.13.1-x86_64-unknown-linux-musl:$PATH"
  rustc --version
  wasm-pack --version
}

native_database() {
  # Source builds keep the fallback independent of mutable apt repository candidates.
  # These versions are only for the disposable pilot, not a production database.
  [[ $(id -u) != 0 ]] || fail 'native initdb requires an unprivileged build user'
  if ! command -v bison >/dev/null || ! command -v flex >/dev/null; then
    sudo -n apt-get update
    sudo -n apt-get install -y --no-install-recommends bison flex
  fi
  fetch https://ftp.postgresql.org/pub/source/v17.6/postgresql-17.6.tar.bz2 "$pilot_dir/postgres.tar.bz2"
  tar -xjf "$pilot_dir/postgres.tar.bz2" -C "$pilot_dir"
  env -C "$pilot_dir/postgresql-17.6" ./configure --prefix="$pilot_dir/pgsql" --without-icu --without-readline --without-zlib
  make -C "$pilot_dir/postgresql-17.6" -j2
  make -C "$pilot_dir/postgresql-17.6" install
  make -C "$pilot_dir/postgresql-17.6/contrib/pg_trgm" -j2 install
  export PATH="$pilot_dir/pgsql/bin:$PATH"
  fetch https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.1.tar.gz "$pilot_dir/vector.tar.gz"
  tar -xzf "$pilot_dir/vector.tar.gz" -C "$pilot_dir"
  make -C "$pilot_dir/pgvector-0.8.1" -j2
  make -C "$pilot_dir/pgvector-0.8.1" install
  fetch https://go.dev/dl/go1.23.6.linux-amd64.tar.gz "$pilot_dir/go.tar.gz"
  tar -xzf "$pilot_dir/go.tar.gz" -C "$pilot_dir"
  export PATH="$pilot_dir/go/bin:$PATH" GOBIN="$pilot_dir/bin"
  go install github.com/allaboutapps/integresql/cmd/server@v1.1.0
  echo password > "$pilot_dir/password"
  initdb -D "$pilot_dir/data" -U postgres --pwfile="$pilot_dir/password" --auth-host=scram-sha-256
  pg_ctl -D "$pilot_dir/data" -l "$pilot_dir/postgres.log" -o "-h 127.0.0.1 -k $pilot_dir -p 5432 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=512MB -c max_connections=200" -w start
  pg_started=1
  PGPASSWORD=password createdb -h 127.0.0.1 -U postgres cubby
  PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=password "$pilot_dir/bin/server" > "$pilot_dir/integresql.log" 2>&1 &
  integre_pid=$!
}
database() {
  if command -v docker >/dev/null && docker info >/dev/null 2>&1 && docker compose version; then
    cat > "$pilot_dir/compose.yml" <<'YAML'
services:
  db:
    image: pgvector/pgvector:pg17
    ports: ["127.0.0.1:5432:5432"]
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
      POSTGRES_DB: cubby
    command: ["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "shared_buffers=512MB", "-c", "max_connections=200"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d cubby"]
      interval: 2s
      timeout: 2s
      retries: 30
  integresql:
    image: ghcr.io/allaboutapps/integresql@sha256:66b7433399f1907bad9e4b7cc7bd528ed4ebfccddecb8fd65da4af4d06a68c5a
    ports: ["127.0.0.1:5000:5000"]
    depends_on:
      db:
        condition: service_healthy
    environment:
      PGHOST: db
      PGUSER: postgres
      PGPASSWORD: password
YAML
    compose=(docker compose -p "cubby-ci-pilot-$$" -f "$pilot_dir/compose.yml")
    "${compose[@]}" up -d db integresql
  else
    echo 'pilot database=native docker_runtime=unavailable'
    native_database
  fi
  for ((attempt=1; attempt<=60; attempt++)); do
    if curl --silent --output /dev/null http://localhost:5000/; then return; fi
    sleep 1
  done
  fail 'IntegreSQL readiness timeout'
}
stage database database
stage toolchain toolchain
stage wasm env RUSTFLAGS='--cfg getrandom_backend="wasm_js"' pnpm wasm
stage install pnpm install --frozen-lockfile --prefer-offline
cp apps/web/.env.example apps/web/.env
echo 'NEXTAUTH_SECRET=supersecret' >> apps/web/.env
# shellcheck disable=SC2016 # SQL dollar quoting belongs to JavaScript, not Bash.
stage database-contract pnpm --filter @cubby/web exec node --input-type=module -e '
  import pg from "pg";
  import { IntegreSQLClient } from "@devoxa/integresql-client";
  const client = new IntegreSQLClient({url: "http://localhost:5000"});
  const hash = "cubby_cloudflare_ci_pilot";
  const poolFor = config => new pg.Pool({host: "localhost", port: 5432, user: config.username, password: config.password, database: config.database});
  await client.initializeTemplate(hash, async config => {
    const pool = poolFor(config);
    try { await pool.query("CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE TABLE pilot (id integer); INSERT INTO pilot VALUES (42)"); } finally { await pool.end(); }
  });
  const pool = poolFor(await client.getTestDatabase(hash));
  try {
    const {rows} = await pool.query("SELECT id, (SELECT extversion FROM pg_extension WHERE extname = $$vector$$) AS vector FROM pilot");
    if (rows[0]?.id !== 42 || !rows[0]?.vector) throw Error("template clone failed");
    console.log("pilot database template clone and pgvector passed");
  } finally { await pool.end(); }
'
stage browsers pnpm --filter @cubby/web exec playwright install --with-deps chromium webkit
# shellcheck disable=SC2016 # Browser URL interpolation belongs to JavaScript.
stage browser-launch pnpm --filter @cubby/web exec node --input-type=module -e '
  import { chromium, webkit } from "@playwright/test";
  import http from "node:http";
  const server = http.createServer((_req, res) => res.end("pilot"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch();
      try { const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`); if (await page.locator("body").innerText() !== "pilot") throw Error("browser smoke failed"); } finally { await browser.close(); }
    }
  } finally { server.close(); }
'
if [[ "$mode" == full ]]; then
  stage rust-fmt cargo fmt --manifest-path recipebridge/Cargo.toml --check
  stage rust-clippy cargo clippy --manifest-path recipebridge/Cargo.toml --all-targets -- -D warnings
  stage rust-test cargo test --manifest-path recipebridge/Cargo.toml
  stage dedupe pnpm dedupe:check
  stage checks pnpm check:all
  stage workspace-tests pnpm test
  stage postgres-tests pnpm test:postgres
  stage usda-build pnpm --filter @cubby/usda-api build
  stage upc-build pnpm --filter @cubby/upc-lookup build
  stage web-build pnpm --filter @cubby/web build:cf
  stage browser-tests pnpm test:e2e
fi
echo "pilot mode=$mode passed"
