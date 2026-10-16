# Manifest-driven list fields: filters, sort, grouping

Status: **proposed**. Design agreed 2026-10-15 in a design session run against
`main` at `c9ea7fe13`. Tracking: [#2407](https://github.com/nickysemenza/cubby/issues/2407)
and its sub-issues. Execution: one PR per issue, in the order in
[§9](#9-work-breakdown), each in its own session. Each issue keeps scope and
acceptance; this plan owns the design those issues share. Where an issue body
and this plan differ, this plan governs. [§13](#13-execution) describes how the
chain runs. Delete this plan
when #2407 closes, after moving durable rules into
[`docs/entities.md`](../entities.md).

## 1. Summary

List filtering, sorting, and grouping should compile from entity declarations,
with no per-entity filter, sort, or group code. This applies
[Generic by default](../entities.md#generic-by-default) to the list pipeline:
the capability lives in the declaration, the per-entity twin is deleted, and
an exception is declared with a reason.

When done:

1. Every value filter is any-of, can match **Any value** or **No value**, and
   multi-valued fields can switch between matching any and all chosen values.
2. Any declared field, on the entity itself or one to-one step away, can
   filter, sort, and group, through one compiled expression.
3. Every list layout that can show sections shows them, on web and on
   iOS/macOS. A section header filters to its value.
4. A choice the compiler can't support stays visible but disabled, with the
   reason, on every surface.

Boolean filter trees are not part of this ([§11](#11-non-goals-and-deferred-work)).

## 2. Current state

- **Filter kinds:** text, select, multiselect, presence, boolean, id,
  idMulti, range (`packages/schemas/src/entity-definitions/definition.ts:82`).
  Different filters AND together; values within a multiselect are any-of.
  `select` and `id` allow only one value, so the work queue cannot pick two
  kinds.
- **Predicates:** `declaredFilterPredicates`
  (`apps/web/src/server/generic/list/repo/list.ts:218`) compiles roughly a
  quarter of value filters; the rest are hand-written across 29 `build*Where`
  functions. `listScaffold` is shared by 28 repos.
- **Sort:** 11 named `resolve*Sort` functions plus inline branches, with 64
  domain `orderBy ===` branches. `sort.computed` → `generatedEntitySort` →
  `EntitySortContract` already declares derived sorts
  ([entities.md](../entities.md)). `relatedSortExpression`
  (`generic/entity-links/repo/related-view.ts:517`) sorts by a related column
  for products only.
- **Related paths:** `compileTraversal`
  (`generic/relatedness/repo/traversal.ts:222`) emits plain JOINs and has no
  notion of cardinality. `relatedWhereConditions` filters through `EXISTS`.
- **Hierarchy:** `locationDescendantsSql`, `categoryDescendantsSql`, and the
  JS `collectDescendantIds` each expand descendants their own way. `list.tree`
  both names the parent field and enables nested lists by default; only run,
  product category, and spending category declare it.
- **Grouping:** `sort.groupable` / `grouping` (`definition.ts:763-792`),
  parsed by `parseGroupBy` (`entity-kernel/list-input.ts:49`).
  `groupBy` is a list request param (`pagination.ts:217`); saved views
  (`definition.ts:1257-1300`) cannot declare it, and Apple reads it out of the
  filter dictionary (`EntityKernel.swift:91`). Web entity lists have no Group
  by control; grouping comes only from the URL or code. Only product
  (`loadProductCategoryGroups`) and location (`GROUP BY type`) produce server
  group summaries (`ListGroupSummary`, counts over the whole filtered set).
  Web `GroupConfig` is hand-wired per entity; the shared grouped renderer
  already feeds both the table and `ShelfGrid` (Cards/Compact).
  `SectionHeader` has no action. Apple's `EntityListView` has no sections.

## 3. Field compiler

One generic compiler turns a declared list field into SQL. The same field
declaration serves filter, sort, and group, so a section header and the filter
for that field address the same path. Four shapes, which compose: a related
path can end in a hierarchy (Inventory → `product.category` with descendants,
`inventory/repo/crud.ts:378`).

| Shape         | Example                                                                                                    | Compiles through                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Own column    | `inventory.condition`                                                                                      | today's `stored` path in `declaredFilterPredicates`                                                         |
| Related path  | Inventory → `product.category`, declared `{ via }` in `model.derived`                                      | `compileTraversal`                                                                                          |
| Derived field | project `stalled`, inventory `valuationStatus`                                                             | SQL the domain repo passes into `listScaffold`, declared in `model.derived`                                 |
| Hierarchy     | location, product category, project; task's `parentTaskId` is declared but no list filter expands it today | one recursive-descendant generator, applied to an own column or to the terminal reference of a related path |

### Cardinality

- **Filters** compile to `EXISTS (…)`, so to-many paths are fine for filters.
- **Sort and group** compile to a correlated scalar subquery, as
  `relatedSortExpression` does today, and accept only to-one paths
  (single-reference steps). The compiler rejects any other path with a reason
  derived from the declaration ([§7](#7-unsupported-choices)).

### Derived fields

Approved shape (2026-10-15). `model.derived` replaces `sort.computed`: one
map of every list field that isn't a table column. Keys are identifiers, so
URL params, the `groupBy` enum, and Swift can name them; `sort.fields`,
`grouping`, and filter descriptors refer to them like any field.

```ts
derived: {
  category:        { via: "product.category" },
  valuation:       { type: "number" },
  valuationStatus: { type: "enum", options: ["valued", "missing", "priceable"] },
  categoryFeature: { predicate: "multiselect", options: featureOptions,
                     reason: "Inherited through category ancestors; not a row value" },
}
```

- **`via`** names a related path. The compiler builds it (`EXISTS` for
  filters, a scalar subquery for sort and group), even when the repo already
  joins that table: knowing each repo's FROM would be per-entity knowledge. If
  the query-plan check in §10 shows a real cost, add a declared index rather
  than a join-aware compiler.
- **`type`** is a value. The generic forms in §4 (any-of, Any value / No
  value, ranges), sort, and group follow from the type.
- **`predicate`** is filter-only and must declare a `reason`. It is the
  declared-exception form from [Generic by default](../entities.md#generic-by-default),
  so predicates are countable and should shrink.

The domain repo supplies SQL once, when it builds the scaffold, as an
argument rather than a registry ([ADR 0019](../adr/0019-domain-first-server-layout.md)):

```ts
const inventoryList = listScaffold("inventory", inventoryEntry, {
  derived: {
    valuation: {
      prepare: (db) => loadLiveInventoryValuations(db),
      sql: (valuations) => inventoryValuationSql(valuations, inventoryEntry.id),
    },
    valuationStatus: {
      prepare: "valuation",
      sql: (valuations) => valuationStatusSql(valuations),
    },
    categoryFeature: (values) =>
      categoryFeatureInSql(sql`${product.categoryId}`, values),
  },
});
```

- The `derived` argument's type is generated from the declaration and must
  cover every `type` and `predicate` key, so a declared field without SQL
  fails to compile.
- `prepare` loads request data only when the request filters, sorts, groups,
  or projects on that field. It runs at most once per request, may be shared
  by naming another field, and its result is available to `hydrate`. This
  keeps inventory's rule that rows, sort, filter, and footer read one
  valuation map.
- `scaffold.where` needs prepared data before it builds, so it either becomes
  async or follows a `scaffold.context(db, request)` step. #2408 picks one
  while rewiring the 28 callers. The `computed: SQL[]` argument
  (`list.ts:505`) shrinks as fields move into `derived`.

### Hierarchy

Declare `hierarchy: { parentField }` separately from `list.tree`. `list.tree`
refers to the hierarchy and keeps controlling nested display. Location, task,
and project gain `hierarchy` without gaining `tree`, so their lists keep their
current UX. A filter on a hierarchical reference, own or at the end of a
`via` path, gets a generated **Include sub-‹entity›** toggle, on by default.
It replaces paired filters such as inventory's `locationIdFilter` and
`locationSubtreeFilter`. Descendant expansion reads
`hierarchy` and replaces the helpers where list filters use them
(`project/repo/lookup.ts:236`, `task/repo/lookup.ts:147`,
`inventory/repo/crud.ts:374,378`, `product/repo/crud.ts:674,775`). The
non-list callers of the two SQL helpers (`product-category.ts:533,633`,
`entity-embedding-cleanup.ts:170`, `productSearch` in `product/repo/crud.ts`)
move to the generator too, which deletes `locationDescendantsSql` and
`categoryDescendantsSql`. About 10 non-list `collectDescendantIds` callers
(calendar, expense, reports, dashboards) rely on its depth cap and cycle guard
in JS and stay.

## 4. Filter semantics

There are no per-filter meta-options such as `all` or `either`. Every value
filter has the same generic forms:

| Intent        | Generic form                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All rows      | No filter. Delete `all` options. Inventory's "absent means stock" becomes `placement=stock` on the default saved view.                                  |
| Has any value | Generated **Any value**, on every nullable field. Replaces `suggestionPresenceFilter: any` and `*PresenceFilter` filters that duplicate a value filter. |
| Has no value  | Generated **No value**, same scope.                                                                                                                     |
| A, or A or B  | Any-of.                                                                                                                                                 |
| A or no value | Any-of plus No value (`eqAnyOrPresence`, now generic).                                                                                                  |
| A and B       | **Match all**, offered only on multi-valued fields (tags, many-references).                                                                             |

- The `select` and `id` kinds are deleted. Their descriptors become
  `multiselect` / `idMulti`. Single-option flags (ingredient `mappingGap`,
  inventory `locationRole`) become `boolean`.
- A single value in a URL or a saved view reads as a one-element list, so no
  stored-data migration is needed. MCP's `oneOrMany` keeps scalar input valid.
- Hierarchy filters include descendants.
- The `@me` member token ([ADR 0018](../adr/0018-current-member-filter-token.md)) is
  something a descriptor declares. That replaces the
  `referenceEntity === "ledgerParty"` checks on web, in generated MCP, and in
  Apple's `EntityFilterSheet`.
- Work-queue `waitingFor` breaks down into a member any-of with `@me`, plus No
  value for "unresolved". Anything that can't be broken down is declared as an
  exception.
- Data-quality `dataStatus` becomes any-of. The server currently keeps only the
  first value (`generic/data-quality/repo/sql.ts:378`).

### Filter UI (web and Apple)

- **Any value** and **No value** sit at the top of the value list, above a
  divider. No value combines with specific values. Picking Any value clears
  specific values, because it already includes them.
- Multi-valued fields show a **Match any | Match all** toggle at the top of
  the editor. The chip joins values with "or" or "and" ("Tags: winter and
  wool"). Single-valued fields never show the toggle.
- An inactive chip still reads "any" (`filterSummary` in `ui/data-table/filter-bar.tsx`). An active Any value chip
  reads "has a value", so the two states don't look alike.
- On Apple, `EntityFilterValue.single` (about 70 call sites with tests) and the single/multi branches in
  `EntityFilterSheet.swift` go away. `SavedViewFilter.isList` leaves the native
  wire ([§10](#10-risks) covers the installed app).

## 5. Sort

Sort expressions compile from declared fields. #2408 compiles a field's ORDER BY
expression, so grouping does not wait for the sort migration. #2412 then
deletes the per-entity resolvers. Non-column sorts (product GTIN,
`quantityVariance`) become derived fields. `relatedSortExpression` becomes the
compiler's related-path case.

## 6. Grouping

- **Declaration:** `grouping` names any groupable declared field, including one
  to-one related path (Inventory → `product.category`). The group key and the
  field's filter address the same path.
- **Saved views:** add `groupBy` to the saved-view declaration and the native
  manifest wire, owned by #2259
  ([breaking changes](../agents/domain-rules.md#breaking-changes)). Apple stops
  reading it from the filter dictionary.
- **Server:** generic group summaries (key, label, count over the whole
  filtered set) and a group-first ORDER BY come from the declaration. They
  replace `loadProductCategoryGroups` and location's `GROUP BY type`.
- **Order:** declared option order for enum fields, label order for related
  records. The no-value section is always last and is labelled
  "No ‹field label›" ("No clothing type").
- **Contiguous sections:** pagination is offset-based (`pageIndex`/`pageSize`).
  The page query and the summary query share one total order: group ordinal
  (no-value forced last), then the declared sort, then the existing shortcode
  tie-breaker (`list.ts:563-564`). Related-label groups order by the same
  scalar subquery in both queries.
- **Web:** `GroupConfig` is generated from the declaration rather than wired
  in `list-columns.tsx`. A Group by menu joins the list's view options, offers
  every groupable declared field (disabled ones with their reason), and writes
  the URL `groupBy`. A declared saved view sets its default `groupBy` in its
  declaration. Generic sections use the neutral gray band; a domain
  color stays optional. Headers are sticky and show a quiet tabular count.
  A **Filter to this** button appears on hover and is keyboard reachable.
  Collapsing sections is not in v1.
- **Apple:** `EntityListView` gets pinned section headers in table, Cards,
  and Compact. Tapping a header filters to that value. **Group by** sits in
  the view-options menu next to the Cards/Compact/List choice and is kept with
  the list's other view state. A declared saved view's `groupBy` arrives on the
  manifest wire as the default; the Wardrobe saved view declares one.
- **Header action:** selecting a header sets that value as the field's
  include filter and keeps grouping, leaving one section and an active chip. A
  header has the action only when its field has a declared filter. Inventory
  has one after #2410; others get it as #2411 migrates them.
- **Layouts:** List, Cards, and Compact group. Timeline is already arranged by
  date, so its Group by is disabled with that reason. Specialist views (task
  board) are out of scope.

Mockups for §4, §6, and §7 are attached to #2407.

## 7. Unsupported choices

A field, path, or layout the compiler can't support stays in the menu,
disabled, with a one-line reason under it. The reason is derived from the
declaration, not hand-written per entity. A hover tooltip would not work on
touch. Example reasons:

- "A record can have several Tags, so it would appear in more than one group."
- "Goes through a list of Purchases. Only paths that lead to a single record
  can group."
- "Timeline is already arranged by date."

Web shows the reason as a secondary line, Apple as a menu subtitle. HTTP and
MCP reject the same request with the same text, unmasked
([README tenets](../../README.md#tenets)).

## 8. Migration rules

- Each PR deletes the hand-written code it replaces and lists the deletions in
  its done report.
- An exception lives in the declaration with a reason, not only in a PR body.
- The filter migration spans three PRs, so #2409 adds a **shrink-only
  baseline** of the remaining hand-written filter predicates, as
  [Finish migrations](../entities.md#generic-by-default) requires: an Oxlint
  rule in `tools/oxlint/cubby/` with a JSON baseline, following
  `no-raw-enum-literal-in-sql-baseline.json`. #2410 and
  #2411 only remove entries from it; #2411 deletes it.
- Each PR updates `docs/entities.md`, including the sentence "SQL predicates
  remain explicit in repository filter builders", which this work retires.

## 9. Work breakdown

```text
#2408 field compiler ──┬─> #2409 filters 2a ─> #2410 2b ─> #2411 2c ─> #2413 exclude
                       │                          │            └─> closes #2333
                       ├─> #2412 sorts            │
                       └──────────────────────────┴─> #2259 grouping
```

| Issue                                                      | Scope                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#2408](https://github.com/nickysemenza/cubby/issues/2408) | Field compiler: four shapes, `model.derived` replacing `sort.computed`, the `listScaffold` `derived` argument, cardinality rule, ORDER BY, `hierarchy` declaration and sub-entity toggle, list-filter descendant helpers.         |
| [#2409](https://github.com/nickysemenza/cubby/issues/2409) | Filters 2a: delete `select`/`id`, generated Any value / No value, match all, `@me` declared, work queue, data quality, Apple wire, baseline, simple entities (device, vendor-account, ledger-party, spending-category, cookbook). |
| [#2410](https://github.com/nickysemenza/cubby/issues/2410) | Filters 2b: product, inventory, project.                                                                                                                                                                                          |
| [#2411](https://github.com/nickysemenza/cubby/issues/2411) | Filters 2c: remaining domains and vendor; live shortcode subqueries via `referencePredicate`; deletes the baseline.                                                                                                               |
| [#2412](https://github.com/nickysemenza/cubby/issues/2412) | Sorts: delete per-entity resolvers.                                                                                                                                                                                               |
| [#2259](https://github.com/nickysemenza/cubby/issues/2259) | Grouping on web and Apple (§6).                                                                                                                                                                                                   |
| [#2413](https://github.com/nickysemenza/cubby/issues/2413) | Exclude values, plus Hide on section headers.                                                                                                                                                                                     |

## 10. Risks

- **Request-scoped derived data.** A `prepare` that runs when no requested
  field needs it costs a full load (inventory valuations run WASM over every
  row). Test that a list read without the field skips it, and that one read
  with it loads once.
- **Sections across pages.** If the page and summary queries order
  differently, a section splits or its count disagrees with its rows. Test a
  related-key grouping across a page boundary, including the no-value
  section.
- **Scalar subquery cost.** Sorting and grouping on a related path adds a
  correlated subquery per row. Check query plans on the largest synthetic list
  (inventory) before #2259 merges.
- **Wire changes.** Dropping `select`, `id`, and `isList` touches HTTP, MCP,
  the native wire, and about 70 Swift call sites including tests. Follow
  [breaking changes](../agents/domain-rules.md#breaking-changes).
- **Installed native app.** The web Worker deploys on merge, while the app
  updates through [TestFlight](../ci.md#apple-testflight-release). The
  installed app may break between PRs; that is accepted, and there is no
  compatibility shim. The last PR of the chain to merge, whichever it is, bumps
  `APPLE_CLIENT_COMPATIBILITY_VERSION` once, which publishes promptly and
  raises the server minimum, then confirms the TestFlight upload processed.
  Earlier PRs do not bump, despite the breaking-changes rule to bump in the
  same change. Nightly uploads of intermediate `main` may still happen.

## 11. Non-goals and deferred work

- Boolean AND/OR/NOT trees, cross-filter OR, and a typed search syntax.
  Per-filter any-of, match all, and exclude cover the household cases.
  Rare cross-filter questions go to a second query or the agent.
- `problemFilterSemantics` stays deliberate judgment; revisit after #2411.
- Work queue and calendar pages stay off the entity list pipeline; the work
  queue still adopts any-of in #2409.
- Collapsible sections.
- Proposed later: declared row mapping
  ([#2414](https://github.com/nickysemenza/cubby/issues/2414)) and relative date
  tokens ([#2415](https://github.com/nickysemenza/cubby/issues/2415)).

## 12. Validation

Each issue lists its own checks. The plan-level acceptance belongs to #2259:
on iPhone, Wardrobe in Cards grouped by clothing type shows a section per type,
and tapping a header filters to that type.

## 13. Execution

An orchestrating session runs the issues in §9 order, one T3 thread and
`nicky/` worktree per issue, with #2412 alongside the filter work and at most
two implementation threads at once ([model routing](../agents/model-routing.md)). Each PR
follows [model routing](../agents/model-routing.md) for its independent review
and merges itself once final-head CI passes and the review has no unresolved
findings; merging deploys web. The derived-field shape in §3 is approved, so
the chain does not pause for it; a material change to that shape stops the
chain for the user. #2259 attaches web and simulator
screenshots of Wardrobe grouped by clothing type without waiting on them. Work
that can't finish returns as a blocked issue with the reason. TestFlight
follows §10: one build at the end.
