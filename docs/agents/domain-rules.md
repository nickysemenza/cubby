# Domain and server rules

## Breaking changes

One trusted household uses Cubby, and we ship and refresh every client (web,
iOS/macOS, HTTP, MCP connections), so change contracts in place:

- Change an API, RPC, MCP tool, manifest, or stored shape directly, update
  every client in the same change, and delete the old shape. Old clients can
  break when a wire contract changes. When a change requires rejecting writes
  from older Apple builds, bump APPLE_CLIENT_COMPATIBILITY_VERSION; the shared
  operation route returns 426 for those writes; reads are not gated and an
  old client may fail to decode a changed shape.
  This gate covers future write incompatibilities; it does not preserve old
  wire behavior. Choose a version newer than current main; concurrent breaking
  PRs must not reuse a published version.
- MCP clients cache `tools/list` across deploys and validate results against
  it, so published output schemas are open objects: an added output field is
  safe for an open session, while removing, renaming or retyping one breaks
  it until the client reconnects. A client that cached an older closed schema
  must reconnect once to load the open schema. Input schemas stay closed.
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
committed migrations in `apps/web/drizzle/`: `pnpm db:generate` runs native
Drizzle generation for `schema.ts`, and `pnpm --filter @cubby/web
db:migrate --target=production` applies them with
`PRODUCTION_DIRECT_DATABASE_URL`.
Run `db:generate` with a TTY and unredirected stdout when Drizzle asks
create/rename questions; inspect the journal and generated SQL before treating
generation as complete.

For functions, triggers, views, or other derived DDL, update the desired-state
definition in `src/server/db/derived-ddl.ts` and its helpers, then handwrite only
the changed objects in the new, unmerged migration. If there is no schema
migration to extend, use `pnpm db:generate --custom --name=description`.
Do not copy the entire desired-state script into another migration or add a
generator wrapper or hash lock. The catalog check detects missing SQL changes.

Migration SQL and journal entries are immutable once merged, except for an
explicitly authorized baseline consolidation following the
[production migration runbook](../runbooks/production-migrations.md#baseline-consolidation).
Keep only the latest `drizzle/meta/*_snapshot.json`: it is generation state,
not applied history. After `db:generate`, delete superseded snapshots;
`db:check` rejects them. Snapshots remain committed so generation can recognize
renames and drops, but `.gitattributes` suppresses their full-schema line diffs.
The runner refuses bookkeeping that is not a prefix of the journal, apart from
the exact retired-ledger adoption described in the runbook.
A stored-shape transform accompanying schema work is a custom migration
(`drizzle-kit generate --custom`). For an explicitly authorized one-off data-only
correction, use a transactional update and verify preservation and read-back;
keep the script outside the repository and add no journal entry or schema guard
solely to route it through migrations. CI `db:check` fails when `schema.ts` has no migration or the
migrations build a catalog different from `schema.ts` plus the desired-state
derived DDL, including function, trigger and view definitions; `tooling/db-catalog.ts`
reads the same catalog from production. Before a
`DROP COLUMN`, remove the `schema.ts` declaration and DEPLOY first — the
relational query builder selects every declared column, so the declaration is
the read. The reverse also bites: an undeclared legacy table or column keeps
its foreign keys, so a new write path that hard-deletes the referenced row
fails until the drop. Either drop the legacy FKs in the expand step or run the
drop right after the deploy (the ADR 0006 image joins blocked image deletes
this way).

`deploy.yaml` applies pending committed migrations before deploying each `main`
push. Ordinary migration PRs must be compatible with the currently deployed
code; add a populated-predecessor preservation regression for CI before merge,
and the owner reads back production after release. A contract migration (`DROP COLUMN`, or a
constraint the deployed code would violate) requires an explicit staged boundary
before merge: follow the production migration runbook to deploy matching code
before applying the contraction. Keep staged cutover PRs off auto-merge.

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
keeps imports flowing operations → service → repo → db (`http/`, `mcp/`, and
`workflows/` import like operations), keeps `ai/` out of repos, keeps `db/`
out of services, and keeps platform and generic code off a domain's service
and operations. It has no baseline, so a new violation is fixed by moving
code to the right role, never by an exemption. No `index.ts` barrels in
`domains/`, `generic/`, or client `features/` (`cubby/no-domain-barrel`).

`Database` is a request-scoped handle: routers pass it onward, services
orchestrate, and repos alone call `getDb`; transactions use `withTransaction`.
Its callback receives a Drizzle transaction directly. Use
`withTransactionDatabase` when a called domain module needs a transaction-bound
`Database`; `getDb` accepts that facade, not a raw Drizzle transaction.
DB-only snapshot writers may opt into `withSnapshotWrite` or
`withSnapshotWriteDatabase`. Each attempt revalidates the original submitted
evidence and creates its own transaction-local state and deferred publication
buffers. Enroll buffer flushing through that transaction's `runAfterCommit`;
an outer buffer survives rollback and leaks abandoned-attempt tasks. Only an
aborted owned boundary retries, with at most three attempts and 200/400 ms
pauses so retries do not immediately collide with the same background page.
Caller-owned transactions and committed effect failures never replay. Provider/storage calls and unrestricted callbacks are
not replay-safe merely because they occur inside a transaction.
Background Queue invocations, Durable Object work and Workflow steps use
`withInvocationDb`: the bounded pools lease independent transaction clients and
close when the awaited scope finishes. Never share one standalone client across
concurrent transaction branches; serial SQL statements do not isolate commits.
Late continuations must open their own awaited scope. Cleanup errors are logged
with their original diagnostics and do not turn committed work into a retry.
The repository helper is the sanctioned client-resolution boundary. The handle
itself carries only nominal identity. Runtime registration must survive module
reloads, and transaction detection uses native `rollback` presence rather than
constructor identity: `createDatabase` registers a lazy runtime
callback, and runtime resolution occurs on each use. Query-only repos
use `repositoryQueries` and the repository transaction ports, which project
native Drizzle builders without exposing
the global relational schema; full relational repos retain `getDb`. Both return
the actual selected client/transaction, preserving transaction identity. When adding
query-only repository or schema modules, register their strict-program ownership
and check imports across that boundary; see [compiler boundaries](../development.md#typechecking).
A service earns existence for
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
eligible row, then filters by scope, multiplies cost by the population. In the
Assessment eligibility rewrite, moving rule checks behind a materialized
identity barrier cut one scope's rule lookups from about 13,400 to 11. Match a
primary reference column directly instead of expanding a JSON array. When many
list reads need the same derived value, compute it once in a background family
and read the stored result (as data quality does) rather than recomputing it in
every list statement. Load related facts once per ID page, never per row. Write
queries with the Drizzle builder and typed helpers; Kysely matched Drizzle's
plans without fixing the raw JSON predicates and needed a separate adapter.
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

## Error diagnostics

The trusted household sees raw diagnostics in toasts, Technical details and
HTTP/MCP error bodies: SQL text and parameters, Postgres SQLSTATE codes and
upstream response bodies. Preserve these rather than replacing them with generic
messages. Only credential-shaped values are redacted (`scrubErrorMessage`).
This governs error surfaces; repository and outward-facing
content still uses synthetic evidence under the root agent rules.

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
