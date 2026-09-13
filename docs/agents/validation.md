# Validation, CI, and delivery

## Test placement

Choose by what can fail: unit (`*.unit.test.ts`, pure/node), UI
(`*.unit.test.tsx`, jsdom/RTL), PostgreSQL contract
(`*.integration.test.ts`, real constraints/transactions/queries), or E2E
(`tests/e2e/**/*.spec.ts`, built browser app). Write the lowest tier that can
expose the regression; do not duplicate the same assertion across tiers. Real
SQL invariants remain PostgreSQL tests. PGlite is an explicit developer
experiment, not an acceptance backend or a second copy of authoritative
coverage. Guard scripts that CI depends on remain load-bearing.

Default to real implementations at every tier. Pure tests call the real pure
module, UI tests render the real component tree, PostgreSQL tests observe real
database state, and browser tests use the built application. Do not mock owned
repositories, Drizzle transactions, internal modules, or transports merely to
avoid the appropriate tier; that couples tests to call shape instead of
behavior. Deterministic data builders are fixtures, not substitute
implementations. A test adapter is reserved for a genuine external seam whose
real implementation cannot run locally.

Unit and UI are separate Vitest projects — node vs. jsdom, per
`apps/web/vitest.config.ts` — and neither runs the other's files, so a change
touching any `.tsx` under `apps/web/src` needs `test:ui` too, even when
`test:unit` looks like the narrowest tier that can fail.

## Commands and ownership

While editing, run one file: `pnpm test:file src/…` from the repo root. That is
the spelling — the transcripts carried three competing ones (`pnpm vitest run`,
`pnpm exec vitest`, `npx vitest run`) for the same job. The path is relative to
`apps/web`, because that is where Vitest's root is; a repo-root-relative path
matches nothing and exits 1 with "No test files found". Use
`pnpm test:file:postgres src/…` for a PostgreSQL contract file. That command
resolves a source contract module to its owning family entrypoint, so it runs a
small real-PostgreSQL family without bypassing the authoritative manifest.

`pnpm test` runs all fast unit, UI, contract, and auxiliary-package tests;
`pnpm test:postgres` runs the retained PostgreSQL contracts; and
`pnpm test:e2e` runs the PostgreSQL-backed browser contracts. The legacy
`test:integration:postgres` and `test:e2e:postgres` names are aliases. Start
PostgreSQL with `docker compose -p cubby up -d` before either authoritative
database tier. `pnpm test:all` (also `test:local`) runs the fast tier first,
then PostgreSQL and Playwright concurrently.
Those authoritative tiers use distinct IntegreSQL template hashes so concurrent
template initialization cannot reset the browser database during a local run.

`pnpm test:pglite` is the explicit Docker-free PGlite experiment.
`pnpm test:e2e:pglite -- tests/e2e/<file>.spec.ts` runs a targeted browser
experiment on that backend. Neither command is part of `test`, `test:all`, CI,
or acceptance, and PGlite-only success is never evidence that a database change
is ready.

`pnpm test:changed` is likewise Docker-free and registers neither database
project. Use `pnpm test:changed:postgres <ref>` when changed integration
coverage needs the real backend.

**Never re-run a tier to find out what failed.** Every run ends with a compact
list of the failing tests, and writes the same list to
`apps/web/.vitest-failures.txt`, so a `| tail` or a later turn can both recover
it. 24% of all test runs used to be a re-run of one that had just failed.

Narrow the other gates too: `pnpm typecheck:web` is useful when only the web app
is touched. `pnpm check` runs full-tree Oxlint/Oxfmt, TypeScript,
entity freshness, Knip, script types, and the high-risk SQL/soft-delete guards
concurrently. `pnpm check:all` adds bindings, OpenAPI, all orchestration tests,
and security validation. Dependency
deduplication runs separately when a package manifest, workspace file, patch, or
lockfile changed; CI and pre-PR validation run the applicable superset.

Pre-commit runs the complete `pnpm check`. Pre-push runs `pnpm check` plus
changed Vitest/PostgreSQL, E2E, Cloudflare, auxiliary, per-manifest Rust, and
Apple gates from the commits being pushed, and never escalates to the full
suite. Hooks are mandatory: agents never use `--no-verify` to bypass a failure.

Local verification gates merging: run `pnpm verify:local` on the clean final
commit. This is the merge gate, and it does escalate: high-risk paths run the
full routine suite; use `pnpm verify:local:full` to force it. E2E always
follows a fresh web build. Hosted full verification and
coverage are explicitly dispatched when needed (see [CI](../ci.md)). Main builds
and deploys affected Workers automatically without repeating tests. If hosted
verification is requested, observe its exact final commit result before merge.
`claude-review` remains an opt-in PR label; previews are manually dispatched.

One agent owns a particular gate; other agents continue useful work and consume
the owner's distilled result instead of repeating it. At handoff report commands,
results, and limitations. Do not describe an unrun hosted suite as passing.

## Quality policy

Oxlint treats correctness and suspicious diagnostics as errors and rejects
unused disable directives. The repository intentionally leaves type-aware
linting and React Compiler rules disabled; compiler adoption needs its own
compatibility review. `vitest/require-mock-type-parameters` is also excluded
because the current Vitest mock surface cannot express that rule consistently.

The few other global exclusions encode repository-wide incompatibilities, not
finding baselines: React uses the automatic JSX runtime; table and chart render
callbacks are intentionally passed as component-valued props; lexical shadowing
and underscore-prefixed bindings are established schema and library interop
patterns; and mutating `sort`/`reverse` calls cannot be mechanically replaced by
copying variants without changing behavior. Intentional local exceptions to
enabled rules use a one-line Oxlint directive with a constraint-focused reason.

Oxfmt owns maintained JavaScript, TypeScript, JSX, TSX, JSON/JSONC, CSS, and HTML.
It sorts imports only in maintained web source, excluding generated files; sorts
Tailwind v4 classes in `cn`, `clsx`, and `cva`; and sorts package fields without
reordering scripts. Markdown/MDX, YAML, TOML, generated output, vendored UI, and
build artifacts remain outside the formatting domain. CSS is parsed and
formatted, but this repository intentionally has no semantic CSS lint layer or
JSON duplicate-key lint guarantee.

## PR and CI

Inspect failing check logs and annotations before editing. Fix only failures
caused by the change; retain unrelated flakes or infrastructure failures as
reported. Use an isolated worktree for PR maintenance when the configured
checkout must stay untouched. Outward-facing GitHub text never contains real
household data.

For detailed test/CI exceptions, load the relevant heading in [the preserved
root reference](root-rules-reference.md).
