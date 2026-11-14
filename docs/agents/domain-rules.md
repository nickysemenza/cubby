# Domain and server rules

## Breaking changes

One trusted household uses Cubby, and we ship and refresh every client (web,
iOS/macOS, HTTP, MCP connections), so change contracts in place:

- Change an API, RPC, MCP tool, manifest, or stored shape directly, update
  every client in the same change, and delete the old shape. Old clients can
  break when a wire contract changes. Raise APPLE_CLIENT_MINIMUM_VERSION only
  when an older Apple build's writes would be unsafe (they would store a wrong
  or rejected shape); the shared operation route returns 426 for those writes
  and the device stops its background work until updated. A changed read or
  output shape alone does not justify it: reads are not gated and an old client
  may fail to decode until it updates. Every raise cuts off every older build's
  writes, including background device work, so batch it with the change that
  needs it. Set the minimum and APPLE_MARKETING_VERSION to a version newer than
  current main; concurrent breaking PRs must not reuse a published version.
- MCP clients cache `tools/list` across deploys and validate results against
  it, so published output schemas are open objects: an added output field is
  safe for an open session, while removing, renaming or retyping one breaks
  it until the client reconnects. A client that cached an older closed schema
  must reconnect once to load the open schema. Input schemas stay closed.
- Household data is real: carry it through a migration that transforms it.
- An absorbed (merged-away) code resolves to its survivor on reads; writes
  addressed to it are refused and name the survivor. Web, native and MCP
  resolve through `resolveForRead`/`resolveForWrite` in the shared get path
  ([ADR 0029](../adr/0029-evidence-facts-and-reconcilers.md) section 9).
- A queued Ask stores its frozen envelope (`Ask.input`), keyed by
  `inputHash`. A `promptVersion` change re-keys a queued Ask when it is
  claimed and carries its requesters (`AskScope`); do not rewrite stored
  envelopes in a migration.

## Production changes

The [production migration runbook](../runbooks/production-migrations.md) owns
the cutover sequence, locks and retained queue work. Merging to `main` applies
pending committed migrations, then deploys; a migration ships with the code and
clients that need it in one PR.

Serialize production schema changes: one owner verifies the migration and no
application overlaps another session. Inspect constraints and data, and
transform existing rows in the same migration that changes their shape. Schema
reaches every database only through committed migrations in
`apps/web/drizzle/`: `pnpm db:generate` runs native Drizzle generation for
`schema.ts`, and `pnpm --filter @cubby/web db:migrate --target=production`
applies them with `PRODUCTION_DIRECT_DATABASE_URL`. Run `db:generate` with a TTY
and unredirected stdout when Drizzle asks create/rename questions; inspect the
snapshot graph and generated SQL before treating generation as complete.

For functions, triggers, views, or other derived DDL, update the desired-state
definition in `src/server/db/derived-ddl.ts` and its helpers, then handwrite only
the changed objects in the new, unmerged migration. If there is no schema
migration to extend, use `pnpm db:generate --custom --name=description`.
Do not copy the entire desired-state script into another migration or add a
generator wrapper or hash lock. The catalog check detects missing SQL changes.

Migration SQL and folder names are immutable once merged, except for an
explicitly authorized baseline consolidation following the
[production migration runbook](../runbooks/production-migrations.md#baseline-consolidation).
Drizzle v1 stores each migration in `<UTC timestamp>_<name>/migration.sql`.
Keep its `snapshot.json` and all predecessor snapshots: v1 reconstructs the
generation state from this graph and checks cross-branch conflicts. `db:check`
reconstructs that state and compares it with the full generated schema and a
fresh database; CI fails when `schema.ts` has no migration or the migrations
build a catalog different from `schema.ts` plus the desired-state derived DDL.
`tooling/db-catalog.ts` reads the same catalog from production. The runner
validates applied names and SQL hashes, rejects unknown or duplicate receipts,
and applies every missing migration within the requested boundary.

A stored-shape transform accompanying schema work is a custom migration
(`drizzle-kit generate --custom`). For an explicitly authorized one-off data-only
correction, use a transactional update and verify preservation and read-back;
keep the script outside the repository and add no migration or schema guard
solely to route it through migrations.

A new singleton or settings row inserted by a migration gets a freshly
generated random UUID; a hand-picked literal id can collide with a live or
retired production row. A reshape migration carries known legacy or orphaned
shapes forward (deactivate or archive them) instead of aborting, so Deploy is
not the first probe of production data.

Dropping a column removes its `schema.ts` declaration in the same change: the
relational query builder selects every declared column, so the declaration is
the read. An undeclared legacy table or column keeps its foreign keys, so a new
write path that hard-deletes the referenced row fails until the drop; drop those
foreign keys in the same migration.

Traps:

- Local startup, fixtures, integrations, runtime inspection, and simulator
  discovery follow [local development](../local-development.md). `pnpm dev`
  supplies a guarded checkout database and ignores production env files.
  Explicit production MCP/database access still reaches the shared household;
  concurrent sessions make point-in-time production sweeps unreliable.
  `db:migrate` uses its explicit target, never the application's `DATABASE_URL`.
- Migrations from parallel branches can interleave. Run `drizzle-kit check`
  after merging `main`; v1 matches receipts by full folder name and applies
  missing migrations even when an already-applied migration sorts later.
  Preserve committed SQL and folder names. Never use a conflict repair that
  deletes an applied migration or requires resetting a durable database.
- Enum-like columns are text with a CHECK generated from a `packages/schemas`
  value array. Adding a value widens that CHECK, so `db:generate` emits a
  migration that must reach prod before the code that writes the value deploys.
- Adding a column needs a full dev-server restart: the Drizzle client is cached
  on `globalThis` across HMR, and a stale schema silently omits the column from
  `SELECT`s (reads as `null`).

## Data, layers, and deletion

Use relational rows and foreign keys for relationships to canonical entities,
including dated memberships and funding relationships. Reserve JSONB for owned
value objects whose elements do not need independent references or lifecycle
behavior. Before choosing JSONB for entity references, establish why ordinary
relations cannot fit and account for validation, deletion, merging, and querying;
a small list or an existing JSONB field alone does not justify the choice.

Server code is domain-first ([ADR 0019](../adr/0019-domain-first-server-layout.md)):
`server/domains/<entity>/` (the kebab manifest name) or a cross-entity feature
folder beside it, `server/generic/<capability>/` for entity-agnostic
capabilities, and platform folders (`db/`, `http/`, `operation-runtime/`,
`workflows/`, …). Inside a domain the role is the path segment: `repo`,
`service`, `operations` — a `<role>.ts` file, or a `<role>/` folder once it
holds more than one module; tests sit beside their file. `cubby/domain-layers`
keeps imports flowing operations → service → repo → db (`http/`, `mcp/`,
`workflows/` and the kernel's module list `kernel/modules.ts` import like
operations), keeps `ai/` out of repos, keeps `db/`
out of services, and keeps platform and generic code off a domain's service
and operations. It has no baseline, so a new violation is fixed by moving
code to the right role, never by an exemption. No `index.ts` barrels in
`domains/`, `generic/`, or client `features/` (`cubby/no-domain-barrel`).

Entity reads go through the repository's read declaration
([ADR 0024](../adr/0024-repository-read-declaration.md)): a page is
`scaffold.read`, a record is `scaffold.get`/`getByIds`, and a writer returns
the record it wrote through `getByIds`. Do not add a per-entity mapper
(`dbXToAPI`), a by-id reader twin, or an entity-keyed map in
`server/generic/**`; put the per-entity fact in the declaration or the
repository's read declaration. A read-schema key that nothing loads fails when
the read plan is built.

`Database` is a request-scoped handle: routers pass it onward, services
orchestrate, and repos alone call `getDb`. Transactions use `withTransaction`,
whose callback receives a Drizzle transaction; use `withTransactionDatabase`
when a called domain module needs a transaction-bound `Database` (`getDb`
accepts that facade, not a raw Drizzle transaction). Query-only repos use
`repositoryQueries` and the repository transaction ports; register new
query-only modules with the strict-program boundary
([compiler boundaries](../development.md#typechecking)).
DB-only snapshot writers may opt into `withSnapshotWrite` or
`withSnapshotWriteDatabase`: each attempt revalidates the submitted evidence,
and buffer flushing enrolls through that transaction's `runAfterCommit` (an
outer buffer survives rollback and leaks abandoned-attempt tasks). Only an
aborted owned boundary retries; caller-owned transactions, committed effects,
provider/storage calls and unrestricted callbacks never replay.
Queue invocations, Durable Object work and Workflow steps use
`withInvocationDb`, which leases independent transaction clients and closes
them when the awaited scope finishes. Never share one standalone client across
concurrent transaction branches; serial SQL statements do not isolate commits.
Late continuations open their own awaited scope.

A service earns existence for cross-cutting enrichment, compute or rollups, not
pass-throughs. Cubby domain compute belongs in recipebridge/WASM; TypeScript
assembles inputs and reshapes outputs instead of recreating it.

Expenses are legitimately negative — refunds, sales, and large family
contributions — so any rollup that filters `total > 0` silently drops
net-negative trade rows and disagrees with its grand total. Treat negatives as
credits and reconcile visible breakdowns against totals before shipping a chart.

Major entities soft-delete. Use `notDeleted`, including `exists`/`notExists`
subqueries unless an `includes-deleted: <reason>` comment makes the exception
intentional. Removal paths clean `SearchDocument` and `EntityEmbedding` in the
same transaction and propagate dependent staleness. Declare each relationship with `defineEdge`, including storage, inverse, ownership, liveness
and separate delete/merge policies with named executable hooks. The generator emits
`ENTITY_EDGES` and `ENTITY_EDGE_OWNERS` from those declarations. Every entity-targeting FK
needs graph coverage or an explicit non-graph metadata classification; non-entity source tables
declare ownership even when excluded from the graph.
Run both `entity-manifest-fk.unit.test.ts` and `entity-edge-owners.unit.test.ts`
after adding an FK, including ledger child tables; the owner guard loads the
actual graph projection and catches module-initialization failures. Populate new
child-table FKs in `delete-policy.integration.test.ts` staging fixtures so the
matrix exercises their real block, detach or cascade behavior.
Deletes and merges have no live preview — attempt the mutation and read its
structured refusal. Attach/detach previews stay advisory, and mutations
re-check transactionally regardless.

Only the kernel's apply step writes a column a registered reconciler owns
(ADR 0029 section 2): every traced pool refuses any other statement that
writes one (`db/owned-columns.ts`), so a writer appends evidence or records a
decision instead. The refusal covers the reconcilers listed in
`kernel/modules.ts` and switches on per domain as each module is added. The
shared entity writers emit kernel keys for the columns they write; a bespoke
writer of a column a reconciler reads calls `emitWrites` in its transaction.

Take as few locks as possible: coordinate through a constraint or a
compare-and-set update. When a lock is needed, make it narrow, shared
(`FOR SHARE`/`FOR KEY SHARE`) and short, on the owning row; a lock table is a
smell. Cubby never hard-deletes entity rows, so a liveness guard needs no
exclusive lock. Keep serializable transactions small: past about 32 pages of
one table, PostgreSQL escalates their predicate locks to the whole relation and
concurrent writers fail with `40001`.

`Product.tags` (and any future `control.suggest.mode: "prune"` text-array) is
compatibility/ecosystem tokens only — never the Brand name, a classification
word, or a path node, which belong in `brandId`/`categoryId`; a tag that
merely restates one of those is flagged for removal, not silently dropped. The
maker named as a third-party fitting's target can identify compatibility rather
than the fitting's own Brand. A single occurrence alone does not make a
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
schema-backed factories from `@cubby/schemas/testing`. Entity URLs and MCP
addresses use shortcodes. An explicitly declared child read may expose an
opaque UUID handle for stable row identity; that handle grants no entity route,
general lookup, or mutation selector. Keep the child workflow's existing
addressing and authority checks. Resolve entity codes through `shortcode-resolver`, mint through
`insertWithShortcode`, never reuse them, and keep `shortcodeSchema` a `ZodString`.

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

Relational queries use Drizzle RQB v2 and one assembled `relationalSchema`.
Its root and nested rows have generated aliases. Build filters through the
`RAW` callback and bind shared SQL expressions with `relationalSql(table, sql)`;
use the same binding for prebuilt ordering and extras. `outer(column)` retains
column identity for this binding while preserving qualification in plain selects.
Do not interpolate an old RQB alias into a relational expression. Extras that
accept a table-name argument must derive it from the callback's table.

Choose the query form in this order:

1. RQB `with`/`columns` for related reads a declared relation covers. Every
   declared reference column gets a generated to-one relation named after the
   column without `Id` (`spendingCategoryId` → `spendingCategory`) unless a
   declared relation covers it or the reverse to-many would become ambiguous.
   Declare to-many and aliased relations on the entity rather than joining by hand. Generated
   to-many relations into soft-deletable tables already filter
   `deletedAt IS NULL`; a nested `RAW` repeats only other conditions (role,
   kind). To-one relations still return deleted parents, so readers project
   `deletedAt` where presentation depends on it.
2. Typed core builders (`select`/`join`/`exists`/`inArray`, `count()`,
   `asc`/`desc`) where no relation fits. Query-only repositories stay on
   `RepositoryQueryClient` and use this form; do not widen it to RQB.
3. Raw `sql` only for named cases: generic list, search and work-queue
   compilers; effective and inherited field resolution; window functions,
   recursive CTEs, `ON CONFLICT`, row and advisory locks, full-text search,
   ranking and deduplication; single-parameter arrays (`uuidArrayParam`);
   jsonb construction; and DDL or generated code.

Keep RQB filters in the `RAW` + `relationalSql` form, not object filters: rc.5
throws on `undefined` object-filter fields and drops bare `Date` values. Convert
whole statements. Never put builder columns into the select fields of a
hand-written statement; Drizzle renders them unqualified there.

Drizzle raw-`sql` traps: a nullable timestamp `CASE` must cast its bound
instant to `timestamp`; an unconstrained parameter beside `NULL` otherwise
infers `text` and fails the update. Timestamp aggregates and scalar subqueries
need `.mapWith(sourceTimestampColumn)` to decode driver strings as Dates;
`sql<Date>` supplies only a compile-time type. Keep null results null and test
the operation output schema against nonempty activity.
Bound `jsonb_build_object` keys need `::text`
when no typed expression constrains their parameters. An interpolated column renders **unqualified** on a
single-table select, including inside a nested projection. A correlated
subquery can silently compare its own columns instead of the outer row.
Build correlated counts, sums, extrema, existence and to-one lookups with
`related()` from `server/db/helpers/related.ts`: it aliases every related step,
renders every reference qualified, filters each step to live rows unless the
step passes `includeDeleted`, and takes the outer row through `outer(column)`
(`"Run"."id"`). Interpolating `${run.id}` directly can become the inner
table's unqualified `"id"`. Do not add raw-string correlated fragments or
helpers that take a quoted table name. `cubby/no-raw-deleted-at-predicate`
holds each server file's hand-written `"deletedAt" IS NULL` count to a
shrink-only baseline (`tools/oxlint/cubby/no-raw-deleted-at-predicate-baseline.json`);
lower it when a change removes one.
Verify a correlated count with nonzero rows and another owner's rows, rather
than an empty population that hides a broken correlation.
Keep a `PgTable` object when passing a plain table to `.from()`: raw SQL
interpolation of an aliased table emits only its alias, losing the underlying
table declaration. Derived SQL sources must not convert plain-table fallbacks
into SQL fragments.
Query shape: narrow to the requested identities before per-row work. A
MATERIALIZED CTE that builds JSON or runs correlated policy lookups for every
eligible row, then filters by scope, multiplies cost by the population; put an
identity barrier first. Match a primary reference column directly instead of
expanding a JSON array. When many
list reads need the same derived value, compute it once in a background family
and read the stored result (as data quality does) rather than recomputing it in
every list statement. Load related facts once per ID page, never per row. Write
queries with the Drizzle builder and typed helpers.
Benchmark with the related graphs seeded: empty Email, Purchase or settlement
tables hide the cost of subqueries that walk them.
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
Calendar-day wire contracts use the shared `plainDate` pattern, with a refinement
when strict calendar validity is needed. Do not advertise `z.iso.date()`'s
`format: date`: MCP clients reject that format. Preserve runtime validation
without changing the advertised calendar-day shape.
Timestamp columns are `timestamp without time zone` holding UTC wall time.
Bind raw SQL instants with the column's encoder (`sql.param(instant, column)`)
or UTC ISO text cast to `timestamp`. A raw `Date` bind uses pg's host-local
offset spelling, whose offset a timestamp-without-time-zone comparison ignores.
Day extraction with SQL `::date` and `date_trunc('day', …)` produces UTC days: use
`householdDaySql` and bound day filters with `householdDayRangeConditions`
(`server/db/helpers`). Deliberate UTC days — retained-settlement
payment keys that must match `chargedAt::date`, operational bucket keys — carry
a disable comment with the reason.

Inside the entity kernel's write transaction every DB touch must go through the
transaction-bound context: a service still bound to the request pool that
updates the row the transaction holds deadlocks silently, and only E2E on
workerd exposes it. Data-quality checks are TypeScript functions over one batch
loader per ID page; list SQL reads only their published outcomes, so hydration
and filters cannot drift apart. Waivers hold across input changes until cleared;
see [Data quality](../entities.md#data-quality).

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

Required Worker bindings and Durable Objects are always present: use them
directly and delete missing-binding fallbacks. Paid fallbacks, such as
embeddings through Unified Billing, just work; add no gate in front of them.

## Error diagnostics

The trusted household sees diagnostic cause messages and SQLSTATE codes. Scrub
credential-shaped values with `scrubErrorMessage`. Optional AI enrichment
failures return status `unavailable` with a reason; a scrubbed upstream body
belongs in `detail`, never the headline. MCP error bodies retain cause messages
and SQLSTATE but never stacks, schemas or ID lists. Repository and outward-facing
content uses synthetic evidence under the root agent rules.

## MCP and observability traps

[MCP server rules](mcp.md) own tool exposure, failures and deadlines.

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
