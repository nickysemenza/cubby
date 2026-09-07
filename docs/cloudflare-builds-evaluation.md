# Cloudflare Workers Builds evaluation

Research and hosted pilot snapshot: 2026-09-07. Two hosted probes were run;
the temporary Git connection was removed afterward. No deployment or version
upload occurred. This evaluates Workers Builds, not the Workers runtime,
Cloudflare Containers runtime, or Pages build allowance.

## Decision

Workers Builds is a credible candidate for Cubby's verification and deployment,
but not yet a proven replacement for GitHub Actions. The decisive experiment is
running disposable PostgreSQL/pgvector plus IntegreSQL and both Playwright
browsers inside the actual build environment. Pricing alone cannot answer that.

## Confirmed platform behavior

- The build image is Ubuntu 24.04 on x86_64, with configurable Node/pnpm and
  `build-essential` installed. Rust/wasm-pack are not listed in its tooling
  table. `SKIP_DEPENDENCY_INSTALL=1` supports custom dependency setup order.
  [Build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)
- Free: 3,000 build minutes/month, one concurrent build, 2 vCPU, 8 GB memory.
  Paid: 6,000 included minutes/month, six concurrent builds, 4 vCPU, 8 GB memory,
  then $0.005/minute. Both have 20 GB disk and a 20-minute build timeout.
  These account allowances are shared with other projects.
  [Limits and pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)
- Workers Paid starts at $5/month. Dashboard preflight confirmed Workers Paid active and 8 build minutes used
  in the September 6–October 6 cycle (about 5,992 included minutes remaining).
  [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- A build command precedes a configurable deploy command. Non-production
  branches default to `wrangler versions upload`, but their command can run
  anything. A test-only command with no upload is therefore a documented route
  for a pilot. Avoid the default preview command during the initial probe.
  [Configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- GitHub integration supports individual accounts and selected repository
  access. Builds report GitHub check runs and PR comments. A Worker skipped by
  watch paths produces no check run, which matters when choosing required checks.
  [GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- Automatic caching supports pnpm's store and selected framework directories,
  with 10 GB per project and seven-day expiry after last read. The documented
  directory list does not cover Cargo targets, `packages/wasm`, or Playwright
  browsers. Do not assume the current exact-key caches migrate automatically.
  [Build caching](https://developers.cloudflare.com/workers/ci-cd/builds/build-caching/)
- The monorepo model connects each Worker separately and starts a build for each
  affected Worker. It is not a documented replacement for the current shared
  validation and artifact job graph.
  [Advanced setups](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/)

## Unresolved environment capabilities

Cloudflare explicitly documents Wrangler-integrated Dockerfile builds in
[Deploy Containers](https://developers.cloudflare.com/containers/guides/deploy/).
Neither that guide nor the build-image reference establishes general
`docker run`/Compose access, a reachable local daemon, root/sudo package
installation, or installed Playwright browsers and full browser dependencies.
These are unknowns, not evidence that the capabilities are prohibited.
Docker-in-Docker support for the Containers/Sandbox runtime does not establish
support in Workers Builds. Native PostgreSQL provisioning could be another
path, but would require maintaining an additional environment setup and proving
pgvector, IntegreSQL, and disposable-database behavior.

## Cubby-specific implications

Sources: [CI design](ci.md), [GitHub workflow](../.github/workflows/ci.yaml),
[dependency setup](../.github/actions/setup-node-with-deps/action.yml), and
[Docker Compose](../docker-compose.yml).

1. Pin Node 24, pnpm 10.34.1, and the repository Rust toolchain. Restore/build
   WASM before workspace installation, preserving the current setup order.
   Set `SKIP_DEPENDENCY_INSTALL=1` to own that ordering. The current GitHub Rust
   job uses ARM; moving it here changes native architecture coverage to x86_64.
2. Start only Compose services `db` and `integresql`; the default Compose file
   also includes Jaeger, which the acceptance tests do not require. Pin the
   IntegreSQL image for a reproducible pilot as the existing CI does.
3. Check memory under concurrent validation, database tests, and browsers.
   Six paid concurrent builds means six builds, not six independent test jobs
   within a build. Internal test parallelism still shares one build's CPU/RAM.
4. Keep the 260 authoritative PostgreSQL contracts and Chromium/WebKit lanes.
   Do not substitute PGlite or a remote Chromium-only service to make CI fit.
5. A single build could produce a Cloudflare bundle, test that same directory,
   and deploy it without a cross-job artifact transfer. This is a proposed
   simplification, not measured behavior.
6. Preserve exact-source verification and the current-main deployment guard.
   Preserve coverage scheduling and auxiliary/Rust gates before full cutover.
   Connecting all Workers independently and repeating the full root suite in
   each build would undermine the cost goal.
7. Budget the complete cold path, including tool downloads, Rust/WASM compile,
   browser setup, tests, app build, and deploy, within the build timeout.
   Previous GitHub job-duration sums are not Cloudflare runtime estimates.

## Minimum hosted experiment

The approved pilot uses the existing Cubby Worker with a dedicated pilot branch
and explicit no-op deployment commands. The diagnostic script should print only tool versions and test results,
not the environment or credentials.

1. Inspect OS/architecture, available memory/disk, Node/pnpm/Rust/wasm-pack, Docker
   daemon reachability, Compose version, and noninteractive package-install
   permission. Dockerfile build support alone does not prove container runtime
   access, local port forwarding, or Compose support.
2. Start disposable PostgreSQL/pgvector and IntegreSQL; verify both health and
   template/database creation from the build process over localhost.
3. Install version-matched Chromium and WebKit dependencies and launch each
   against a local test server. Prove workerd can run the built application.
4. Run the existing complete verification gates and test the exact bundle to
   be uploaded, recording time per phase and peak resource use.
5. Repeat cold and warm builds and verify an intentional test failure produces
   a failing GitHub check and never reaches an upload/deploy command.

If step 2 or 3 requires maintaining a custom external database/browser fleet,
prefer CircleCI's documented service-container/VM setup for the full CI suite.
Build-and-deploy-only Cloudflare adoption would leave the heavy test-runner
cost elsewhere and must not be presented as a complete solution.

## Implemented pilot

Entrypoint: `node scripts/cloudflare-ci-pilot.ts probe` or `full`, from the repository root.
Both modes reject other branches and non-Workers/Linux x86_64 environments before
provisioning. The outer process imposes an 18-minute deadline and supplies an
allowlisted environment to tests; production credentials and database overrides
are not inherited. A failure stops the pipeline and cleans up disposable services.
`CUBBY_PILOT_FAIL=1` deliberately fails before provisioning.

Configure the existing Worker only after recording its current configuration:

- Production branch: `codex/cloudflare-ci-pilot`; preview builds disabled.
- Build: `node scripts/cloudflare-ci-pilot.ts probe` initially, then `full`.
- Deploy and non-production deploy: `printf 'CUBBY_PILOT_DEPLOY_NOOP\n'`.
- Root: `/`; `NODE_VERSION=24`, `PNPM_VERSION=10.34.1`,
  `SKIP_DEPENDENCY_INSTALL=1`; no production build secrets.
- Start with caching disabled for the probe. Enable caching before the measured
  cold run, then retry the same commit twice without changing configuration.
- Maximum eight builds, one at a time. Verify at least 200 included minutes before
  the first build, and recheck account usage before each later build. Count failed
  probes and retries toward the limit. Stop when usage cannot be verified.

The Docker path uses the current CI PostgreSQL major and IntegreSQL digest. The
native fallback compiles PostgreSQL 17.6, pg_trgm, pgvector 0.8.1 and IntegreSQL
1.1.0 (Go 1.23.6) into a disposable directory. This may consume much of the cold
budget; it is deliberately measured rather than assumed equivalent to Docker.
Rust follows the repository toolchain; wasm-pack is pinned to 0.13.1. Browser
versions come from the lockfile. A template-cloning check verifies pgvector and
pg_trgm before acceptance tests run.

The full mode runs Rust format/clippy/tests, deduplication, `check:all`, workspace
and PostgreSQL tests, both auxiliary Worker builds, `build:cf`, and all 22 E2E
contracts. Major stages are sequential, check concurrency is two, and existing
Playwright workers, reporters and test-count guards remain intact. Weekly coverage
instrumentation is excluded. No deployment command is invoked by this script.

Log lines beginning `pilot` record stage durations, outcomes, source commit,
available disk and cgroup peak memory where supported. Collect Cloudflare build
UUIDs, queue/start/end timestamps, cache restore logs, billed minutes and GitHub
check conclusions separately; script elapsed time excludes checkout and queueing.

### Execution evidence

- Preflight: Workers Paid active; 8 account build minutes used; no existing Cubby
  Git connection. Production version `463e7540-f533-43c1-9a74-c5199092463d` (2398).
- Local checks: ShellCheck, Bash syntax, four entrypoint guard tests, `pnpm check`,
  and mandatory pre-push web tests, Cloudflare build, and auxiliary gates passed.
  The first push attempt found a missing generated MCP app bundle; building that
  local prerequisite resolved it without source changes.
- Hosted probe 1 (`22ee58d5-3dfe-429f-96de-0e5cc1255484`, commit `eb53f9a49`):
  failed after approximately 4m03s. Toolchain setup 19s, WASM 154s, dependency
  installation 26s. Docker was not usable. Native PostgreSQL configuration failed
  because Bison was absent. GitHub reported `Workers Builds: cubby` as failed;
  the deployment no-op never ran.
- Hosted probe 2 (`7a806a4b-38aa-49d5-9d6f-841d6f0cb51d`, commit `adba48dea`):
  moved database setup first and attempted Bison/Flex installation. Failed after
  approximately 30s (3s in the script): `sudo: command not found`. GitHub again
  reported a failed check, with no deployment step.
- Measured image: unprivileged buildbot user, Linux x86_64, Node 24.20.0,
  pnpm 10.34.1, Rust 1.98.1. About 14.5 GiB disk available initially.
  No cgroup peak-memory reading was exposed at the probed path.
- Two of eight allowed builds used. Full-suite cold/warm runs, browser startup,
  native database compatibility, and deliberate failure injection were not
  reached. The natural failures prove failure propagation, not the separately
  planned deliberate-failure scenario. No speed comparison is justified.
- Restoration verified: Settings shows Git repository → Connect. The complete
  deployment/version API results match the preflight snapshots; version 2398
  remains active. Original GitHub Actions and required checks were unchanged.

### Pilot conclusion

The straightforward Docker/native bootstrap is blocked on the actual build
image. This does not prove that unprivileged package extraction or a fully
user-local toolchain could never work. Those approaches would add maintenance,
and browser system-library compatibility would still need proof. Do not migrate
full CI based on these results. Cloudflare remains a candidate for build-only
work; full CI would require another explicitly scoped environment experiment.
Reported durations are log-derived wall time, not a claim about billed minutes.
- Restore the original disconnected Git state after the experiment, and compare
  deployment/version listings with the preflight snapshot. Leave GitHub Actions
  and required checks unchanged.


### Resumed pilot: unprivileged TypeScript bootstrap

The entrypoint now uses Node 24 native TypeScript and argument-array subprocess
calls. No npm dependency is needed before the required WASM-first bootstrap.
The native fallback downloads signed Ubuntu/PGDG packages into disposable APT
state and extracts them with `dpkg-deb`; no sudo, host installation, or package
maintainer scripts run. PostgreSQL 17.11 and pgvector 0.8.6 packages are pinned;
all downloaded package filenames and SHA-256 hashes are logged for comparison.
IntegreSQL remains v1.1.0 built with Go 1.23.6.

Playwright 1.62.1 dependencies use its Ubuntu 24.04 package list plus software
EGL drivers. Its WebKit launcher is adjusted to preserve the local library path.
The host ldconfig-cache check cannot see an extracted prefix, so it is replaced
by real Chromium/WebKit startup probes followed by the unchanged E2E suite.
Browser engine versions and test-count guards are unchanged.

Local Ubuntu 24.04 x86_64 testing under UID 1000 verified PostgreSQL startup and
loading both `vector` and `pg_trgm`; Chromium and WebKit both launched and
rendered a page with the extracted libraries and software EGL renderer.
The resumed preflight dashboard showed 14/6,000 included build minutes used.
Hosted acceptance results are still pending;
the two earlier failed probes count toward the original eight-build cap.


### Run 3 and first full attempt

Run 3 (`e9898958-4cde-4db6-9dd9-e8c9f6311d6e`, commit `b4fb28db7`)
passed the complete environment probe. The script took 304 seconds; the hosted
build ran 16:48:28–16:53:55 UTC. Database setup took 52.21s, toolchain 16.85s,
WASM 147.47s, install 30.34s, database contract 1.22s, browser installation
48.17s, and both browser launches 4.61s. Final disk usage was 53% (9.4 GiB used).
The GitHub check passed and the deployment log contained only the no-op sentinel.

Run 4 (`cf474251-81fa-491e-ac21-d75f8afd1695`, same commit, full mode,
cache enabled) reached the 18-minute script deadline during repository checks.
Rust formatting, Clippy (207.99s), Rust tests (288.37s), and deduplication
(37.45s) passed. TypeScript and Knip were terminated by the deadline; workspace,
PostgreSQL and E2E suites were not reached. Final disk usage was 65%. Failure
reached GitHub and the no-op deployment step did not run. This is not a passing
cold-run measurement.

The next configuration uses four Rust compilation jobs on the paid four-vCPU
runner, while preserving two concurrent repository checks and one Playwright
worker. Go runtime parallelism is also capped at four. GNU time reports CPU and
maximum RSS for routine stages; the cgroup peak-memory file was unavailable.

Cold local diagnostics: the unbounded native web typecheck completed in 15.10s
with 4.11 GB maximum RSS; Knip completed in 9.21s. TypeScript reported roughly
4.49 GB of memory with extended diagnostics. A 2 GiB Go memory target
increased local runtime to 46.66s; 6 GiB with four Go processors completed in
16.70s. The pilot uses the latter setting, since `NODE_OPTIONS` cannot constrain
TypeScript 7's Go heap. Repository checks now precede native Rust compilation
to expose any remaining platform slowdown before spending time on Rust.

A local clean-target Rust experiment passed all 251 executed tests (plus one
existing ignored doctest) in 100.83s with four compilation jobs. Clippy afterward
still took 79.79s under its default dev profile. A subsequent Clippy run with
`--profile test --all-targets -- -D warnings` completed in 3.46s, but that
measurement was contaminated by the preceding Clippy run. Hosted run 5 still
checked dependencies after tests, so the 3.46s result is not evidence of a cold
speedup from profile alignment. Run 5 preserves all tests, lint targets, and the
warning policy. These local timings are ARM macOS diagnostics, not an x86
GitHub/Cloudflare benchmark.
