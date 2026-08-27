# Validation, CI, and delivery

## Test placement

Choose by what can fail: unit (`*.unit.test.ts`, pure/node), UI
(`*.unit.test.tsx`, jsdom/RTL), portable integration (`*.integration.test.ts`,
PGlite plus PostgreSQL in CI), PostgreSQL-only integration (independent
sessions, locks, pools, driver behavior), or E2E (`tests/e2e/**/*.spec.ts`, built
browser app). Write the lowest tier that can expose the regression; do not
duplicate the same assertion across tiers. Real SQL invariants remain database
tests. Guard scripts that CI depends on remain load-bearing.

Unit and UI are separate Vitest projects — node vs. jsdom, per
`apps/web/vitest.config.ts` — and neither runs the other's files, so a change
touching any `.tsx` under `apps/web/src` needs `test:ui` too, even when
`test:unit` looks like the narrowest tier that can fail.

## Commands and ownership

While editing, run one file: `pnpm test:file src/…` from the repo root. That is
the spelling — the transcripts carried three competing ones (`pnpm vitest run`,
`pnpm exec vitest`, `npx vitest run`) for the same job. The path is relative to
`apps/web`, because that is where Vitest's root is; a repo-root-relative path
matches nothing and exits 1 with "No test files found". Portable integration
files registered in the `pglite-integration` project stay Docker-free. Use
`pnpm test:file:postgres src/…` for a PostgreSQL-only integration file.

`pnpm test:unit`, `pnpm test:ui`, and `pnpm test:pglite` are the whole local
Vitest tiers. `pnpm test:e2e tests/e2e/<file>.spec.ts` is the normal targeted
browser loop; `pnpm test:e2e` runs the optional full browser suite. Those
commands use PGlite and need no Docker. The PGlite E2E lane is intentionally
serialized because its PostgreSQL socket multiplexer is not safe under
concurrent mutation-heavy specs. `pnpm test:integration:postgres` and
`pnpm test:e2e:postgres` select IntegreSQL for local parity after
`docker compose -p cubby up -d`. Reserve full `pnpm test` or `pnpm test:local`
for pre-PR or cross-layer work.

**Full PostgreSQL integration is opt-in.** A bare `vitest run` registers the
small portable PGlite subset, but not the complete PostgreSQL project, so it
cannot silently cost ten minutes or require Docker. Reach the complete project
with `--project integration`, `pnpm test:integration:postgres`, or
`CUBBY_TEST_INTEGRATION=1`. That tier was 1,879 invocations and 12h over three
weeks — more than unit, ui, and e2e combined — so it is a decision, not a
reflex. CI remains authoritative: portable integration files run against both
PGlite and PostgreSQL, and every lock/concurrency/driver contract runs against
PostgreSQL.

`pnpm test:changed` is likewise Docker-free and does not register the
PostgreSQL-only project. Use `pnpm test:changed:postgres <ref>` when changed
integration coverage needs the real backend.

**Never re-run a tier to find out what failed.** Every run ends with a compact
list of the failing tests, and writes the same list to
`apps/web/.vitest-failures.txt`, so a `| tail` or a later turn can both recover
it. 24% of all test runs used to be a re-run of one that had just failed.

Narrow the other gates too: `pnpm format:changed` (~1s) over `pnpm format:write`
(~18s), and `pnpm typecheck:web` when only the web app is touched. `pnpm check`
runs changed-file Biome, TypeScript, entity freshness, script types, and the
high-risk SQL/soft-delete guards concurrently. `pnpm check:all` adds full-tree
Biome, Knip, bindings, OpenAPI, security, and CI-scope validation. Dependency
deduplication runs separately when a package manifest, workspace file, patch, or
lockfile changed; CI and pre-PR validation run the applicable superset.

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
