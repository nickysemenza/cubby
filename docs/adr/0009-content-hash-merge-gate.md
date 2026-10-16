# ADR 0009: Gate merges on content-hashed check results

Status: Accepted. [ADR 0014](0014-path-routed-ci-lanes.md) decides which lanes
start; the cache still decides whether a started lane reruns.

## Context

GitHub Actions had to pass on the exact final PR head before merge. A typical
PR took 8–12 minutes and the tail reached 27–34 minutes. The tail came from
whole-job reruns of flaky shards. The critical path was an 11–15 minute iOS
simulator build on hosted macOS runners. That build repeated work the
developer's Mac had already done for the same tree, because AGENTS.md requires
the simulator lane locally before a PR.

The repository is public, so standard hosted runners cost nothing, but larger
runners need a paid organization plan. Nx Cloud's free tier allows 50,000
credits a month, and each CI run costs 500. At about 1,000 runs a month that
is roughly ten times the allowance.

## Decision

- Every required check has a declared Nx target. The shared HTTP remote cache
  (`apps/nx-cache`, backed by R2) stores successful results keyed by complete
  source and execution inputs. Failed tasks are never passing evidence.
- Runtime passes distinguish their relevant platform/toolchains. Web gates also
  include bundled Markdown, CI/runtime identity and test selectors. Apple keys
  contain actual Xcode/Swift/SDK/macOS/Rust identity, FFI settings and the generated
  bytes each target reads. Portable generation/WASM have separate artifact keys.
- Local results count only when those inputs match the hosted execution. A Mac
  result cannot substitute for a Linux result. Credentials remain trusted check
  publishing authority; fork PRs cannot access the shared cache.
- Native-relevant CI observes the floating hosted toolchain within the configured
  Xcode major on a lightweight Mac job, then performs guarded Nx lookups on Linux.
  A verified hit skips expensive native preparation/build. A Mac executor checks
  its own environment again; discovery on another runner is not its identity.
- PR/main/manual/nightly runs are cache-first. Nightly selects all lanes and
  detects runtime drift by environment-aware keys, rather than forcing daily
  rebuilds. Unrelated PRs can reuse the known source baseline before nightly
  discovers a hosted-native regression. Explicit fresh diagnostics bypass remote
  reads/writes while retaining fresh per-run local prerequisites.
- Policy-versioned passing-tree artifacts and baseline eligibility prevent old
  proof from bypassing an amended cache contract. Manual diagnostics are named
  apart from `CI passed` and publish no merge evidence.

## Considered options

- **Commit trailers asserting local runs**: nothing binds the claim to the
  tested tree, and agents write the commits.
- **Signed attestations**: guard against a forged result, which a single
  trusted household does not face.
- **Exact-SHA results only**: rebases and documentation-only changes would
  rerun every lane for content that was already tested.
- **Larger or self-hosted runners**: a paid plan, or a machine to keep
  running, for a gain that caching mostly delivers.

## Consequences

- A false cache hit skips a check that should have run. Correctness therefore
  rests on complete target inputs: when a check reads something new, add it to
  that target's inputs.
- The cache's write credentials are trusted as much as CI. Whoever holds them
  can satisfy the merge gate.
