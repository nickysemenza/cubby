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

Narrow the other gates too: `pnpm check:staged` checks only staged JavaScript
and TypeScript plus formattable files, and `pnpm typecheck:web` is useful when
only the web app is touched. `pnpm check` runs full-tree Oxlint/Oxfmt, TypeScript,
entity freshness, Knip, script types, and the high-risk SQL/soft-delete guards
concurrently. `pnpm check:all` adds bindings, OpenAPI, all orchestration tests,
and security validation. Dependency
deduplication runs separately when a package manifest, workspace file, patch, or
lockfile changed; CI and pre-PR validation run the applicable superset.

Pre-commit runs `pnpm check:staged` and the complete `pnpm check`. Pre-push
selects changed Vitest, PostgreSQL, E2E, Cloudflare, auxiliary, and Rust gates
from the commits being pushed. Hooks are mandatory: agents never use
`--no-verify` to bypass a failure.

CI runs affected Vitest projects on ordinary revisions. The persistent
`ci:full` label requests every web, PostgreSQL, browser, build, and relevant Rust
gate; high-risk paths request the same automatically. Before merging, agents
keep `ci:full` applied and verify that the exact final commit has a green full
run. `preview` and `claude-review` are opt-in PR labels.

One agent owns a particular gate; other agents continue useful work and consume
the owner's distilled result instead of repeating it. At handoff report commands,
results, and limitations. CI remains authoritative and runs full coverage.

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
