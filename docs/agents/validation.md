# Validation, CI, and delivery

Prefer an E2E scenario at the real user or system boundary for behavior it can
observe. Use an isolated test for a specific plausible failure that E2E cannot
reasonably catch, such as a database constraint, native wire contract, or
concurrency boundary. Use real implementations; mocks are for external seams
that cannot run locally. Write failure modes and any isolated test before the
implementation it guards.

## Signal and speed

Choose the cheapest boundary that can expose the failure. Headless HTTP/native
service checks establish stored values, totals, provenance, ownership and error
contracts; a small browser or Tester Army journey establishes navigation,
editing and supported visible outcomes. AI chooses a path through the real UI;
deterministic read-back establishes whether the action worked. Previews cover
presentation states, not writes or navigation. Live model journeys always use Jev decisions through Cloudflare AI Gateway;
informational PR routing, weekly uncached coverage and manual dispatch control
when they run (see [Tester Army](../tester-army.md)). They do not replace the
deterministic content-hash merge gate.

Keep an isolated test only when its named failure cannot reasonably be observed
by the retained flow or an existing compiler/generator guard. Remove tests of
declarations, constants, source spelling and mocks, repeated cases of the same
shared primitive, and copy-only assertions. An accessible action name used to
drive a real interaction still has value; incidental wording is not an outcome.
For every deletion, record either the stronger retained regression or why the
test guarded no runtime behavior in the commit message that deletes it. Preserve named regressions before removal.

Reuse a healthy HMR session for iteration and fingerprint-verified builds.
Report setup separately from scenario time. A failed provenance/startup check
is not a scenario result. Before declaring shared schema inputs ready, run the
read-only `loadEntityDeclarationBundle` strict probe; do not infer readiness from
field spelling. Root owns generation and migration readiness during parallel work. Measure CI's natural job timings before changing
shards; keep test-lane cache keys broad.

## During implementation

For persistent HMR, fixture packs, or runtime discovery, load
[local development](../local-development.md). Disposable E2E lanes own their
test databases. Keep the existing CI Playwright HTML reports and traces, and
local native `sim-e2e` artifacts; no custom bundle is required for every E2E
journey or runtime acquisition.

Run one affected E2E scenario when it exposes the behavior. For an isolated web
contract, run `pnpm test:file src/...` from the repository root; paths are
relative to `apps/web`. For PostgreSQL contracts use `pnpm test:postgres
src/...`. Read failed tests from
`apps/web/.vitest-results.json` before deciding what to change; do not rerun an
unchanged tier to rediscover its failures.
Forward named-case flags directly, for example `pnpm test:postgres src/...
-t 'case name'`; adding `--` here reaches Vitest as a literal separator and
does not apply the intended filter. Likewise, use `pnpm db:generate
--name=description` without an extra separator.

## Before opening a PR

Open a reviewable PR after the implementation, owning docs, and focused local
checks are ready. CI and independent review can run together; a pending CI run
is compatible with a ready-for-review PR. Merge still requires the final
content's `CI passed`. Publication itself adds no checks.

Choose local evidence by the changed behavior:

- Web/server behavior: the affected regression or real user journey. Run one
  app typecheck when TypeScript behavior or signatures change; include the
  test program when tests/tooling change (see [quality](validation-quality.md)).
- Generated native labels, fixtures, constants, or incidental Swift changes:
  verify generation and relevant focused contracts. CI owns native compilation;
  these edits alone do not require local host tests, app builds or simulators.
- Native wire shapes or decoding: focused host/contract coverage. Compile
  locally when the change has a specific native compilation risk; CI always
  covers changed native inputs before merge.
- Hand-written Swift behavior: the affected host tests or app target. Native
  navigation/interaction additionally needs the changed interaction exercised;
  compiling a simulator target does not require booting a simulator.
- Signing, entitlements or release configuration: the relevant archive/release
  check. TestFlight builds are not an ordinary pre-PR requirement.

`pnpm apple check host`, `app`, or `lint` selects one native check;
`pnpm apple check` runs all three when full native diagnosis is needed. Each
native pass is probed before FFI setup, and local misses run sequentially.
The server client-version gate test is relevant when changing compatibility
behavior, not merely because generated Swift changed.

CI selects broad tiers from their declared inputs; avoid repeating the full
PostgreSQL, fast, lint, Knip, or build suites locally as a gate. Use scoped lint
while iterating; the commit hook owns staged lint/format. Run Knip for changed
entry points/dependencies, generator validation for changed declarations, and
workflow/routing checks for CI changes. `pnpm check:plan [base]` explains CI
candidate lanes and matching changed files (default `origin/main`); it is not
an instruction to run those lanes locally. CI uses its last green main as base.

One root agent owns any broad validation that the change needs. A subagent runs
only focused tests and returns its result, command, duration, relevant output,
and limits. Reuse valid results at handoff; choose checks for the changed behavior
rather than running a blanket `pnpm check` or affected suite. Keep expensive
local gates sequential, including across active sessions on a constrained host.
Reuse valid input-hash results at handoff. Finish edits to build inputs before
starting immutable-build verification; use healthy HMR for suitable iteration.
Nx reports task durations/cache hits, the dev supervisor records startup phase
timings, and GitHub records named check steps; use those before adding telemetry.
Wait for a build runner's terminal success before starting a dependent prebuilt
Worker or browser check. A yielded session is still running; a completed client
bundle alone does not establish a finished Worker build and provenance stamp.

## PR screenshots

Screenshots are optional evidence, at the author's discretion: add them when a
PR changes what a web screen looks like and an image says more than prose.
Capture against the local E2E stack, whose seeded data is synthetic, never
against production: the repository is public and attached images are too. Save
`page.screenshot({ path })` files from a throwaway Playwright spec or the
affected scenario, and delete the throwaway spec before committing. Reference
each image in the body by its local path and pass the same path to
`gh pr create --attach` or `gh pr edit --attach` (gh 2.102 has the flag; 2.96
does not); the CLI uploads it and rewrites the reference. A before image (from
`main` or a run before the first edit) helps when the change is a comparison.
Do not open the images to check them: attaching a saved file costs no context.

## Commit, push, and merge

Inspect CI logs and annotations before editing. Fix only change-caused failures;
report flakes, infrastructure, and unavailable checks separately. Use an
isolated worktree when maintenance must not alter the configured checkout.
Validate deploy-only steps against CI token scopes because PR jobs do not
exercise them. Prefer a fresh branch after a squash merge.

When a shell call runs a check before dependent Git operations, stop on failure
with `set -e` or use separate calls. A failed check must not be followed by a
commit, push, or rebase continuation in the same call.

Commits run only `pnpm check:staged`: Oxlint checks staged files and Oxfmt
formats them in place, with the existing rules and ignore patterns. Partial
staging is preserved. Never run Oxfmt by hand; commit and let the hook format.
Fix reported lint issues explicitly and stage the intended corrections. Use the
commit hook normally; bypass it only when the user explicitly requests that.

Checkout and merge hooks run no builds: build, test and dev entry points ensure
the artifacts they consume. After a branch switch, use `pnpm apple gen` before
opening the generated Xcode project directly.

Pushes run no validation and do not require a clean working tree or a refreshed
base ref. Committing, pushing, or handing off work does not trigger additional
local checks. Report local results and anything unrun without implying that a
successful push proves correctness.

`CI passed` must pass for the final PR head's content before merge. CI starts
only the lanes whose inputs differ from the last green `main` run
([ADR 0014](../adr/0014-path-routed-ci-lanes.md)). A passing result in the
shared Nx remote cache for the same input hash satisfies a started lane's
check, whether CI or the developer's Mac produced it; CI replays it in seconds
([ADR 0009](../adr/0009-content-hash-merge-gate.md),
[CI](../ci.md#cache-keys-and-the-remote-cache)). A check that reads a new
file belongs in its Nx target's inputs; `pnpm generate` then routes the lane. Running `pnpm apple check`
locally before a PR therefore lets CI replay the Apple lanes. A green earlier
commit with different content is not evidence. `main` runs CI after deployment
starts, so post-merge CI does not replace this gate. A PR that adds a
migration follows the [production change rules](domain-rules.md#production-changes).

## Explicit local diagnostics

`pnpm check` remains available for repository-wide static validation.
`pnpm verify:local` is the clean-tree full diagnostic, and
`pnpm verify:local:full` forces uncached verification. Use broad checks for
relevant diagnosis, an explicitly requested audit, or full local verification.
Coverage remains manually dispatchable in GitHub Actions.

## Load when needed

- [Test tiers and browser/database traps](validation-tests.md) for a new test,
  changed `.tsx`, PostgreSQL, E2E, WASM, or package test work.
- [Quality and local diagnostics](validation-quality.md) for lint/type failures,
  dependencies, generated surfaces, or broad local verification.
