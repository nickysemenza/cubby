# Validation, CI, and delivery

Prefer an E2E scenario at the real user or system boundary for behavior it can
observe. Use an isolated test for a specific plausible failure that E2E cannot
reasonably catch, such as a database constraint, native wire contract, or
concurrency boundary. Use real implementations; mocks are for external seams
that cannot run locally. Write failure modes and any isolated test before the
implementation it guards.

## During implementation

Run one affected E2E scenario when it exposes the behavior. For an isolated web
contract, run `pnpm test:file src/...` from the repository root; paths are
relative to `apps/web`. For PostgreSQL contracts use `pnpm test:file:postgres
src/...`. Read a failed run's ending and
`apps/web/.vitest-failures.txt` before deciding what to change; do not rerun an
unchanged tier to rediscover its failures.

One root agent owns any broad validation that the change needs. A subagent runs
only focused tests and returns its result, command, duration, relevant output,
and limits. Reuse valid results at handoff; choose checks for the changed behavior
rather than running a blanket `pnpm check` or affected suite. Keep expensive
local gates sequential.

## Commit, push, and merge

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
  hosted check, deployment path, or phone/PWA behavior.
