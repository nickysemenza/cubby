# Validation, CI, and delivery

## Test placement

Choose by what can fail: unit (`*.unit.test.ts`, pure/node), UI
(`*.unit.test.tsx`, jsdom/RTL), integration (`*.integration.test.ts`, real
Postgres through IntegreSQL), E2E (`tests/e2e/**/*.spec.ts`, built browser app).
Write the lowest tier that can expose the regression; do not duplicate the same
assertion across tiers. Real SQL invariants remain integration tests. Guard
scripts that CI depends on remain load-bearing.

## Commands and ownership

While editing, run one file: `pnpm test:file src/…` from the repo root. That is
the spelling — the transcripts carried three competing ones (`pnpm vitest run`,
`pnpm exec vitest`, `npx vitest run`) for the same job. The path is relative to
`apps/web`, because that is where Vitest's root is; a repo-root-relative path
matches nothing and exits 1 with "No test files found". It works for any tier,
including a single `*.integration.test.ts`, which is bounded and cheap.

`pnpm test:unit`, `pnpm test:ui`, `pnpm test:integration` (requires
`docker compose -p cubby up -d`), and `pnpm test:e2e` are the whole-tier
commands. Reserve full `pnpm test` for pre-PR or cross-layer work.

**Integration is opt-in.** A bare `vitest run` no longer registers the
integration project, so it cannot silently cost ten minutes; reach it with
`--project integration`, `pnpm test:integration`, or `CUBBY_TEST_INTEGRATION=1`.
That tier was 1,879 invocations and 12h over three weeks — more than unit, ui,
and e2e combined — so it is a decision, not a reflex.

**Never re-run a tier to find out what failed.** Every run ends with a compact
list of the failing tests, and writes the same list to
`apps/web/.vitest-failures.txt`, so a `| tail` or a later turn can both recover
it. 24% of all test runs used to be a re-run of one that had just failed.

Narrow the other gates too: `pnpm format:changed` (~1s) over `pnpm format:write`
(~18s), and `pnpm typecheck:web` when only the web app is touched. `pnpm check`
runs the fast core gates concurrently. `pnpm check:all` adds dependency,
bindings, OpenAPI, security, and CI-scope validation; CI and pre-PR validation
run that superset.

One agent owns a particular gate; other agents continue useful work and consume
the owner's distilled result instead of repeating it. At handoff report commands,
results, and limitations. CI remains authoritative and runs full coverage.

## PR and CI

Inspect failing check logs and annotations before editing. Fix only failures
caused by the change; retain unrelated flakes or infrastructure failures as
reported. Use an isolated worktree for PR maintenance when the configured
checkout must stay untouched. Outward-facing GitHub text never contains real
household data.

For detailed test/CI exceptions, load the relevant heading in [the preserved
root reference](root-rules-reference.md).
