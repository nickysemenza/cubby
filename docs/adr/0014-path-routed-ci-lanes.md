# ADR 0014: Start only the CI lanes whose inputs changed

Status: Accepted. Amends [ADR 0009](0009-content-hash-merge-gate.md): the
content-hashed Nx cache still decides whether a started lane reruns; this
decides which lanes start.

## Context

ADR 0009 ran every required lane on every PR and let the Nx cache replay
unchanged ones. A replay still pays each job's runner start, checkout, and
dependency install: about 40–60 seconds on each of 13 or more Linux jobs, and a
macOS job queued behind Linux validation. A one-line TODO edit started the
whole suite, and when main's previous run had been superseded no cache entry
existed, so every lane ran cold. Six required status contexts, two aggregate
jobs, and a hard-coded job list in the Tester Army dispatcher had to agree.

## Decision

- A `Plan` job on `ubuntu-slim` diffs the tested tree against the commit of
  the newest successful `main` push run of `ci.yaml`, using
  `dorny/paths-filter` with git, and starts only the lanes whose filter
  matches. Nightly and manual runs, or no green main run, start every lane.
  A `main` push whose exact tree already passed (a `tested-tree-<tree>`
  artifact from a same-repository green run) starts no lane.
- Each lane's filter is generated from the Nx inputs of the tasks it runs
  (`scripts/ci-lanes.ts` → `.github/ci-lanes.yml`). Runtime inputs are
  classified by exact command, so a new one fails generation instead of being
  silently unrouted. A test checks every file in Nx's hash plan against the
  generated filter.
- One required check, `CI passed` (`re-actors/alls-green`), accepts a skipped
  job only when `Plan` skipped its lane or the Linux probe verified that Apple
  lane's cached pass.
- Apple has separate formatting and native targets. Broad generator inputs
  select the native probe, but only declared generated output bytes invalidate
  a native pass. JavaScript dependencies do not independently key native builds.
  Host tests and app compilation have separate source scopes; missing Xcode or
  missing generated inputs fail closed. Native OpenAPI is projected from the
  same operation selection as the Swift generator, using Redocly's reference
  handling. This keeps conservative routing without rebuilding for unused HTTP
  contracts or incidental local files.
- Validation uses named steps on one runner and collects independent failures
  after setup succeeds. Local focused evidence permits opening a reviewable PR;
  required CI on the final content remains the merge boundary.
- The web lanes run as one dynamic matrix; Rust keys on its own `rustGate`
  instead of the whole tree.

## Considered options

- **`paths` filters on the workflow**: a skipped required workflow leaves its
  check pending forever.
- **Diffing against the PR base or merge base** (`nrwl/nx-set-shas`, dorny's
  defaults): a PR based on a commit whose main run was superseded or failed
  would skip lanes that never passed for that content.
- **Nx `affected`**: project-level, so it cannot honour the per-target
  negations and runtime inputs the gate keys use.
- **Hand-written path filters**: they drift from the Nx inputs, which are the
  real definition of what a check reads.

## Consequences

- Correctness rests on the same complete Nx inputs as ADR 0009, now also for
  whether a runner starts. A check that reads a new file needs it in its
  target's inputs; `pnpm generate` then routes the lane.
- A lane is skipped against any green tree, not only an ancestor: equal inputs
  would replay that tree's pass.
- Changing the required check means editing the ruleset with `gh api`; the
  ruleset requires only `CI passed`.
