# Quality and local diagnostics

`pnpm typecheck:web` checks web app code for web-only work; it leaves out
tests and test tooling, about 20% faster. When tests or test tooling change,
include `pnpm typecheck:web:tests` as an affected check: passing Vitest does not
prove those files typecheck. This checks the full program that `pnpm check` and
CI run. Tests use the configured TypeScript libraries; runtime support for an
API does not establish that the configured libraries expose it.
Use these rather than a raw `tsc`: the wrapper discards a stale incremental
cache and holds one of two machine-wide slots, since each web check keeps
5–7 GB resident ([measurements](../local-check-performance.md#typechecking)).
`pnpm check` runs the root
static checks, type checking, entity freshness, Knip, and script types.
`pnpm check:all` adds bindings, OpenAPI, orchestration tests, security checks,
and calendar Worker tests. CI runs `pnpm dedupe:check` when code validation is
selected; use it
locally when diagnosing dependency duplication.

The `knip` gate also runs `pnpm knip:production`, which fails on a file or
dependency the production graph never reaches. A script invoked only by a hook,
CI, or package script needs a `!` entry in `knip.json`; a test seam (fixture,
mock, harness) belongs in the negated `project` patterns. Name reusable test
fixtures `*.fixtures.ts` or `*.fixtures.tsx` to match the existing exclusion;
do not add production entry points or per-file ignores for test-only modules.
Scoped lint tests temporarily write under `apps/web/src/server/.lint-fixture-*`
so path-sensitive rules execute. Knip excludes only that disposable directory
pattern because its scan runs concurrently with those tests; lint still checks
the fixtures and removes them afterward. Persisted sampled-path regressions
select their path explicitly through the existing service ports rather than
hoping randomly generated record IDs enter the production sample.

`pnpm verify:local` runs the clean-tree full graph sequentially. Its target
order is not dependency order; Nx supplies generation and build prerequisites.
`pnpm verify:local:full` sets `NX_SKIP_NX_CACHE=true`. Verifier entrypoints
disable the Nx daemon. Stop only processes this task started; use `pnpm exec nx
reset` after interrupting its own interactive Nx work.

Merge-gate targets key on the broad `gate` input in `nx.json`, so a cached pass
is reused only for identical non-documentation content and toolchain. A target
that starts reading something outside that set (an ignored file, Markdown, an
environment variable, a tool outside the workspace) must add it to its inputs,
or a cached pass can hide a regression ([CI](../ci.md#cache-keys-and-the-remote-cache)).

Oxlint's project rules protect unsafe identifier boundaries and soft-delete
filters. Keep constraint-focused one-line local exceptions. Oxfmt owns
maintained source, CSS, Markdown, MDX, YAML, and TOML; generated files,
the pnpm lockfile, and vendored/build output remain excluded. Do not weaken a
gate to accommodate a change.

Generated output is never committed. `pnpm install`, `build`, `typecheck` and
every test entry point run `scripts/generator/ensure.ts`, which reruns
`pnpm generate` when its inputs changed; `pnpm generate` forces a run. The
Swift OpenAPI client is built by the swift-openapi-generator SwiftPM plugin
and the UniFFI shim by `apps/apple/scripts/build-rust.sh`.
