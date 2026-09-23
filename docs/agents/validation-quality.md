# Quality and local diagnostics

`pnpm typecheck:web` is useful for web-only work. `pnpm check` runs the root
static checks, type checking, entity freshness, Knip, and script types.
`pnpm check:all` adds bindings, OpenAPI, orchestration tests, security checks,
and calendar Worker tests. CI runs `pnpm dedupe:check` when code validation is
selected; use it
locally when diagnosing dependency duplication.

`pnpm verify:local` runs the clean-tree full graph sequentially. Its target
order is not dependency order; Nx supplies generation and build prerequisites.
`pnpm verify:local:full` sets `NX_SKIP_NX_CACHE=true`. Verifier entrypoints
disable the Nx daemon. Stop only processes this task started; use `pnpm exec nx
reset` after interrupting its own interactive Nx work.

Oxlint's project rules protect unsafe identifier boundaries and soft-delete
filters. Keep constraint-focused one-line local exceptions. Oxfmt owns
maintained source, CSS, Markdown, MDX, YAML, and TOML; generated files,
the pnpm lockfile, and vendored/build output remain excluded. Do not weaken a
gate to accommodate a change.

Never hand-merge a generated file. With the `cubby-generated` merge driver
registered (`pnpm install` does it), a conflicting generated file keeps the
current side and the post-merge/post-rewrite hook reruns `pnpm generate` (and
the CubbyAPI generator when the OpenAPI document changed); commit what it
regenerates. Without the driver, take either side and run `pnpm generate`.
