# Root rule reference

This preserves the detailed former root guidance. Load the relevant heading when its trigger applies; README is product/architecture context, not a mandatory full read.
The **[Tenets](../../README.md#tenets)** there are binding on design proposals: inventory never auto-decrements (no cook-and-consume), `fdc_id` is product-only (nutrition goes `ingredient → product → fdc_id`), rare interactive work stays off the background queue, all money lives on `Expense` (`purchase.statedTotal` is never summed into spend), and one household of trusted users (no multi-user coordination, no restore/undo, no reservations/locking). Don't propose a feature that contradicts one — say it's out of scope and why.

## Agent workflow

- Use subagents proactively when a task has two or more independent, bounded workstreams and delegation would materially improve speed or quality.
- Prefer subagents for codebase exploration, test execution, log analysis, documentation research, and independent review. Keep architecture decisions, implementation coordination, and final verification with the main agent.
- Do not delegate small or inherently sequential tasks. Do not let multiple agents edit overlapping files concurrently; use isolated worktrees and disjoint ownership for parallel write-heavy work.
- For change, build, and fix requests, make the requested in-scope changes and validate them proportionally. Run targeted checks first; run `pnpm run check` plus relevant tests for broad or cross-layer changes.
- **Run the narrowest tier that can fail.** `pnpm test` is Docker-free and runs
  the repo's fast unit/UI/contract and auxiliary-package tests. Prefer, from
  the repo root: `pnpm test:unit`, `pnpm test:ui`, or `pnpm test:changed`
  (Vitest `--changed`; pass a ref for a branch diff). A
  single portable file is faster still with `pnpm test:file src/…`. `unit` and
  `ui` are separate Vitest projects (`*.unit.test.ts` under node vs.
  `*.unit.test.tsx` under jsdom, per `apps/web/vitest.config.ts`) and neither
  runs the other's files, so a change touching any `.tsx` under `apps/web/src`
  needs `test:ui` too, even when `test:unit` looks like the narrowest tier.
  Use `pnpm test:file:postgres src/…` or `pnpm test:postgres` when the behavior
  requires real SQL, sessions, locks, pools, or node-postgres fidelity.
  `pnpm test:e2e` is likewise PostgreSQL-backed. On macOS those commands own
  disposable Apple PostgreSQL and IntegreSQL containers. Linux and CI use
  external services; Docker Compose remains an external-service fallback.
  Reserve `pnpm test:all`/`test:local` for pre-PR or genuinely cross-layer work.
  Use the [test-placement table](#test-placement) to decide which tier a change
  can actually break.
- Typecheck is cheap now — TypeScript 7's native `tsc` does the whole repo in
  ~2.2s warm, ~7s cold — so run `pnpm typecheck` freely. It is not the thing
  worth skipping.
- Open pull requests ready for review by default. Use a draft PR only when the user explicitly requests one or the published work is intentionally incomplete.

## Never put real data in outward-facing text

Commit messages, PR titles and descriptions, review comments, and issue text are
**public and permanent** — this repo is public, and GitHub keeps a PR body's
previous revisions in its edit history where an edit cannot remove them. Only
GitHub Support can.

So none of them may contain real rows, values, or identifiers: no third-party
names, card last-four digits, account descriptors, transaction descriptions,
amounts tied to a person, addresses, or order numbers. This applies to output
pasted from a production query, which is the usual way it happens.

Describe the shape instead, and use a placeholder — `<payee>`, `····NNNN`,
`<merchant>`. A worked example almost never needs the real value to make its
point: "a description where `U+1FA9D` was transcribed as `U+1F99D` — same byte
length, different hash" carries the whole lesson, where the actual Venmo payee's
name carried it no better and published a private individual's name (#693).

Screenshots, `EXPLAIN` output, and test fixtures are the same rule. Internal
shortcodes (`PUR-4K7M`, `FTX-9H64`) are fine — they name a row without
disclosing its contents.

## Comments

Comments explain **why a constraint exists**, not what the next line already says.
Keep invariant, regression-cause, security/runtime, database-semantics, algorithm,
public-contract, and active-TODO context. Delete narration of obvious control flow,
stale implementation history, redundant section banners, signature-shaped JSDoc,
and Arrange/Act/Assert prose that adds no behavioral fact.

## Test placement

Four tiers, distinguished by **what the test needs in order to fail correctly** —
never by which layer of the codebase the code happens to live in. A repo function
belongs in a unit test if its logic is decidable without Postgres; a pure helper
belongs in an integration test if the bug being pinned is one only real SQL
exhibits.

| Tier | Pattern | Runner / environment | Belongs here when |
| --- | --- | --- | --- |
| unit | `*.unit.test.ts` | vitest `unit`, node, no I/O | The answer is decidable from inputs alone — schema parsing/branding, SQL-fragment shape, pure computation, filter/URL serialization, mappers. |
| ui | `*.unit.test.tsx` | vitest `ui`, jsdom + RTL | Component or hook behavior: rendering, interaction, memo/dependency stability. Mock the network; a UI test that needs a database is misplaced. |
| integration | `*.integration.test.ts` | vitest `integration`, real Postgres per file via IntegresQL | Only real SQL can be wrong in the way you're pinning — soft-delete and join visibility, transactions and cascades, shortcode resolution, where-clause application, count/aggregate agreement with the row set, workflows end-to-end over a real DB. |
| e2e | `tests/e2e/**/*.spec.ts` | Playwright against a built app | The bug lives in the seam a lower tier cannot see: routing and URL state, SSR/hydration, auth, service worker, real browser input. Slowest and flakiest — it earns its place only when nothing below can observe the failure. |

Rules that follow from that:

- **Write it at the lowest tier that can actually fail.** A test that would pass
  even with the bug present is not coverage at that tier; move it down until it
  fails, or up until it can.
- **Don't restate one tier's coverage in another.** The same assertion in two
  tiers doubles the maintenance and halves the signal about which layer broke.
  Prefer deleting the higher-tier copy.
- **Assert behavior, not implementation.** Pinning a call count, an internal
  helper name, or a SQL string is a change-detector; it fails on refactors and
  stays green on regressions.
- **Real-DB invariants stay integration, always.** The soft-delete, incoming-edge,
  and search-artifact invariants documented below are only meaningful against
  real SQL — see `server/repo/inventory/embedding-cascade-invariant.integration.test.ts`
  and `server/repo/shortcode.integration.test.ts`. Never satisfy one with a
  mock. Pinned WHERE-clause SQL shapes belong in
  `server/repo/build-where.unit.test.ts`, not scattered per-entity copies.
- **A guard that CI depends on is not deletable as duplication.** Entity
  freshness, soft-delete coverage, SQL-array safety, security, and the real-DB
  invariant suites back `pnpm check`; treat them as load-bearing even when a
  narrower test appears to cover the same ground.

## Production database migrations

Follow the shared-production-database guidance in [README's worktree section](../../README.md#worktrees-parallel-sessions) and its [D1 migration workflow](../../README.md#common-commands). Agents are authorized to run `pnpm --filter @cubby/web run db:push` when a schema change is necessary to complete the requested work and the migration has been verified as safe.

Before pushing:

- Serialize production schema changes: one agent owns the migration through verification, and no push may overlap another worktree or session's schema work. If exclusive ownership cannot be established, wait or ask.
- Inspect the proposed schema change and current data constraints.
- Run relevant checks and tests.
- Confirm the migration will not lose or reinterpret existing data.
- Reject ambiguous renames, destructive drops, unsafe type changes, and new required columns without a valid default or backfill.
- Ensure the schema remains compatible with both the currently deployed code and the code being prepared for deployment.
- Run `db:push` interactively. If Drizzle asks whether a change is a rename, create, or drop, cancel the push; never choose an option or accept a default until the intent is made unambiguous and its data impact is verified.
- Use expand → backfill/migrate → deploy → cleanup for incompatible changes.

**Before a `DROP COLUMN`, the question is whether the DEPLOYED build still
SELECTS it — and with drizzle's relational query builder, the declaration in
`schema.ts` IS the select.** `db.query.<table>.findMany` emits every declared
column, so a column no line of application code mentions is still selected on
every read. Leaving it declared "until the drop lands" therefore guarantees the
drop breaks production. The order is: remove the declaration → deploy → drop the
column. Verified 2026-08-22, when `Product.upc` was dropped while the deployed
build still declared it and every product read 500'd with
`select ... "product"."upc" ... from "Product"`.

**`drizzle-kit push` does not diff CHECK constraints, nor a partial index's
`WHERE` clause.** Editing a `check(...)` — or the `.where(...)` on a
`uniqueIndex(...)` — in `schema.ts` and pushing reports `Changes applied` and
changes nothing: the verbose plan contains only the usual trgm GIN-index drift,
never an `ALTER ... CONSTRAINT` or a `DROP INDEX`/`CREATE UNIQUE INDEX` pair. CI
cannot catch either, because the integration-test template is built from
`schema.ts` via `pushSchema`, so tests exercise a constraint production does not
have — and they PASS, which is worse than failing. Both must be applied by hand
(`DROP INDEX x; CREATE UNIQUE INDEX x ... WHERE ...;` inside one transaction for
an index), then re-read from `pg_constraint` / `pg_index` to confirm —
`Changes applied` is not evidence. (CHECK found on #580, adding `income` to the
settlement allowlist; the partial-index half on #718, scoping
`Ingredient_name_key` to `recipeId IS NULL`.)

If migration safety cannot be established from available evidence, stop and ask rather than guessing. After applying a production migration, verify the expected schema and data state and report what changed — read the constraint or column back, rather than trusting the push's summary line.

## Where logic lives (layering)

Three layers, one rule: never recompute in a higher layer what a lower one already owns.

- **`ingredient-parser` crates** (`ingredient`, `recipe-scraper`, `recipe-epub`, `recipe-types`) — pure ingredient / unit / recipe-shape logic, with **no** cubby-domain concepts (products, USDA `fdc_id`, prices, inventory, nutrient codes). Shared by `recipebridge` (WASM) **and** the native tools (food-cli / food-app). The deps-light contract.
- **`recipebridge`** (cubby's WASM crate) — cubby-domain compute (recipe costing, availability evaluation, food-mapping synthesis from products + USDA) plus the WASM boundary (`W*` tsify types, serde-wasm-bindgen marshalling). The single source of truth for those engines, consumed by the browser **and** the server (`*.service.ts`) via WASM. **Do not move these engines into `ingredient-parser`** — they're application domain with no upstream consumer; that's a layering violation, not consolidation. (Pure, generic unit helpers with no cubby coupling are the *only* thing that may migrate down — see the TODO in `recipebridge/src/reconcile.rs`.)
- **TS (`apps/web`)** — a thin boundary: assemble WASM inputs from the DB / UI, call WASM, reshape outputs into zod / React types. Do **not** reimplement costing, availability, unit conversion, parsing, or formatting in TS — call the WASM. (The old TS `calculateTotals` was deleted when the Rust costing engine landed; don't reintroduce that pattern.)

## Service vs. Direct Repo Boundary

A `*.service.ts` is warranted only when the orchestration is genuinely cross-cutting — USDA food enrichment (ingredient.service.ts, product.service.ts), WASM compute (recipe-costing.service.ts, availability.service.ts), multi-repo transactional side-effects (product-orchestration.service.ts), or a domain rollup a single repo can't own (location-valuation.service.ts, problems.service.ts). Otherwise router callbacks call repos directly. A service that would be an empty pass-through is still wrong — this rule keeps the boundary clear: services own domain enrichment/compute/rollups, repos own data access and transactions.

## Cloudflare Workers: clocks & WASM tracing

Two runtime traps that turned a WASM CPU leak into a "slow DB write" misdiagnosis — **distrust per-op timing logs on workerd**:

- **The workerd clock is frozen during synchronous CPU.** `performance.now()` / `Date.now()` advance only on I/O, never during pure-CPU execution — so a `performance.now()` delta around a synchronous block (a WASM call, a hot JS loop) reads ~0 and that CPU is silently charged to the **next awaited I/O**. A "slow query/write" in a log is often mis-attributed WASM/JS CPU. Localize CPU with the CF **CPU-time** metric (CPU ≈ wall ⇒ compute, not I/O-wait) or a sampling profile, not wall-clock deltas; to time a CPU block, flush the clock with a trivial awaited I/O (`SELECT 1`) right after it.
- **No active `tracing` subscriber at INFO on the WASM hot path.** recipebridge runs in a long-lived, reused isolate, so a global `wasm_tracing` subscriber at INFO + a `#[tracing::instrument]` on a per-call fn (it Debug-formats every arg, e.g. the whole `MeasureGraph`) accumulates unbounded and burns CPU that **grows per call** until it trips `cpu_ms`. Held at WARN on workerd in `recipebridge/src/lib.rs`; hot-path instruments must use `level = "trace", skip_all`.

## Required Helpers

### Renderers, saved views, and scopes

- A **renderer** changes presentation; a **saved view** selects records through
  ordinary manifest-backed, visible URL filter state.
- Full-page list membership, sorting, totals, and pagination belong on the
  server. Do not fetch all rows and decide membership in React.
- `useEntityList.scopeFilters` is only for a visible contextual scope imposed
  by a surrounding page (for example, expenses belonging to a displayed
  purchase). Never use it to implement a top-level preset or renderer.
- Empty or omitted filter fields mean unrestricted. A requested but unresolved
  id must fail or match nothing; it must never widen to an unfiltered query.
- Renderer-intrinsic omissions must be server-enforced and visibly disclosed
  with an omitted count or a link to the complete List.

Use these instead of inline patterns:

| Pattern to avoid                                           | Use instead                                     | Import from                                  |
| ---------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| Inline deletable config object                             | `useDeletableConfig({ ... })`                   | `~/app/_components/hooks/useDeletableConfig` |
| Inline update mutation with `useMemo` + `useMutation`      | `useUpdateMutation({ ... })`                    | `~/app/_components/hooks/useUpdateMutation`  |
| Inline `useMutation` + `toast` + `invalidateQueries`       | `useActionMutation({ ... })`                    | `~/app/_components/hooks/useActionMutation`  |
| `error instanceof Error ? error.message : "Unknown error"` | `getErrorMessage(error)`                        | `~/lib/error-utils`                          |
| Bare `navigator.clipboard.writeText(...)` (no iOS fallback) | `copyText(text)` / `copyShortcodes(codes)`      | `~/lib/clipboard`                            |
| Manual `.insert().values().returning()` + null check       | `insertAndReturn(db, table, values)`            | `~/server/repo/database-helpers`             |
| Manual `.update().set().where().returning()` + null check  | `updateAndReturn(db, table, values, where)`     | `~/server/repo/database-helpers`             |
| `getDb(db).transaction(async (tx) => {...})`               | `withTransaction(db, async (tx) => {...})`      | `~/server/repo/database-helpers`             |
| `ilike(column, \`%${term}%\`)`                             | `formatSearchTerm(column, term)`                | `~/server/repo/database-helpers`             |
| `isNull(table.deletedAt)`                                  | `notDeleted(table)`                             | `~/server/repo/database-helpers`             |
| Manual conditions array + notDeleted + formatSearchTerm    | `buildSearchConditions(table, filters, extras)` | `~/server/repo/database-helpers`             |
| `ComboboxItem.refine()` for required product               | `requiredProductField`                          | `~/app/_components/form-fields`              |
| `ComboboxItem.refine()` for required location              | `requiredLocationField`                         | `~/app/_components/form-fields`              |
| `as ProductId`, `as LocationId`, etc.                      | Parse with the entity schema at ingress, or fix the typed producer | `@cubby/schemas/identifiers` |
| Inline `["inventoryItem"]` query keys                      | `queryKeys.inventoryItem.list`                  | `~/lib/query-keys`                           |
| `Array.from(new Set(arr))` or `[...new Set(arr)]`          | `uniq(arr)` / `uniqBy(arr, fn)`                 | `es-toolkit`                                 |
| Hand-rolled `keyBy`/`groupBy`/`sumBy`/`partition`/`sum`    | the es-toolkit fn of the same name              | `es-toolkit`                                 |
| `switch`/`if`-ladder on a discriminated-union tag          | `match(x).with(...).exhaustive()`               | `ts-pattern`                                 |
| `value === "(unspecified)"`                                | `isUnspecifiedManufacturer(value)`              | `~/lib/manufacturer-utils`                   |
| Inline `{ a, b, source, sourceMetadata: { type: "manual" } }` edge | `manualUnitMapping(a, b, source?)`      | `@cubby/schemas/unitmapping`                 |
| `pMap(ids, (id) => getIngredientByID(...))` per-id loops    | `getIngredientsByIDs(db, usdaClient, ids)`      | `~/server/services/ingredient.service`       |
| Unparsed workflow output                                   | Parse the explicit output schema at the Start/MCP boundary | `~/server/workflows`                    |
| Hand-rolled merge that deletes losers, cascades embeddings, and writes audit separately | `finalizeMerge` (plus `resolveMergeTargets`/`repointEdge`) | `~/server/repo/merge` |
| `resolveLiveShortcode` + `if (!id) throw createAppError("X_NOT_FOUND", …)` | `resolveOrThrow(db, entity, code)` | `~/server/repo/shortcode-resolver` |
| `resolveLiveShortcodes` + collect-missing + throw | `resolveAllOrThrow(db, entity, codes)` | `~/server/repo/shortcode-resolver` |
| `resolveLiveShortcodes` + `.flatMap`/`.filter` that drops misses | `resolveAllPresent(db, entity, codes)` | `~/server/repo/shortcode-resolver` |

es-toolkit / ts-pattern caveats (don't over-apply): `keyBy` is for `Object.fromEntries(arr.map(...))` (Record→Record). Leave pure `Record<Enum, _>` value/theme lookups, `neverthrow` `.match()`, debounce/throttle (`@tanstack/react-pacer`), and date math (`date-fns`) as they are.

`useActionMutation` carve-outs (NOT drift — don't re-flag these as bypass sites): the helper's `success` is optional (omit it to skip the toast but keep invalidation), but its `invalidateKeys` are static per-hook and its `onError` is always a `toast.error`. So a raw `useMutation` is still correct when the site (a) shares one multi-mutation invalidator across several mutations (e.g. `useLocationSweep`'s caller-supplied `onSettled`, called from its scan/commit/reparent mutations alike; `SessionCaptureActions`' `invalidateCapture`), (b) needs **conditional** cache targeting the static list can't express (e.g. `use-board-mutations`'s `target`-gated `queryKey`, chosen per caller between `chartData` and `board`), (c) toasts from the caller via `mutateAsync` in try/catch (e.g. `location-validate-form`'s reparent), (d) surfaces errors inline (`setError`) instead of a toast (e.g. `bulk-reparent-locations-dialog`), or (e) does variables-driven `setState` in `onSuccess` (e.g. `InventorySessionWorkbench`'s `reconcile`).

`noUncheckedIndexedAccess` is ON repo-wide: `arr[i]`, `record[strKey]`, and `Map`-via-bracket all type as `T | undefined`, so guard or assert before use. Exceptions that stay `T`: `Record<FiniteEnum, V>[enumKey]` (finite-key Records aren't index signatures) and access right after a `.length`/membership check (assert with `!`). Don't silence a genuinely-reachable undefined with `!` — guard it; that's the bug the flag exists to catch.

## Database Handle and Repository Boundary

`Database` is a request-scoped handle with repository-only client resolution.
The class does not expose query methods, and the repository helper is the
sanctioned place to resolve its Drizzle client; this keeps the layered boundary
local even though TypeScript cannot make the handle structurally opaque:

- **Routers** accept `Database`, pass it to repos or services
- **Services** accept `Database`, pass it to repos (can't query directly)
- **Repos** call `getDb(db)` to unwrap and access the actual DrizzleClient
- **Transactions** use `withTransaction(db, async (tx) => {...})` — `tx` is unwrapped and can be used directly

## Soft Delete

All major entities (products, recipes, locations, ingredients, inventory, projects, tasks, vendors, purchases, expenses) use soft delete with a `deletedAt` timestamp column. Deleted items are retained in the database but hidden from normal queries.

- Always use `notDeleted(table)` helper to filter out deleted records in queries
- **This applies *inside* `exists()` / `notExists()` subqueries too — guard-enforced.** A soft-deleted row still satisfies `EXISTS`, so `notExists(select().from(inventoryEntry).where(eq(...)))` reads as "has no inventory" but silently matches products whose inventory was merely emptied. Since emptying a shelf soft-deletes rather than removes, that's the *common* path: this exact omission made `findOrphanedProducts` miss 18 of 20 real hits (#428), and the same bug sat unnoticed in two more subqueries in the same file. The `cubby/require-soft-delete-filter` oxlint rule (runs in `pnpm check`, so CI) fails any `exists`/`notExists` subquery over a soft-deletable table that has neither `notDeleted(…)` nor an explicit `deletedAt` predicate. For the rare subquery that genuinely must see deleted rows (cleanup/orphan sweeps), put an `includes-deleted: <reason>` comment above the call.
- Delete operations cascade to related entities (e.g., deleting a product soft-deletes its images and unit mappings)
- All deletions are wrapped in transactions and logged to audit trail
- Safety checks prevent deletion of entities with dependencies (e.g., products with inventory)
- **Restore functionality is intentionally not implemented** — treat soft deletes as permanent from a user perspective
- **Removal-path invariant**: every path that removes an entity (single delete, bulk delete/move, reconcile, hard-delete) must clean up both its `SearchDocument` and `EntityEmbedding` rows in the same transaction (`softDeleteEntitySearchArtifactsTx`), and cost-affecting deletions must propagate staleness to dependents (e.g. deleting a sub-recipe marks/recomputes parent recipes via `dispatchRecompute(parentIds)`). Guarded by the search-document diagnostics plus `findOrphanedEntityEmbeddings` (repo/entity-embedding.ts, exercised in `embedding-cascade-invariant.integration.test.ts`) and the `findParentRecipesWithDeletedSubRecipes` Problems detector — a new removal path that skips this is a bug, not a carve-out. For **merges** this is structural, not just guarded: `finalizeMerge` (`apps/web/src/server/repo/merge/core.ts`) derives the search-artifact cascade from the entity itself (via `searchableEntities` membership) rather than taking it as a caller-supplied argument, so a merge that removes its losers without cascading either search layer is unwritable, not merely test-caught. Every non-merge removal path (single delete, bulk delete/move, reconcile, hard-delete) stays the structural, guard-backstopped obligation described above.
- **Incoming-edge invariant**: `apps/web/src/server/db/entity-incoming-edges.ts` is the schema-checked fact table of every FK that points at an entity. Every delete, merge, orphan detector, or other operation whose correctness depends on those references must declare an exhaustive `IncomingEdgePolicy<Entity, Disposition>` and keep a real-DB backstop for each disposition. Keep behavior operation-specific: the same `Expense.purchaseId` edge is cleared on purchase delete and re-pointed on purchase merge, so there is deliberately no global cascade/disposition on `INCOMING_EDGES`.
  - **Semantics vs. disposition.** `entity-edge-semantics.ts` gives every edge a *stable* role, label, and liveness rule; a role never encodes delete behavior (that's the operation's `OperationDisposition`, `{code, effect, description}`). Select blocking edges by an **allowlist of roles**, never by excluding one — a negative filter silently promotes every newly-added role into a blocker, which is how a photo attachment nearly became a delete blocker for every product with an image (the #428 failure mode).
  - **Liveness.** Every edge is `must-target-live` except `Ingredient.recipeId`, which explicitly allows a deleted recipe so the sub-recipe pointer survives for staleness/recompute. `findReferentialLivenessViolations` audits the rest inside `problems.getFast` and reports zero on production — a row there is a regression in some removal path, not a backlog.
  - **Previews.** Only relation attach/detach gets a preview planner, sharing the mutation's own predicates (extract the predicate, don't copy it). Deletes and merges have no preview: the mutation's blocking checks return structured refusals (code + counts), and attempt-and-read-the-refusal is the contract — see `docs/entities.md`. Previews stay **advisory**: the mutation re-checks inside its transaction, so a preview is never a lock or an approval, and the UI must not gate confirmation on one loading or failing — only on a positively-returned `canProceed: false`.

## Branded IDs

Use branded ID schemas from `@cubby/schemas/identifiers` (e.g., `locationId`,
`productId`) instead of plain `z.string()`. Generic entity code uses
`EntityId<E>`, `entityIdSchema(entity)`, and `parseEntityId(entity, value)` so
the entity discriminant and identifier brand remain correlated. This prevents
mixing up entity IDs at compile time.

DB id columns are branded with `.$type<XxxId>()` in `schema.ts` (PKs + FK refs to core entities: recipe, ingredient, product, location, inventory, cookbook, user, project, task, vendor, purchase, expense), so Drizzle queries return branded ids **natively** — no cast needed when reading or writing entity ids. Relation reads inherit column brands, so nested `.id`s are branded too.

Parse strings exactly once at genuine ingress seams: auth, persisted JSON,
external input, DOM events, imports, and raw SQL. Everywhere else, fix the
producer or shared interface so it returns the correct brand directly. Never
fabricate an empty or cross-entity id for disabled state or a row key; represent
absence with optional state and use dedicated presentation keys. Tests use
`testEntityId(entity, seed)` and `testShortcode(entity, seed)` from
`@cubby/schemas/testing`; malformed-input tests keep their raw strings. The AST
identifier guard runs across production, tests, tooling, fixtures, and generated
TypeScript in `pnpm check`.

Don't brand shortcode columns: Drizzle's generic table unions erase the
entity-specific brand in insert, collision-retry, relation, and comparison
paths. Parse shortcode columns at repository mapper seams with
`parseShortcodeFor(entity, value)` instead. **`Image` is no longer an id-system
exception.** It is a full `ShortcodeEntity`, and correlated `EntityRef<E>` plus
typed resolvers ensure an `IMG-` code is resolved before a join-table write.
The physical `Image.id` and shortcode columns deliberately remain unbranded;
the schema and repository boundary carry the runtime proof.

## Shortcodes are the public id; uuids are private

A uuid PK is an implementation detail of the repo layer. The **shortcode** (`PRD-4K7M`) is what URLs, QR labels, and MCP expose. See [README](../../README.md#public-identifiers--shortcodes) for the sixteen-prefix registry.

- **A uuid must never reach a URL or an MCP payload.** Detail routes are `/products/$shortcode`; typed route params, shortcode schemas, and generated MCP contracts enforce the public-id boundary. Review server-built string links explicitly because typed router params cannot see them.
- **Resolve in exactly one place** — `apps/web/src/server/repo/shortcode-resolver.ts`. Don't add a `findXByShortcode`; three of those existed and were deleted. `resolveShortcode` answers *"what does this code name"* (soft-deleted rows included, so a scan of a dead label can say so); `resolveLiveShortcode(db, code, entity)` answers *"can I still open it"* and pins the expected entity, so a `LOC-` code handed to a product lookup returns null instead of leaking a uuid.
- **Reach for the throwing wrappers first.** `resolveOrThrow(db, entity, code)`
  is what most callers want — it derives the branded id, the `<ENTITY>_NOT_FOUND`
  reason, and the message label from the entity, so a call site names none of
  them. Plural splits by what a missing code means: `resolveAllOrThrow` (404s,
  naming **every** missing code, not just the first) vs `resolveAllPresent`
  (narrows to what exists). Choosing between them at the call site is the point —
  the old shapes hid that choice in the `.flatMap` versus `.filter` that followed.
  Drop to the raw `resolveLiveShortcode(s)` only where a miss is genuinely not a
  404: a nullable getter, a validation failure on caller-supplied input
  (`REFERENCED_RECORD_MISSING`), a polymorphic reason, or an invariant violation
  on a row the same function just created — those throw a plain `Error` **on
  purpose**, and turning one into a client-facing 404 is a regression, not a
  cleanup.
- **Mint via `insertWithShortcode`** (`repo/shortcode-utils.ts`), not by hand. The unique index is authoritative — it spans soft-deleted rows so a retired code is a permanent tombstone — and the helper retries on `23505` inside a SAVEPOINT. A bare `generateUniqueShortcode` + insert is only correct where the code must be materialized outside the insert (a `findOrCreate` values thunk, a caller-supplied code).
- **Never reassign or reuse a code**, including on merge: the loser keeps its own tombstone. If a merged-away code ever needs to resolve to the survivor, that's an explicit alias table, not a reassignment.
- Shortcode schemas (`shortcodeSchema(entity)`) must stay a **`ZodString`** — `.trim().toUpperCase().regex()` as string-level checks. Wrapping them in `.transform().pipe()` still parses, but turns them into a `ZodPipe` whose input-side JSON Schema drops the `pattern`, silently stripping the prefix hint MCP advertises to agents. Guarded by `shortcode.unit.test.ts`.

## Mobile PWA

**Target: iOS only** — no Android-specific APIs (e.g., `navigator.vibrate` is not available on iOS Safari). The installable app shell and offline fallback are shipped; [the Mobile / PWA backlog](../todos.md#mobile--pwa) tracks the scanner UX and perf work that remains.

## apps/web UI conventions

Visual intent and normative tokens live in [apps/web/DESIGN.md](../../apps/web/DESIGN.md). React hook rules, token implementation constraints, spacing, layout primitives, tables, and the page shell live in [apps/web/AGENTS.md](../../apps/web/AGENTS.md) — loaded automatically when working under that directory.
