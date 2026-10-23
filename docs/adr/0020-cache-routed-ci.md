# ADR 0020: Start every Linux lane and let the cache route

Status: Accepted. Supersedes [ADR 0014](0014-path-routed-ci-lanes.md); amends
[ADR 0009](0009-content-hash-merge-gate.md), whose content-hashed Nx cache
still decides whether a started lane reruns.

## Context

ADR 0014 generated a 217-line path filter from every lane's Nx inputs
(`scripts/ci-lanes.ts`), kept it in sync with a drift test built on a private
Nx API, and routed lanes from a diff against the last policy-verified green
`main` run. In practice 69 of 88 planned runs on 2026-10-17 started every lane
anyway: the generated groups overlapped, and generator inputs reach almost
every lane.

The Apple lanes keyed an observed Mac environment. `xcodebuild -version -sdk`
lists SDK symlinks in filesystem order and `xcrun swift --version` writes to
stderr, which Nx also hashes, so the same inputs produced one of two keys on a
Mac (63 hits and 50 rebuilds that day) and never matched the Linux probe's key
(0 of 67 probes hit). A server-only change could therefore queue a macOS build.

## Decision

- Every Linux lane starts on every run as a static job; the Nx remote cache
  replays unchanged tasks.
- `Plan` path-filters only the Rust runner and the Apple lanes, with inline
  `dorny/paths-filter` groups against the PR base or the push's `before`
  commit. Nightly and manual runs start both. The Apple filter names native
  sources and direct Apple task inputs, not the generator's web inputs.
- Selected Apple checks execute on macOS and reuse compiler/artifact caches.
  The simplification cutover retires portable result passes and Linux/macOS
  probes, accepting runner startup to remove their ownership and digest graph.
- Journeys move to `journeys.yaml`, triggered by a label or a dispatch, outside
  the merge gate.
- One required check, `CI passed`, accepts a skip only for an unselected lane.

## Considered options

- **Keep the generated filter**: about 1,000 lines of generator, tests and
  policy for roughly four distinct outcomes.
- **Nx `affected` in `Plan`**: needs an install in `Plan` and maps projects,
  not jobs; root files route as coarsely as hand-written globs.
- **Observe the toolchain deterministically**: still needs a Mac job before
  every Linux probe, costing a macOS queue slot on each Apple-lane run.

## Consequences

- A docs-only PR starts every Linux lane; each replays from the cache after
  about a minute of setup.
- Diffing against the PR base can skip the Rust or Apple lane on a PR whose
  base never passed them; the nightly run and the next lane-touching change
  catch that.
- A contract or schema change that only alters the generated Swift client
  skips the Apple lanes; the nightly run catches a native break it causes.
- Selected Apple checks run against the runner's current toolchain.

## Amendment: repository documentation

The existing path-filter action selects generation, formatting and relative
links for Markdown-only changes under `docs/` and root agent instructions.
Guide, skill, plugin and mixed changes retain full Linux validation. Nightly
and manual runs remain full; the required aggregate accepts planned skips.

Remove the blanket docs digest from the shared Nx gate. Web tests instead
hash guide/plugin Markdown and the outputs of their existing generation and
WASM dependencies. Generation retains its own docs inputs because it bundles
playbook references. This avoids invalidating application tests for developer
prose without adding a classifier, digest script or source-discovery layer.
