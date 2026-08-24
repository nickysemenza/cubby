# 🗂️ Entity genericization ledger

This doc records where "one manifest entry, N integrations" ended and plain
per-entity code began, and *why*. It exists so the next sweep doesn't
re-propose a direction that was already tried, measured, and rejected — read
[Rejected directions](#rejected-directions) before designing a new generic
layer. For entity *naming* (UI vs code vs DB), see
[docs/terminology.md](terminology.md); this doc is about *mechanism*, not
vocabulary.

## The fixed point

The thesis (confirmed against the repo's own precedents — `merge/core.ts`,
`removal/core.ts`, `registerEntityCrudToolset`, `crud-factory.ts`,
`entity-bindings.ts`): a **generic execution core with a closed vocabulary**,
called from **plain per-entity code** at each call site, beats both extremes —
a fresh copy-pasted implementation per entity, and a single dynamic function
that branches on entity type at runtime. The core owns the part that must
never be skipped (embedding cleanup, audit stamping, cascade derivation); the
call site owns the part that is genuinely different per entity (which
Drizzle table, which columns, what the mutation's own predicates are).

Generalize only a **mechanical transcription of a declaration that already
exists** — the manifest already says an entity is `searchable`, `auditable`,
or `mergeable`, so deriving an `IncomingEdgeKey<E>` or building `xMcpOut`
from the same private field map as `xOut` (the schemas package bans `.pick()`
— see check-conventions' "Schema contract derivation" rule) removes
copy-paste without removing a decision. Never generalize **judgment**: a mutation's business rules, the SQL
a list query runs, the text an embedding is built from, and a search-document
projection are where an entity's actual behavior lives, and collapsing them
behind a shared abstraction hides the one place a reviewer needs to look.
`removal/core.ts`'s own header states this as an invariant: the core "does not
remove the entity's own rows" because removal statements differ per entity —
soft vs hard, which children cascade, which unique-index slot has to be
vacated first — and several call sites depend on that order.

**What "add one manifest entry" supplies today.** Adding an entity to
`ShortcodeEntity` (`entity-manifest.ts`) and to the
`satisfies Record<ShortcodeEntity, EntityBinding>` table in
`apps/web/src/server/entity-bindings.ts` is **one compile error** enumerating
every unsupplied Zod contract slot (`crud`: create/update/id/output schemas;
`mcpOut`: the slim MCP projection — each nullable only as a documented
decision) — not a silent gap discovered at runtime. Delete policies and
filter-option specs deliberately keep their own exhaustive registries
(`entity-lifecycle-registry.ts`, `FILTER_OPTION_SPECS`) rather than living in
this binding; the bindings file's header records why. Layered on
top: `crud-factory.ts` derives standard router CRUD from those schemas plus
repo functions; `registerEntityCrudToolset` derives the MCP tool family;
`merge/core.ts` / `removal/core.ts` derive the embedding-cleanup and audit
cascade for merge/delete; route factories (`entity-routes.tsx` +
`entities/list-search.ts`) derive list/detail routes; `EntityListPage` derives
the list-page hook preamble; the generic `EntityMergeDialog` derives the merge
UI from a `mergeable` config row; the Activity `DetailSection` derives from an
`auditable` flag.

**What stays hand-written on purpose, every time:** the entity's own repo
mutation bodies (locking, validation, side effects), its list-query SQL
(joins, filters, sort columns), its search-document projection (what text
represents this row in search), its embedding text (what text represents this
row in semantic search), and — where a field's meaning genuinely diverges
between layers (product's `price`/`effectivePrice`) — its own MCP output
shape. `entity-bindings.ts`'s own header explains why repo functions and
filter-option specs are deliberately *not* bound there: binding repo readers
would force the binding module to import all eighteen repo modules (and
everything each repo pulls behind it) into every router that reads any single
binding, and filter-option rosters are not one-per-entity (`locationWithInventory`
and `locationIdentityProduct` are two rosters over the *product* axis reached
through location) so keying them by entity would misrepresent the data.

## Rejected directions

Each entry: what was proposed, the concrete evidence against it, and when to
revisit.

- **Drizzle → Zod schema derivation.** `packages/schemas` has no `drizzle-orm`
  dependency, so deriving Zod input/output shapes from Drizzle table
  definitions would either invert the package boundary (schemas importing the
  web app's DB layer) or duplicate table shape into a second location. The
  derivable region is also small — an estimated 300–500 lines of the ~thousands
  in `packages/schemas`. **Revisit when** a validated `drizzle-zod` exists for
  the TS7-native / Zod 4 combination this repo runs, or a build step is
  introduced that can safely cross the package boundary at compile time
  without a runtime dependency.
- **Manifest-driven search-document SQL.** The per-entity branches that build
  `SearchDocument` rows are only ~85 lines total across every entity, and each
  branch's projection (what fields concatenate into the searchable text, what
  gets a boost) is a judgment call, not a mechanical transcription of a
  declaration. **Revisit if** the branch count grows past the point where
  reading them side-by-side stops being the fastest way to audit search
  coverage.
- **Generic `deleteEntity` mutation wrappers.** Locking strategy, which guard
  checks run in what order, and the exact refusal message differ per entity;
  `removal/entity.ts` is the argument for keeping this as an argument to a
  shared cascade tail (`removal/core.ts`), not a fully generic mutation.
  **Revisit if** a second, truly uniform deletion shape emerges across enough
  entities that the per-entity argument itself becomes boilerplate.
- **Single dynamic `$entity` route.** A route parameterized on entity name at
  runtime kills per-entity search-param types (TanStack Router's
  `Route.useSearch()` needs literal keys to infer), creates route collisions
  with entities that already have bespoke tails (product, expense, task,
  location, project), and produces worse deep links. Route factories
  (`entity-routes.tsx`) keep literal `createFileRoute` paths for exactly this
  reason. **Revisit if** TanStack Router ships first-class support for typed
  dynamic route params keyed off a manifest.
- **Colocated per-entity mega-modules.** Grouping all of one entity's
  schema/repo/router/MCP code into a single file loses the
  `satisfies Record<ShortcodeEntity, EntityBinding>` exhaustiveness check —
  that check works because the binding table is one file enumerating every
  entity, not one file per entity that a reviewer has to remember to add.
  **Revisit if** TypeScript gains a way to assert exhaustiveness across files.
- **Merging filter/view/editing manifests.** These are orthogonal domain data
  (which fields are filterable, how a detail page lays out sections, which
  fields are inline-editable) that happen to share an entity key, not one
  concern split three ways. Merging them would force every consumer of one
  manifest to import the shape of the other two. **Revisit if** a fourth
  manifest is proposed and the pattern of "orthogonal, keyed by entity" starts
  looking like it should be a documented convention instead of three files.
- **Declarative preview-card spec language.** A spec language (JSON/config
  describing which fields render where) would need to express the same logic
  the hand-written `toXCard` mappers already express in TypeScript — the
  mappers *are* the spec, just typed against `RouterOutputs["e"]["getByID"]`
  instead of a bespoke schema. **Revisit if** the mapper count grows enough
  that a genuinely declarative subset (not the whole mapper) pays for itself.
- **Hooks/callbacks in `merge/core.ts` / `removal/core.ts`.** Both cores
  derive their cascade from the entity's own manifest declaration
  (`isSearchable`, etc.) specifically so it cannot be forgotten or aimed at the
  wrong entity. A hook or callback parameter would reopen exactly the hole
  those cores exist to close — a caller could pass a hook that skips the
  cascade, and nothing would catch it. **Revisit only if** a caller has a
  correctness need a hook could satisfy that isn't itself a bypass of the
  invariant — treat that as a strong presumption against, not a design
  question.
- **Unwinding view-manifest.** The view manifest is the anti-divergence engine
  behind the Problems page — the mechanism that keeps "what a page renders"
  and "what Problems checks for" from drifting apart. Folding it into another
  manifest or removing the indirection would remove that guarantee.
  **Revisit if** the Problems page itself is redesigned around a different
  mechanism.
- **Gitignoring `routeTree.gen.ts`.** Generated files are checked in
  deliberately in this repo (see the `generated-files-ok-to-commit`
  convention) specifically because a fresh worktree needs a working route
  tree before its first `pnpm dev` generates one — gitignoring it reintroduces
  the worktree-generator trap where a new worktree's first build fails on a
  missing route tree. **Revisit if** the worktree bootstrap script is changed
  to generate it as a setup step before anything else runs.
- **Cookbook detail → generic `DetailSection`.** Cookbook detail is genuinely
  tabbed (source metadata vs. the recipe list extracted from it) in a way the
  generic detail-page section list doesn't model; forcing it through
  `DetailSection` would add lines, not remove them, to express the same tabs
  a different way. **Revisit if** the generic detail page grows tab support
  for another reason and cookbook's tabs become a natural second consumer.
- **Genericizing embedding texts, merge business logic, or the fat bespoke
  routers.** Each entity's embedding text is a judgment call about what makes
  two rows semantically similar (a vendor's embedding text is not built the
  same way a recipe's is); merge business logic (which fields survive, which
  sum, which the keeper wins) is equally entity-specific; and routers that
  have grown large did so because their entity has more real behavior, not
  because the router pattern failed. **Revisit** case-by-case only if a
  specific router's size is shown to come from boilerplate rather than
  behavior.
- **Deleting the ledger/relatedness subsystems.** These shipped days before
  this sweep and currently show 0 backfilled rows — that reads as "not yet
  exercised," not as "unused." Deleting a feature on the evidence of an empty
  table it hasn't had time to fill would destroy real, recent work.
  **Revisit if** the row count is still zero well after the feature has had a
  realistic chance to be exercised (weeks, not days).
- **SearchDocument-driven generic preview card.** A preview card built from
  the `SearchDocument` projection (title + one line of secondary text) is
  blander than the current per-entity rich mappers, which surface
  entity-specific fields (a product's price, a task's due date) that
  `SearchDocument` doesn't carry. **Revisit if** preview-card upkeep (the 13
  hand-written `toXCard` mappers) grows past the point where blander-but-free
  becomes the better trade.
- **Coarse `invalidateQueries()` instead of a fan-out table.** Blanket
  invalidation was rejected on two grounds: Neon egress (see memory:
  neon-free-egress-quota-drain-loop — every invalidated query re-hits
  Hyperdrive, and Hyperdrive caching is deliberately off) and
  `useOptimisticDelete`, which needs the *specific* set of query keys to
  perform `setQueryData` surgery rather than a blanket refetch. The curated
  `invalidatesFor(entity, op)` table in `lib/query-keys.ts` keeps the
  cross-entity edges (e.g. product mutations also invalidate `task.all`) as
  explicit, commented rows. **Revisit if** the fan-out table's edge count
  grows large enough that maintaining it by hand becomes the bigger cost.
- **Deriving `xRelatedFilterFields` from the related-view registry.** Attempted
  during this sweep and abandoned on type-level evidence: `relatedViewRegistry`
  is built with `.map()` and a widening cast, and `localRelationshipByKey` is
  non-generic, so a view's `target` is the wide `Entity` union — a mapped type
  over `Extract<RegisteredRelatedView, {source: E}>` cannot recover the literal
  key and every `filters.vendorId`-style access degrades to `Record<string, …>`
  repo-wide. Recovering the literal would need an `as const` manifest plus a
  generic `localRelationshipByKey`, or a second hand-kept key→target table —
  more drift surface than the 13 hand-written blocks cost. The full reasoning
  lives in the comment above `productRelatedFilterFields` in
  `packages/schemas/src/related-view.ts`. **Revisit if** the registry's
  construction ever preserves literal `target` types end-to-end.
- **A `new-entity` scaffolding generator.** Rejected by the owner outright.
  The `entity-bindings.ts` compile errors already enumerate every stub a new
  entity needs, and writing those stubs by hand is where an entity's real
  decisions get made — a generator would just move typing around while adding
  a script to maintain. **Not a revisit candidate.**

## Kept on purpose

- **Product movement views** (`list-page` events/lifecycles views +
  `movement-timeline.ts`) stay as their own bespoke sibling of the generic
  Activity `DetailSection`, not folded into it. Product's movement timeline
  shows inventory-specific event types (restock, consumption, relocation)
  that the generic audit-log Activity section doesn't model; every other
  auditable entity (vendor, task, expense, location, ingredient, inventory,
  wish, cookbook, financial account, …) gets the generic section for free
  instead.
- **Rich preview-card mappers** (`toXCard` functions) stay hand-written,
  typed against `RouterOutputs["e"]["getByID"]` rather than collapsed into a
  declarative spec or a `SearchDocument`-driven generic card — see the two
  rejected directions above.
- **Product's hand-written MCP projection** (`productMcpFields` /
  `productMcpOut` in `packages/schemas/src/product.ts`) stays hand-written
  rather than sharing the plain shape's field map, because `price` and
  `effectivePrice` on the MCP shape and `price` and `pricing.effectivePrice`
  on the plain shape are the *same two concepts with swapped surface meaning*
  (MCP's `price` is the raw manual override; the plain output's
  `pricing.effectivePrice` is the resolved value) — a shared field map can
  transcribe key names but can't reconcile
  that inversion. The doc comment at `product.ts` (search for "Hand-written
  rather than picked from `productTopLevelOut`") is the load-bearing
  explanation; keep it in sync with this entry if the shape changes again.
  `mcp-out-drift.unit.test.ts` still exists, shrunk to product-only rows,
  because product is the one entity where the derivation guarantee doesn't
  apply and drift has to be caught by hand.
- **Blocker-message plain code.** Refusal messages returned by blocked
  mutations (`VENDOR_HAS_PURCHASES` and friends) stay per-entity plain code,
  not a generic templated message, because the useful part of a refusal is
  the entity-specific detail (which purchases, how many, what to do next) —
  genericizing the message would genericize away the reason someone reads it.
