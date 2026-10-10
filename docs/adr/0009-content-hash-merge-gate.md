# ADR 0009: Gate merges on content-hashed check results

Status: Accepted.

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
- The Apple lane runs locally through the same Nx target. On a PR cache miss,
  CI falls back to the hosted macOS run.
- Keys leave out platform, Node version, locale, and CI's own environment, so
  a Mac result counts for Linux lanes too. A nightly run executes every lane
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
