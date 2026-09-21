# Domain and server rules

## Production changes

Serialize production schema changes: one owner verifies the migration and no
push overlaps another session. Inspect constraints/data, run relevant checks,
keep deployed and prepared code compatible, and use expand → backfill → deploy
→ cleanup for incompatible work. `db:push` is interactive: cancel ambiguous
rename/drop prompts. It does not diff CHECK constraints or partial-index WHERE
clauses; apply those deliberately and read the resulting schema back. Before a
`DROP COLUMN`, remove the `schema.ts` declaration and DEPLOY first — the
relational query builder selects every declared column, so the declaration is
the read.

Traps around `db:push`, all seen for real:

- The dev `DATABASE_URL` is the production Neon database, so `db:push` and MCP
  writes hit prod, and other sessions plus the UI write to it concurrently —
  point-in-time sweeps are unreliable.
- `db:push` from a worktree behind `main` proposes dropping tables that landed
  on `main` in the meantime. Fetch and merge `origin/main` first.
- Every plan includes a spurious drop/recreate of the `gin_trgm_ops` indexes
  and array-default `ALTER`s — persistent drift, not your change. Never
  `--force`; it auto-approves every data-loss statement including these.
- Adding a value to a `packages/schemas` pgEnum needs an expand-first
  `ALTER TYPE` in prod before deploy, and stales the cached IntegreSQL test
  templates (`apps/web/tooling/schema-template-inputs.ts` lists the inputs).
- Adding a column needs a full dev-server restart: the Drizzle client is cached
  on `globalThis` across HMR, and a stale schema silently omits the column from
  `SELECT`s (reads as `null`).

## Data, layers, and deletion

`Database` is a request-scoped handle: routers pass it onward, services
orchestrate, and repos alone call `getDb`; transactions use `withTransaction`.
The repository helper is the sanctioned client-resolution boundary. A service earns existence for
cross-cutting enrichment/compute/rollups, not pass-throughs. Cubby domain
compute belongs in recipebridge/WASM; TypeScript assembles inputs and reshapes
outputs instead of recreating it.

Expenses are legitimately negative — refunds, sales, and large family
contributions — so any rollup that filters `total > 0` silently drops
net-negative trade rows and disagrees with its grand total. Treat negatives as
credits and reconcile visible breakdowns against totals before shipping a chart.

Major entities soft-delete. Use `notDeleted`, including `exists`/`notExists`
subqueries unless an `includes-deleted: <reason>` comment makes the exception
intentional. Removal paths clean `SearchDocument` and `EntityEmbedding` in the
same transaction and propagate dependent staleness. Declare exhaustive,
operation-specific incoming-edge policy from `entity-incoming-edges.ts`.
Deletes and merges have no live preview — attempt the mutation and read its
structured refusal. Attach/detach previews stay advisory, and mutations
re-check transactionally regardless.

## IDs and runtime traps

Use branded identifier schemas and parse strings once at genuine ingress seams
(auth, persisted JSON, external input, DOM events, imports, and raw SQL). Typed
producers and resolvers return branded values directly; never reconstruct a
brand with an assertion or unsafe converter. Tests use the deterministic
schema-backed factories from `@cubby/schemas/testing`. UUIDs never enter URLs or
MCP—shortcodes do. Resolve codes through `shortcode-resolver`, mint through
`insertWithShortcode`, never reuse them, and keep `shortcodeSchema` a
`ZodString`.

Drizzle raw-`sql` traps: an interpolated column renders **unqualified** on a
single-table select, so a correlated subquery over the same table silently
self-joins (use `sql.raw` with hand-qualified names); a JS array interpolates as
a **row constructor**, not a Postgres array (use `eqAny`/`inArray`/
`arrayOverlaps`/`uuidArrayParam`; the `no-unsafe-sql-array-interpolation`
Oxlint rule guards it). A new FK that closes a loop between tables makes every
table in the loop infer as `any` (TS7022) unless the `.references()` callback
is annotated `(): AnyPgColumn =>`. A new incoming FK edge also trips the
hardcoded `EXPECTED_EDGE_COUNT` in `detectors-integrity.ts`, which `pnpm check`
cannot see, on top of the exhaustive `Record<Entity, …>` registries.

Inside the entity kernel's write transaction every DB touch must go through the
transaction-bound context: a service still bound to the request pool that
updates the row the transaction holds deadlocks silently, and only E2E on
workerd exposes it. A Product/Purchase data exception fingerprints the inputs
its check reads (for example, the live Expense count or primary-document set),
not `updatedAt`: unrelated edits must not reopen it, while changed evidence
must. SQL predicates and hydrated output share that contract; legacy
`updatedAt` fingerprints remain stale until an explicit migration proves the
old exception is still active.

Unit vocabulary derives from `recipebridge`'s `size_unit_aliases()`; the TS
title matcher and the Postgres prefilter both build from it — never hand-list
unit spellings. The ingredient crate is a *recipe* grammar, so `cup`/`q`/`tsp`
in product titles name cavities, part numbers and vessel capacities; the
derived vocabulary is narrowed by `RECIPE_MEASURE_STEMS` for that reason.
`pnpm run wasm` builds into a `CARGO_TARGET_DIR` shared across checkouts, so
another checkout can silently poison the output — "Finished in 0.5s" plus
missing exports is the tell; rebuild.

On workerd, wall clocks omit synchronous CPU: use CPU-time/sampling for WASM or
JS hot paths. WASM hot-path tracing stays `trace, skip_all`; a global INFO
subscriber accumulates in reused isolates.

## MCP and observability traps

Read [MCP operating patterns](mcp.md) for bounded reads, batch writes, file
uploads, and verification.

MCP clients reject `structuredContent` on an `isError` result, so a domain
refusal is returned as data (the `canProceed` shape), never as an error with
structured content. A bare Zod issue array from a tool that names a field
absent from its input means the **output** schema rejected the handler's
return. The MCP tool registry is snapshotted at session start — a deploy that
adds tools needs a session restart. `/api/mcp` is OAuth 2.1 only;
dot-directory routes are invisible to the router generator, and `wrangler dev`
rewrites URL-bearing response headers. A zero `idx_scan` in prod usually means
an index is eligible but unexercised, not droppable — audit every call site with
`EXPLAIN` first; the genuinely dead ones are `OR`'d against an unindexed column.

## Generated files

Generated output is identified by its generated header or `.gitattributes`, not
by a directory or suffix: generated routes and Swift bindings have different
paths. Never hand-edit one — edit its generator or input and regenerate. A
missing expected output means run its owning generator and investigate the
reported failure.

Entity route modules: the generator emits the list/detail modules from
`route.list` / `route.detail` (`apps/web/src/routes/_authenticated/<basePath>.index.tsx`
and `.$shortcode.tsx`) sit beside the hand-written routes with no `.gen.`
suffix, because TanStack's file router needs physical files there and a
`__virtual.ts` would take over the whole directory. They carry the generated
header, so `generate:check` still catches a stale or hand-edited one, and each
is listed explicitly in `.gitattributes`. To customize one, set that
`route.list` / `route.detail` to `null` in the declaration and write the file.
