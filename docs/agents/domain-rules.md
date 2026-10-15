# Domain and server rules

## Breaking changes

One trusted household uses Cubby, and we ship and refresh every client (web,
iOS/macOS, HTTP, MCP connections), so change contracts in place:

- Change an API, RPC, MCP tool, manifest, or stored shape directly, update
  every client in the same change, and delete the old shape. A client running
  old code reloads, reconnects, or updates; a wire break for the native app
  bumps `APPLE_CLIENT_COMPATIBILITY_VERSION` in
  `packages/shared/src/apple-client-version.ts` (shared by the server minimum
  and generated Apple marketing version).
- Household data is real: carry it through a migration that transforms it.

## Production changes

For staged expand/contract commands and exact `--through` boundaries, follow the
[production migration runbook](../runbooks/production-migrations.md).

Serialize production schema changes: one owner verifies the migration and no
application overlaps another session. Inspect constraints/data, run relevant checks,
and transform existing rows in the same migration that changes their shape;
clients update with the change ([breaking changes](#breaking-changes)).
Establish data preservation before pushing, then verify the applied schema.
Schema reaches every database only through
committed migrations in `apps/web/drizzle/`: `pnpm db:generate` writes them
(drizzle-kit for `schema.ts`, plus a custom migration when the derived DDL in
`src/server/db/derived-ddl.ts` changes), and `pnpm --filter @cubby/web
db:migrate --target=production` applies them with
`PRODUCTION_DIRECT_DATABASE_URL`.
Run `db:generate` with a TTY and unredirected stdout when Drizzle asks create/rename questions. An interactive-prompt diagnostic can still leave a derived-only journal entry; inspect the journal and schema SQL before treating generation as complete.

Migrations are the one committed generated artifact and are immutable once
merged — the runner refuses bookkeeping that is not a prefix of the journal.
A stored-shape transform accompanying schema work is a custom migration
(`drizzle-kit generate --custom`). For an explicitly authorized one-off data-only
correction, use a transactional update and verify preservation and read-back;
keep the script outside the repository and add no journal entry or schema guard
solely to route it through migrations. CI `db:check` fails when `schema.ts` has no migration or the
migrations build a catalog different from `schema.ts`; `tooling/db-catalog.ts`
reads the same catalog from production. Before a
`DROP COLUMN`, remove the `schema.ts` declaration and DEPLOY first — the
relational query builder selects every declared column, so the declaration is
the read. The reverse also bites: an undeclared legacy table or column keeps
its foreign keys, so a new write path that hard-deletes the referenced row
fails until the drop. Either drop the legacy FKs in the expand step or run the
drop right after the deploy (the ADR 0006 image joins blocked image deletes
this way).

`deploy.yaml` deploys every `main` push and never applies schema. A PR that adds
a migration is opened without auto-merge and merges only after that migration
has run in production and been read back. A contract migration (`DROP COLUMN`,
or a constraint the deployed code would violate) is the exception: ship the code
that stops reading or writing the old shape first, then apply the migration
right after that deploy and read it back.

An explicitly authorized breaking cutover may consolidate expansion and
contraction before merge; follow its owning runbook. Prefer quiesced writers;
when the member explicitly keeps services enabled, lock retired copy/drop
sources before reading them and hold the locks through commit. Observed idleness
is not a barrier. Verify SQL preservation before merge, deploy matching code
immediately, and run historical accepted-reference promotion only after old
in-flight work finishes. Verify preservation, client delivery, and the catalog
before normal use.

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
  If production already applied an unmerged predecessor, preserve its SQL,
  hash and timestamp and insert it chronologically into the committed journal.
  Preserve merged successor SQL and timestamps too; regenerate the snapshot
  chain and contiguous journal indexes. Filename numbers need not match journal
  indexes after this repair. Keep unapplied contractions after the repaired
  prefix and out of an expansion-only repair; never reset production bookkeeping.
- Enum-like columns are text with a CHECK generated from a `packages/schemas`
  value array. Adding a value widens that CHECK, so `db:generate` emits a
  migration that must reach prod before the code that writes the value deploys.
- Adding a column needs a full dev-server restart: the Drizzle client is cached
  on `globalThis` across HMR, and a stale schema silently omits the column from
  `SELECT`s (reads as `null`).

## Data, layers, and deletion

Server code is domain-first ([ADR 0019](../adr/0019-domain-first-server-layout.md)):
`server/domains/<entity>/` (the kebab manifest name) or a cross-entity feature
folder beside it, `server/generic/<capability>/` for entity-agnostic
capabilities, and platform folders (`db/`, `http/`, `operation-runtime/`,
`workflows/`, …). Inside a domain the role is the path segment: `repo`,
`service`, `operations` — a `<role>.ts` file, or a `<role>/` folder once it
holds more than one module; tests sit beside their file. `cubby/domain-layers`
keeps imports flowing operations → service → repo → db, keeps `ai/` out of
repos, and keeps platform and generic code off a domain's service and
operations; existing violations are a shrink-only per-file baseline
(`tools/oxlint/cubby/domain-layers-baseline.json`). No `index.ts` barrels in
`domains/`, `generic/`, or client `features/` (`cubby/no-domain-barrel`).

`Database` is a request-scoped handle: routers pass it onward, services
orchestrate, and repos alone call `getDb`; transactions use `withTransaction`.
Its callback receives a Drizzle transaction directly. Use
`withTransactionDatabase` when a called domain module needs a transaction-bound
`Database`; `getDb` accepts that facade, not a raw Drizzle transaction.
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
Every new entity-targeting FK needs a stable `ENTITY_EDGES` declaration and
graph coverage or an explicit non-graph metadata classification. A non-entity
source table also needs `ENTITY_EDGE_OWNERS`, even when excluded from the graph.
Run both `entity-manifest-fk.unit.test.ts` and `entity-edge-owners.unit.test.ts`
after adding an FK, including ledger child tables; the owner guard loads the
actual graph projection and catches module-initialization failures. Populate new
child-table FKs in `delete-policy.integration.test.ts` staging fixtures so the
matrix exercises their real block, detach or cascade behavior.
Deletes and merges have no live preview — attempt the mutation and read its
structured refusal. Attach/detach previews stay advisory, and mutations
re-check transactionally regardless.

`Product.tags` (and any future `control.suggest.mode: "prune"` text-array) is
compatibility/ecosystem tokens only — never the manufacturer, a classification
word, or a path node, which belong in `manufacturer`/`categoryId`; a tag that
merely restates one of those is flagged for removal, not silently dropped. The
maker named as a third-party fitting's target can identify compatibility rather
than the fitting's own manufacturer. A single occurrence alone does not make a
compatibility token redundant. The
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

For a standalone code, `shortcode("RUN-4K7M")` validates it and infers its
branded type from the generated prefix registry (case-insensitive, including
legacy label prefixes). Runtime strings and whitespace-wrapped literals return
the shortcode union; use `parseShortcode` when its entity discriminator is
needed for narrowing. Use `shortcodeSchema(entity)` or `parseShortcodeFor`
when an ingress field must require a particular entity rather than accept any
valid prefix. Entity-specific schemas remain the declaration shape.
Prefix inference applies the union fallback to each input member before
combining results, so whitespace-wrapped members cannot borrow another
member's entity brand.

Drizzle raw-`sql` traps: a nullable timestamp `CASE` must cast its bound
instant to `timestamp`; an unconstrained parameter beside `NULL` otherwise
infers `text` and fails the update. An interpolated column renders **unqualified** on a
single-table select, including inside a nested projection. A correlated
subquery can silently compare its own columns instead of the outer row;
use explicit table aliases and literal qualified names for that correlation.
A repeated SELECT/GROUP BY expression must use identical constants: separate
bind parameters make PostgreSQL treat its copies as different expressions.
Inline compile-time schema enum values with `sql.raw`, keeping user input bound;
Drizzle's relational extras rebuild SQL and drop `.inlineParams()` flags.
A JS array interpolates as
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
(`server/db/helpers`). Deliberate UTC days — retained-settlement
payment keys that must match `chargedAt::date`, operational bucket keys — carry
a disable comment with the reason.

Inside the entity kernel's write transaction every DB touch must go through the
transaction-bound context: a service still bound to the request pool that
updates the row the transaction holds deadlocks silently, and only E2E on
workerd exposes it. A data exception's fingerprint is declared per check in
that check's registry binding (`CheckBinding.fingerprint(t)` in
`apps/web/src/server/generic/data-quality/repo/checks/<entity>.ts`) — the inputs it
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

Before adding a module, verify that its path does not already exist. A filename
collision must preserve the existing module and its callers; use a distinct path
for the new responsibility.

Generated output carries a generated header and is regenerated automatically
([quality](validation-quality.md)). Never hand-edit one — edit its generator or
input. A missing expected output means run its owning generator and investigate
the reported failure.

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
