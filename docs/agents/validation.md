# Validation, CI, and delivery

## Test placement

Choose by what can fail: unit (`*.unit.test.ts`, pure/node), UI
(`*.unit.test.tsx`, jsdom/RTL), PostgreSQL contract
(`*.integration.test.ts`, real constraints/transactions/queries), or E2E
(`tests/e2e/**/*.spec.ts`, built browser app). Write the lowest tier that can
expose the regression; do not duplicate the same assertion across tiers. Real
SQL invariants remain PostgreSQL tests. Guard scripts that CI depends on remain
load-bearing.

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
runs the given file directly against the `integration` Vitest project — there
is no family resolver or entrypoint indirection; every `*.integration.test.ts`
file under `apps/web/src` is its own Vitest test file.

`pnpm test` runs all fast unit, UI, contract, and auxiliary-package tests;
`pnpm test:postgres` runs the retained PostgreSQL contracts; and
`pnpm test:e2e` runs the PostgreSQL-backed browser contracts. The legacy
`test:integration:postgres` and `test:e2e:postgres` names are aliases. On macOS these commands start disposable Apple PostgreSQL
and IntegreSQL containers and remove them afterward; independent commands use
independent pairs. CI/Linux use external services; the Docker fallback is
`docker compose -p cubby up -d` plus `CUBBY_TEST_SERVICES=external`.
`pnpm test:all` (also `test:local`) runs the fast tier, then PostgreSQL, then
Playwright — one container pair, sequentially. Running the PostgreSQL and
Playwright tiers concurrently (6 vitest forks plus 3 Playwright workers, each
with its own workerd and browser, on an 8-core host) was the primary cause of
E2E flakes: hydration waits and SSR session lookups compete for the same
starved main thread and database connections that the concurrent PostgreSQL
contract run is also using. Sequencing removes that contention by
construction; see [CI](../ci.md) for the measurements behind the change.
Those authoritative tiers still use distinct IntegreSQL template hashes so a
later template initialization cannot reset an earlier tier's checked-out
databases.

`pnpm test:changed` is likewise Docker-free and registers neither database
project. Use `pnpm test:changed:postgres <ref>` when changed integration
coverage needs the real backend.

Tier-specific traps: target a browser file as `pnpm test:e2e <spec>` without an
extra `--`; the E2E reporter rejects an empty test run. Local E2E serves whatever
is in `dist/`; a green run after a
stale build proves nothing (`verify:local` builds first). A standalone
`request.newContext()` in E2E is *not* cookie-less — it inherits the project's
`storageState`, so unauthenticated API assertions need
`storageState: { cookies: [], origins: [] }`. RTable's placeholder-transition
curtain is an inert `<tbody>` that silently eats clicks, so an E2E cell edit
retries open+fill as one unit via `editListCell`, never gating on
`aria-busy="false"`; open cell editors are not torn down by refetches. A `.unit.test.ts` importing a
`.tsx` through the `~` alias fails to resolve in the node project; keep pure
logic in an alias-free `.ts`. `pnpm check:all` does not run other packages'
Vitest suites — `pnpm -r --filter '!@cubby/web' run test` after touching
`packages/*`.

**Never re-run a tier to find out what failed.** Every run ends with a compact
list of the failing tests, and writes the same list to
`apps/web/.vitest-failures.txt`, so a `| tail` or a later turn can both recover
it. Measured: 24% of all test runs were a re-run of one that had just failed.

Narrow the other gates too: `pnpm typecheck:web` is useful when only the web app
is touched. `pnpm check` runs full-tree Oxlint/Oxfmt, TypeScript,
entity freshness, Knip, and script types concurrently; the high-risk
SQL/soft-delete and unsafe-identifier guards are Oxlint rules now (see Quality
policy below), not a separate script step. `pnpm check:all` adds bindings,
OpenAPI, all orchestration tests, security validation, and the calendar
Durable Object tests (`workers-tests`). Dependency deduplication
(`pnpm dedupe:check`) is a separate manual step now — it does not run inside
`verify:local`/`verify:push`; run it yourself after a package manifest,
workspace file, patch, or lockfile change. Hosted CI runs it separately when
those dependency inputs change.

Pre-commit runs the complete `pnpm check`. Pre-push runs `pnpm verify:push`: it
requires a clean tree before and after one sequential `nx affected` graph over
`generate,types,lint,format,knip,test,postgres,build-cf,e2e,rust,apple-check`,
explicitly comparing `--base=origin/main --head=HEAD`, with `--nxBail` and
static output. Refresh the local `origin/main` ref before pushing when needed;
it must be the intended comparison point. Nx project relationships determine
affected selection and prerequisite ordering, while target `inputs` and
`dependentTasksOutputFiles` determine cache reuse. A web-only push can therefore
skip the `rust` and `apple-check` targets, while Rust changes select web through
its declared `recipebridge` relationship. The target-list order is not an
execution-order guarantee. There is no separate trailing `pnpm check`, and the push gate does
not escalate to the full suite. Hooks are mandatory: agents never use
`--no-verify` to bypass a failure. Pre-commit checks the **whole working tree**,
not the index, so a commit fails while any concurrent agent's files are mid-edit
— stage early and commit between agent waves. Regenerated files (`routeTree.gen.ts`
and friends) are fine to commit; do not revert generated churn. Pre-commit does
not `cargo fmt` recipebridge; the pre-push gate's `rust` target does, so check
Rust formatting before pushing.

Local verification gates merging: run `pnpm verify:local` on the clean final
commit (`nx run-many -t
generate,types,lint,format,knip,test,postgres,build-cf,e2e,rust,apple-check --parallel=1`).
The reusable clean-tree check rejects staged, unstaged, and untracked files
before the graph and confirms the tree remains clean afterward. This is the
merge gate. Unlike the deleted `ci-scope.ts`, there is no separate "high-risk"
classification that escalates it — `verify:local` always runs the full target
list. Selected cached targets may replay, but E2E is uncached and always runs;
its `build-cf` dependency ensures the served bundle is current and may itself
reuse a cache entry. The textual target-list order is not a dependency guarantee;
Nx's graph supplies WASM-before-consumer and build-before-E2E ordering.
`pnpm verify:local:full` sets `NX_SKIP_NX_CACHE=true` to force every target to
actually run, which is what a high-risk or pre-release change should use.
Hosted full verification and coverage are explicitly dispatched when needed
(see [CI](../ci.md)). Main builds and deploys affected Workers automatically
without repeating tests. If hosted verification is requested, observe its exact
final commit result before merge. `claude-review` remains an opt-in PR label;
previews are manually dispatched.

These changes reduce duplicate work and stale generated-artifact cache paths,
but do not promise that two simultaneous full verifications are resource-safe
on one machine.

One agent owns a particular gate; other agents continue useful work and consume
the owner's distilled result instead of repeating it. Subagents run `pnpm
test:file` only; `pnpm typecheck`, `pnpm check`, `pnpm test`, and Apple builds
belong to the root's single final join, never to parallel implementers: each
native `tsc` is ~3 GB RSS and xcodebuild fans out swift-frontend jobs at 1–2 GB
each on a 24 GB machine, so three parallel implementers each running typecheck
is what took the box's one-minute load to 200. At handoff report commands,
results, and limitations. Do not describe an unrun hosted suite as passing.

## Phone acceptance

Changes to phone navigation, safe areas, keyboard handling, or installed-PWA
launch/return behavior need a physical iPhone Safari and installed-PWA pass
before merge. Exercise the affected workflows and record the device, modes,
observed behavior, and remaining gaps. Playwright WebKit and simulator runs
provide automated coverage, not physical-device signoff. Reconcile historical
"QA pending" notes with current evidence before carrying them into a worklist.

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

The `cubby` Oxlint plugin (`tools/oxlint/cubby/`) ports two former standalone
scripts. `cubby/no-unsafe-identifiers` (repo-wide `error`, off for `*.test.*`,
`*.spec.*`, `*.fixtures.*`, `tests/`, `test/`, `__fixtures__/`, `test-support/`,
and `tooling/` paths, and `packages/*/src/testing.ts`) replaces the deleted
`scripts/check-unsafe-identifiers.ts`. Its `unsafe-helper-declaration`/
`unsafe-helper-import`/`unsafe-helper-call` checks are exact, purely syntactic
ports. Its `branded-assertion` check is NOT: the deleted script walked
import/re-export chains across files to resolve whether an asserted-to type was
ultimately branded; a single-file Oxlint rule cannot see another file's AST, so
this rule only resolves types and values declared in the SAME file. Asserting a
value into a type/alias imported from elsewhere is not flagged even when that
type is branded at its declaration site — an accepted, documented coverage loss
(operator decision). `anti-slop/require-safety-comment-for-type-assertion`
still requires a `SAFETY:` comment on every non-const assertion regardless, so
an unflagged branded assertion on an imported alias still needs a justification
comment. `cubby/require-soft-delete-filter` (scoped to
`apps/web/src/server/**/*.ts` and `packages/*/src/**/*.ts`, excluding
`*.test.ts`) replaces the deleted `scripts/check-soft-delete-filters.ts` +
`scripts/schema-storage.ts`; its soft-deletable table catalog is parsed once,
at plugin load, directly from `schema.ts` + the generated entity-columns file —
the same parser the deleted `schema-storage.ts` used — never from the
`application-schema.json` snapshot, whose `lowerFirst(sqlName)` convention does
not hold for the `oauth_*` auth tables.

Oxfmt owns maintained JavaScript, TypeScript, JSX, TSX, JSON/JSONC, CSS, and HTML.
It sorts imports only in maintained web source, excluding generated files; sorts
Tailwind v4 classes in `cn`, `clsx`, and `cva`; and sorts package fields without
reordering scripts. Markdown/MDX, YAML, TOML, generated output, vendored UI, and
build artifacts remain outside the formatting domain. CSS is parsed and
formatted, but this repository intentionally has no semantic CSS lint layer or
JSON duplicate-key lint guarantee.

## PR and CI

A step that exists only in `deploy.yaml` cannot run on a PR, so its own CI
merges green and it breaks the first post-merge deploy. Verify deploy-path
steps against the CI service token's scopes, never local credentials.
Unresolved GitHub review threads on old PRs are stale bookkeeping, not a
worklist — verify against HEAD before acting. Reusing a branch after its PR was
squash-merged can create follow-up conflicts. Prefer a fresh branch from current
main; inspect and resolve conflicts on a reused branch individually.

Inspect failing check logs and annotations before editing. Fix only failures
caused by the change; retain unrelated flakes or infrastructure failures as
reported. Use an isolated worktree for PR maintenance when the configured
checkout must stay untouched. Outward-facing GitHub text never contains real
household data.
