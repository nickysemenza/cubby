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
manual workflow dispatch controls when they run. They do not replace the
exact-head deterministic CI gate.

Keep an isolated test only when its named failure cannot reasonably be observed
by the retained flow or an existing compiler/generator guard. Remove tests of
declarations, constants, source spelling and mocks, repeated cases of the same
shared primitive, and copy-only assertions. An accessible action name used to
drive a real interaction still has value; incidental wording is not an outcome.
For every deletion, record either the stronger retained regression or why the
test guarded no runtime behavior. Preserve named regressions before removal.

Reuse a healthy HMR session for iteration and fingerprint-verified native
builds. Report setup separately from scenario time. A failed provenance/startup
check is not a scenario result. Measure CI's natural job timings before changing
shards; retain the existing cache keys and exact-head merge gate.

## During implementation

For persistent HMR, fixture packs, runtime discovery, or manual simulator work,
load [local development](../local-development.md). Disposable E2E lanes keep
owning their test databases and replay artifacts.

Run one affected E2E scenario when it exposes the behavior. For an isolated web
contract, run `pnpm test:file src/...` from the repository root; paths are
relative to `apps/web`. For PostgreSQL contracts use `pnpm test:postgres
src/...`. Read a failed run's ending and
`apps/web/.vitest-failures.txt` before deciding what to change; do not rerun an
unchanged tier to rediscover its failures.
Forward named-case flags directly, for example `pnpm test:postgres src/...
-t 'case name'`; adding `--` here reaches Vitest as a literal separator and
does not apply the intended filter. Likewise, use `pnpm db:generate
--name=description` without an extra separator.

Before a PR, run focused checks and the affected local-only native/simulator
lane that CI cannot cover. `pnpm test:e2e:local` defaults to headless + simulator
smoke; UI editing/view-switch changes require `sim:extended` or
`--extended-journey`. Choose domain lanes by name or `--all` for the extended matrix
(one lane: `pnpm test:e2e:sim -- <flags>`; `-- --help` lists
modes, env, and artifact paths; see the
[local development](../local-development.md#native-iteration-and-validation)), plus focused tests for
the change. CI runs the PostgreSQL, fast, typecheck, lint, and knip tiers on every PR; do not
repeat them locally as a gate.

One root agent owns any broad validation that the change needs. A subagent runs
only focused tests and returns its result, command, duration, relevant output,
and limits. Reuse valid results at handoff; choose checks for the changed behavior
rather than running a blanket `pnpm check` or affected suite. Keep expensive
local gates sequential.
Wait for a build runner's terminal success before starting a dependent prebuilt
Worker or browser check. A yielded session is still running; a completed client
bundle alone does not establish a finished Worker build and provenance stamp.

## Commit, push, and merge

When a shell call runs a check before dependent Git operations, stop on failure
with `set -e` or use separate calls. A failed check must not be followed by a
commit, push, or rebase continuation in the same call.

Commits run only `pnpm check:staged`: read-only Oxlint and Oxfmt checks on staged
files, with the existing rules and ignore patterns. Partial staging is preserved;
fix reported issues explicitly and stage the intended corrections. Use the
commit hook normally; bypass it only when the user explicitly requests that.

Pushes run no validation and do not require a clean working tree or a refreshed
base ref. Committing, pushing, or handing off work does not trigger additional
local checks. Report local results and anything unrun without implying that a
successful push proves correctness.

GitHub Actions must pass on the exact final PR head before merge. `main` runs CI
after deployment starts, so post-merge CI does not replace this gate.

`deploy.yaml` deploys every `main` push and never applies schema. A PR that adds
a migration under `apps/web/drizzle/` is opened without auto-merge and merges
only after that migration has run in production and been read back. A contract
migration (`DROP COLUMN`, or a constraint the deployed code would violate) is
the exception: ship the code that stops reading or writing the old shape first,
then apply the migration right after that deploy and read it back
([domain rules](domain-rules.md)).

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
- [PR, CI, and device acceptance](validation-delivery.md) for a PR, failing
  hosted check, deployment path, or phone browser behavior.
