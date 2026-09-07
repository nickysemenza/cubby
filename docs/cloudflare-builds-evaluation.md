# Cloudflare Workers Builds evaluation

Updated September 7, 2026. Seven of eight authorized builds have been launched;
run 7 is complete; one build remains. This evaluates Workers Builds and keeps Cubby deployments
and preview uploads disabled. It does not use the separate Cloudflare CI SDK.

## Decision

Do not migrate CI on the evidence collected so far. The native database and both
browser engines work, and deliberate failure reporting works. No full hosted run
has passed yet. Even if the two remaining full runs pass, the eight-build cap no
longer permits the required cold success plus two warm successes at one commit.
The final handoff must record that unmet acceptance criterion explicitly.

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

## Configuration and implementation

The original Cubby Git build integration was disconnected. The pilot temporarily
connects only `codex/cloudflare-ci-pilot`; non-production builds remain disabled.
The build command is `node scripts/cloudflare-ci-pilot.ts full` (or `probe`).
The deployment command is the successful no-op
`printf 'CUBBY_PILOT_DEPLOY_NOOP\n'`. The preview command could not be configured
independently while preview builds were disabled; preview execution was never
enabled. That is a deviation from the requested two explicit no-op commands.

Node 24 and pnpm 10.34.1 are pinned, with `SKIP_DEPENDENCY_INSTALL=1`.
The entrypoint rejects unexpected branches and environments, builds WASM before
installing workspace dependencies, and imposes an 18-minute script deadline.
Only an allowlisted environment reaches commands. Databases, extracted packages,
and native services are disposable and cleaned up on failure. It never invokes
a deployment. GitHub Actions, required checks, and weekly coverage are unchanged.

Docker and sudo are unavailable on the measured Ubuntu 24.04 x86_64 image.
The TypeScript fallback extracts signed Ubuntu/PGDG packages into a local prefix
without host installation or maintainer scripts. PostgreSQL 17.11 and pgvector
0.8.6 are pinned; IntegreSQL 1.1.0 is built with Go 1.23.6. Package filenames and
SHA-256 hashes are logged. Loading `vector` and `pg_trgm`, creating an IntegreSQL
template, and cloning a test database passed in the hosted probe.

Playwright 1.62.1's Ubuntu dependencies are extracted alongside software EGL
libraries. The WebKit launcher is adjusted to preserve this library search path.
The host ldconfig-cache check cannot see that prefix, so actual Chromium/WebKit
startup probes replace it; browser versions and the complete E2E guards remain
unchanged. This is additional setup maintenance, not ordinary out-of-box CI.

Full mode runs deduplication, `check:all`, Rust formatting/tests/Clippy, every
routine workspace test, 262 PostgreSQL contracts, both auxiliary Worker builds,
the Cloudflare web build, then all 22 desktop/WebKit E2E contracts. Major stages
are sequential. Repository check concurrency is two, Rust compilation uses four
jobs, and Playwright retains one worker. Run 7 also limits workspace tests to two
workers and uses one native TypeScript checker.

## Build ledger

Durations are hosted wall time from logs/UI, not individually billed minutes.
Queue time was not exposed separately; initialization, cloning and tool setup
are included in hosted duration but excluded from script timing.

| Run | Commit | Build UUID | Result | Hosted duration |
| --- | --- | --- | --- | --- |
| 1 | `eb53f9a49` | `22ee58d5-3dfe-429f-96de-0e5cc1255484` | Native PG source build blocked by missing Bison | about 4m03s |
| 2 | `adba48dea` | `7a806a4b-38aa-49d5-9d6f-841d6f0cb51d` | Package installation blocked by missing sudo | about 30s |
| 3 | `b4fb28db7` | `e9898958-4cde-4db6-9dd9-e8c9f6311d6e` | Environment probe passed; no-op deployment step passed | 5m27s |
| 4 | `b4fb28db7` | `cf474251-81fa-491e-ac21-d75f8afd1695` | Full run hit script deadline during checks | about 18m25s |
| 5 | `df0c66c53` | `fc5a5559-dc45-47b0-b931-0434b66dbf51` | Checks/Rust passed; two web test timeouts | 14m31s |
| 6 | `df0c66c53` | `410cde3e-12e4-4020-ac69-da5302b3c58d` | Deliberate failure reached GitHub; deployment step skipped | about 22s |
| 7 | `1aa79a50d` | `09e5bf22-6c90-49f0-bd6a-e7ed23da23f5` | All workspace and 262 PostgreSQL tests passed; stale 260-test count guard failed | about 15m23s |

Run 7 stopped at the PostgreSQL count guard after all 262 assertions passed.
Earlier changes added four contracts (PRs #975 and #977) and removed two old
calendar contracts (#978), but the expected count stayed at 260. The final run
corrects that expectation without removing tests or weakening the count guard.

Run 6 used `CUBBY_PILOT_FAIL=1`. Logs contain the intentional-failure message,
and GitHub reports `Workers Builds: cubby` failed at 17:58:09 UTC. The subsequent
no-op deployment step did not execute. The full command was restored and verified
before pushing run 7. Build cache was cleared before runs 5 and 7.

## Stage measurements

Seconds, rounded to two decimal places. A dash means the stage was not reached.

| Stage | Probe 3 | Full 4 | Full 5 |
| --- | ---: | ---: | ---: |
| Database setup | 52.21 | 43.22 | 53.68 |
| Toolchain | 16.85 | 15.61 | 22.88 |
| WASM | 147.47 | 148.52 | 127.76 |
| Workspace install | 30.34 | 37.56 | 39.25 |
| Database contract probe | 1.22 | 1.11 | 1.49 |
| Browser installation | 48.17 | 77.20 | 92.33 |
| Browser launch | 4.61 | 4.31 | 3.97 |
| Dedupe | — | 37.45 | 32.70 |
| Repository checks | — | 220.02, interrupted | 77.58 |
| Rust formatting | — | 0.21 | 2.00 |
| Rust tests | — | 288.37 | 185.15 |
| Rust Clippy | — | 207.99 | 120.88 |
| Workspace tests | — | — | 84.54, failed |

Run 5 passed all 251 native Rust tests, with one existing ignored doctest.
The web suite passed 3,435 tests and timed out on two at five seconds: calendar
snapshot oversized-document rejection and the date-picker calendar-button
interaction. PostgreSQL, auxiliary builds, web build and E2E were not reached.
Its script took 845.02 seconds including cleanup.

The measured runner has four AMD EPYC vCPUs, approximately 8 GB RAM, and no swap.
In run 5, GNU time reported a maximum process RSS of 6,311,868 KiB for checks,
591,916 KiB for Rust tests, 470,720 KiB for Clippy, and 3,820,452 KiB for workspace
tests. These are process resource readings, not a simultaneous whole-runner
memory total. Cgroup peak memory was unavailable. Final disk use was 53% after
probe 3 and 65% after runs 4 and 5 (run 5: 12,218,736 KiB used).

## Performance fixes and comparison limits

The calendar timeout exposed per-character UTF-8 array allocation during ICS
line folding. Removing those allocations preserved output and reduced local
calendar test execution from 927 ms to 119 ms, including five new Unicode cases.
One native TypeScript checker reduced local peak RSS from 5.93 GB to 3.07 GB with
similar cold wall time. Full warm checks did not get faster in the small sample.
See [local measurements](local-check-performance.md) for commands and limitations.
All 490 web test files (3,442 tests), auxiliary tests, mandatory checks and the
pre-push browser/build gates passed before run 7 was pushed.

A prior 3.46-second Clippy result reused earlier Clippy output and was not a valid
cold comparison. Hosted run 5 still spent 120.88 seconds checking dependencies
after tests. Do not attribute the measured Rust improvement to profile alignment;
compilation parallelism also changed from two jobs to four.

The documented Workers Builds cache covers pnpm and supported framework output,
not Cargo targets, generated WASM packages or Playwright browsers. The pilot
therefore rebuilds these expensive dependencies in each disposable environment.
No three-pass cold/warm repeatability result exists yet.

A recent GitHub run is not workload-equivalent: Rust was skipped and WebKit had
a retry. Its validation stage took about 93 seconds, but comparing whole pipeline
speed would be misleading. GitHub's Rust runner is ARM; Cloudflare is x86_64.

## Budget and restoration

Workers Paid was verified. The September 6–October 6 account counter began at
8/6,000 included minutes and showed 52/6,000 before run 7, with $0 billable usage.
Usage was rechecked before each build and remained far above the 200-minute
minimum. Counters lag and are account-wide; a counter delta is not an exact
per-build bill. No upgrades or intentional overage were authorized or performed.

Original deployment: `4a6f9538-cd52-44f9-91d4-300f1fcb0973`.
Original active version: `463e7540-f533-43c1-9a74-c5199092463d` (version 2398).
Deployment/version API snapshots matched after the first two probes and before
the resumed experiment. Final restoration is pending: disconnect the temporary
Git integration after the last run, then compare both API listings with the
original snapshots. Do not claim final restoration until that comparison passes.

## Separate option: the Cloudflare CI SDK

The [August 4 CI Workflows article](https://blog.cloudflare.com/ci-workflows/)
describes `@cloudflare/ci`, which this Workers Builds pilot does not use. It
combines Workflows and Sandbox containers, supports parallel runner steps, and
caches environment snapshots in R2. Its documented push integration is based on
Cloudflare Artifacts. A GitHub source/check integration would need its own
verification before replacing Cubby's current checks.

The [SDK README](https://github.com/cloudflare/ci) specifies a Workers runtime
package rather than an executable Node.js library. Adopting it would require a
separately deployed CI Worker and associated bindings; it is not a drop-in
replacement for this pilot's local TypeScript subprocess runner.

[Sandbox pricing](https://developers.cloudflare.com/sandbox/platform/pricing/)
follows Containers and related Workers/Durable Objects usage. The
[Containers allowance](https://developers.cloudflare.com/containers/platform/pricing/)
on Workers Paid is 375 vCPU-minutes, 25 GiB-hours of memory, and 200 GB-hours of
disk monthly, followed by metered charges. Memory and disk are based on
provisioned resources; CPU is active usage. The 6,000 Workers Builds minutes do
not fund Sandbox execution. Snapshot caching may address repeated setup costs,
but this architecture needs a separate measured cost and compatibility pilot.
