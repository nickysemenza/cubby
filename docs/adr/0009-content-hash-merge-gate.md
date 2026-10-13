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

- Every required check is an Nx target. A passing result is stored in a shared
  Nx remote cache (Nx's built-in HTTP cache client, served by the
  `apps/nx-cache` Worker over an R2 bucket), keyed by the hash of the
  target's inputs.
- Test inputs are deliberately broad: every non-documentation file, the
  lockfile, and the CI configuration; the Apple lanes key on what the Apple
  build reads. Any code change
  misses the cache. Rebases, documentation-only changes, and re-pushes of an
  already-tested tree hit it.
- CI and the developer's Mac write to the cache; fork PRs receive no
  credentials and use only their runner's local cache. A
  result produced locally for the same input hash satisfies the merge gate
  exactly as a CI result does.
- The Apple lane runs locally through the same Nx target. A Linux job probes
  each Apple target after dependency setup. A verified
  cache hit skips that target's macOS job entirely; a miss or failed probe
  falls back to hosted macOS, which probes again before native setup. The
  required check accepts native success or a skipped native job backed by its
  own verified Linux probe hit.
- Apple inputs exclude the named root documentation and the explicitly excluded
  CubbyAPI README. Markdown copied as a test fixture or build resource remains
  keyed; add new consumed documentation to the inputs when changing the build.
- Keys leave out platform, Node and Xcode versions, locale, and CI's own
  environment, so a Mac result counts for CI's Linux and macOS lanes. A nightly run executes every lane
  uncached on CI as the backstop for platform-only failures; `main` pushes
  reuse the cache.

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
