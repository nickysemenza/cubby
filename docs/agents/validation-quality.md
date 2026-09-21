# Quality and local diagnostics

`pnpm typecheck:web` is useful for web-only work. `pnpm check` runs the root
static checks, type checking, entity freshness, Knip, and script types.
`pnpm check:all` adds bindings, OpenAPI, orchestration tests, security checks,
and calendar Worker tests. CI checks dependency inputs after package manifest,
workspace file, patch, or lockfile changes; use `pnpm dedupe:check` locally when
diagnosing dependency duplication.

`pnpm verify:local` runs the clean-tree full graph sequentially. Its target
order is not dependency order; Nx supplies generation and build prerequisites.
`pnpm verify:local:full` sets `NX_SKIP_NX_CACHE=true`. Verifier entrypoints
disable the Nx daemon. Stop only processes this task started; use `pnpm exec nx
reset` after interrupting its own interactive Nx work.

Oxlint's project rules protect unsafe identifier boundaries and soft-delete
filters. Keep constraint-focused one-line local exceptions. Oxfmt owns
maintained web source and CSS, not generated files, Markdown, YAML, TOML, or
vendored/build output. Do not weaken a gate to accommodate a change.
