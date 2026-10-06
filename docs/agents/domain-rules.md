# Domain and server rules

## Production changes

Serialize production schema changes: one owner verifies the migration and no
application overlaps another session. Inspect constraints/data, run relevant checks,
and transform existing rows in the same migration that changes their shape;
clients update with the change ([breaking changes](../../AGENTS.md#breaking-changes)).
Schema reaches every database only through
committed migrations in `apps/web/drizzle/`: `pnpm db:generate` writes them
(drizzle-kit for `schema.ts`, plus a custom migration when the derived DDL in
`src/server/db/derived-ddl.ts` changes), and `pnpm db:migrate
--target=production` applies them with `PRODUCTION_DIRECT_DATABASE_URL`.
Migrations are the one committed generated artifact and are immutable once
merged — the runner refuses bookkeeping that is not a prefix of the journal.
A data transform is a custom migration (`drizzle-kit generate --custom`). CI `db:check` fails when `schema.ts` has no migration or the
migrations build a catalog different from `schema.ts`; `tooling/db-catalog.ts`
reads the same catalog from production. Before a
`DROP COLUMN`, remove the `schema.ts` declaration and DEPLOY first — the
relational query builder selects every declared column, so the declaration is
the read. The reverse also bites: an undeclared legacy table or column keeps
its foreign keys, so a new write path that hard-deletes the referenced row
fails until the drop. Either drop the legacy FKs in the expand step or run the
drop right after the deploy (the ADR 0006 image joins blocked image deletes
this way).

Traps, all seen for real:

- Local startup, fixtures, integrations, runtime inspection, and simulator
  discovery follow [local development](../local-development.md). `pnpm dev`
  supplies a guarded checkout database and ignores production env files.
  Explicit production MCP/database access still reaches the shared household;
  concurrent sessions make point-in-time production sweeps unreliable.
  `db:migrate` uses its explicit target, never the application's `DATABASE_URL`.
- Migrations from parallel branches can interleave: drizzle skips a journal
  entry older than the last applied one, so regenerate after merging `main`
  (`db:check` rejects an out-of-order journal).
- Enum-like columns are text with a CHECK generated from a `packages/schemas`
  value array. Adding a value widens that CHECK, so `db:generate` emits a
  migration that must reach prod before the code that writes the value deploys.
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

`Product.tags` (and any future `control.suggest.mode: "prune"` text-array) is
compatibility/ecosystem tokens only — never the manufacturer, a classification
word, or a path node, which belong in `manufacturer`/`categoryId`; a tag that
merely restates one of those is flagged for removal, not silently dropped. The
shared rule lives in `redundantTokens` (`@cubby/shared/redundant-tokens`) —
both the browser form's deterministic chip marking and the server's
`ArrayPruneSuggestSpec` entries (`apps/web/src/server/ai/field-suggest/registry.ts`)
call it, so a new prune target never re-derives the redundancy check.

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
is annotated `(): AnyPgColumn =>`. A new `must-target-live` incoming FK edge
also needs a `SOURCE_FACTORIES` fixture in
`detectors-integrity.integration.test.ts`, which `pnpm check` cannot see, on
top of the exhaustive `Record<Entity, …>` registries.

Calendar days are household days (`America/Los_Angeles`), and Workers run in
UTC. A plain date (`YYYY-MM-DD`: due dates, expense and purchase dates) is
shifted and compared only with `shiftPlainDate`/`plainDateDaysBetween`; the day
an instant happened on is `householdLocalDate(instant)` (`~/lib/household-date`).
Timestamp columns are `timestamp without time zone` holding UTC wall time, so
SQL `::date` and `date_trunc('day', …)` on them are UTC days: use
`householdDaySql` and bound day filters with `householdDayRangeConditions`
(`server/repo/database-helpers`). Deliberate UTC days — retained-settlement
payment keys that must match `chargedAt::date`, operational bucket keys — carry
a disable comment with the reason.

Inside the entity kernel's write transaction every DB touch must go through the
transaction-bound context: a service still bound to the request pool that
updates the row the transaction holds deadlocks silently, and only E2E on
workerd exposes it. A data exception's fingerprint is declared per check in
that check's registry binding (`CheckBinding.fingerprint(t)` in
`apps/web/src/server/repo/data-quality/checks/<entity>.ts`) — the inputs it
reads, for example the live Expense count or primary-document set — not
`updatedAt`: unrelated edits must not reopen it, while changed evidence must.
Hydration and the filter/sort SQL evaluate that same binding (one SQL
expression per check, shared by `hydrate.ts` and `sql.ts`), so the two paths
cannot drift apart; legacy `updatedAt` fingerprints remain stale until an
explicit migration proves the old exception is still active.

Unit vocabulary derives from `recipebridge`'s `size_unit_aliases()`; the TS
title matcher and the Postgres prefilter both build from it — never hand-list
unit spellings. The ingredient crate is a _recipe_ grammar, so `cup`/`q`/`tsp`
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

Generated output is gitignored and never committed; it is identified by its
generated header. Never hand-edit one — edit its generator or input and run
`pnpm generate` (install, build, typecheck and tests run it when inputs
changed). A missing expected output means run its owning generator and
investigate the reported failure.

Entity route modules: the generator emits the list/detail modules from
`route.list` / `route.detail` (`apps/web/src/routes/_authenticated/<basePath>.index.tsx`
and `.$shortcode.tsx`) beside the hand-written routes with no `.gen.`
suffix, because TanStack's file router needs physical files there and a
`__virtual.ts` would take over the whole directory. A generated `.gitignore`
in that directory ignores them, and `pnpm generate` deletes one it no longer
emits. To customize one, set that `route.list` / `route.detail` to `null` in
the declaration and write the file. Entities with `route.create: "dialog"`
also get a generated `<basePath>.new.tsx` that redirects to the list with
`?create=true`; `"page"` entities keep a hand-written `.new.tsx`.
