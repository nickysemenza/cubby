# Declared filter exceptions: removing hand-written predicates

Status: **proposed**, awaiting the user's approval. Written 2026-10-17 against
`main` at `4069ae097`. Tracking: the parent issue and its sub-issues (§9).
Execution: one PR per sub-issue, in the order in [§9](#9-work-breakdown), each
in its own session. Each issue keeps scope and acceptance; this plan owns the
design they share. Where an issue body and this plan differ, this plan
governs. Nothing in §9 starts until the user approves this plan and answers
the questions in [§14](#14-open-questions). Delete this plan when the parent
closes, after moving durable rules into [`docs/entities.md`](../entities.md).

## 1. Summary

The manifest-driven list fields chain (#2407) compiles every list filter from
a declaration. A filter that fit none of its shapes became a filter-only
`model.derived` `predicate` with a `reason`, and the domain repository passes
its SQL to `listScaffold`. Predicates were meant to be countable and to shrink
([Generic by default](../entities.md#generic-by-default)). This plan shrinks
them. Six declared shapes replace 40 of the 46 predicates and both
repository-applied scopes. The 6 that remain have a reason in their
declaration, under one stated rule (§3.7).

When done:

1. A filter over a child row, a JSON record array, a shared identifier row, or
   a computed share compiles from a declared **row set**. Several filters
   through one row set match the same row.
2. A field that inherits its value declares the inheritance once. Its reads,
   filters, sorts, and groups all compile the effective value from that
   declaration.
3. A search over several fields, own or related, is a declared list of those
   fields.
4. Relative dates are range values (`@today-7d`, #2415). A date interval is a
   declared value that range filters can test for overlap.
5. A state that is really one row value is declared as a `type` value, so it
   also sorts, groups, and excludes.
6. A list's static row scope and a project page's embedded scope are declared,
   not ANDed by the repository.

`rg -n 'predicate: "' packages/schemas/src/entity-definitions` then lists
exactly the entries in [§3.7](#37-stays) (6, or 7 if §8's `reconciliation` gate fails), and a shrink-only baseline keeps
it that way.

## 2. Current state

- **Shapes:** `model.derived` takes `{ via }`, `{ type }`, or
  `{ predicate, reason, negatable? }`
  (`packages/schemas/src/entity-definitions/definition.ts:826`). `compileVia`
  (`apps/web/generator/entities/list-fields.ts:151`) walks declared
  `local-path` relations to an **entity** and optionally ends at one of its
  stored fields. Any other segment is a declaration error.
- **Traversal:** `compileTraversal`
  (`apps/web/src/server/generic/relatedness/repo/traversal.ts:224`) already
  walks FK edges through non-entity tables. Its edge index adds FK facts for
  owned intermediate tables (`traversal.ts:60-117`), and `ENTITY_EDGES` already
  declares scoped edges for `EntityExternalId.entityId`, `PhotoRunImage.imageId`,
  `PhotoRunImage.runId`, and `ImageProcessingSubmissionJob.jobId`
  (`apps/web/src/server/db/entity-edges.ts:274,353,460,1505`). So the
  traversal can reach child rows. Only the declaration grammar stops at
  entities.
- **Same-row matching** is hand-built. A predicate reads its sibling filter
  through a `listPrepare` and keeps its own independent predicate, which the
  combined one implies ([Filters and search](../entities.md#filters-and-search)).
  Examples: account `source` with `externalAccountId`
  (`domains/financial-account/repo.ts:259-296`), image `runId` with
  `targetState` (`domains/image/repo/image.ts:1298-1328`), transaction
  `sourceRefs` with `externalId`
  (`domains/financial-transaction/repo/financial-transaction.ts:370-406`), and
  product task keys (`domains/product/repo/crud.ts:343-370`, "only the first
  present key renders"). None of these offer Exclude
  (`list-fields.ts:616`, `Include only: …`).
- **Inheritance:** `fieldResolutions` and `resolution` (`definition.ts:668-700`)
  declare reset, none, and confirm patches. The repository still computes the
  effective value ("repositories remain the authority"). The fallback chain is
  prose in `explanation.description`, and SQL helpers implement it by hand:
  `effectiveTaskAssigneeSql`, `effectiveTaskProjectSql`,
  `effectiveTaskSubjectProductSql`, `effectiveProjectLocationsSql`, and
  `effectiveProjectAssigneeSql`
  (`domains/task/repo/task-project-inheritance.ts:63-170`), plus
  `categoryFeatureInSql` (`server/db/computed/product-category-sql.ts:33`) and
  `categoryMappingSql`
  (`domains/product-category/repo/category-connections.ts:12`). They do not
  agree on depth. Project and category walk to the nearest explicit ancestor.
  Task project and subject product read one parent level only
  (`task-project-inheritance.ts:134-170`).
- **Search:** text descriptors OR own columns through `stored: { columns }`.
  A search that reaches an inherited or related field is a predicate (project,
  task, wish).
- **Dates:** relative dates are predicates over `householdLocalDate()`. #2415
  proposes value tokens. Compound `type` values sort but cannot filter
  (`field-compiler.ts`, `derivedValueSql`).
- **Scopes:** `buildIngredientListWhere` ANDs `isNull(ingredient.recipeId)`
  (`domains/ingredient/repo/search.ts:528`), and counts reuse it. Task and
  expense AND a project page's `projectScope`, resolved by
  `matchingEmbeddedProjectIds` through `buildDashboardProjectWhere`
  (`domains/project/repo/dashboard-shared.ts:269`, `task/repo/lookup.ts:142`,
  `expense/repo/lookup.ts:126,308`). Expense picks which allocation filter
  "leads" so membership applies once (`expense/repo/lookup.ts:177-192`).

### Inventory of the 46 predicates

Target: the shape in §3 that removes it, or **stays**. "Wire" marks a URL,
MCP, or saved-view key or value change ([§8](#8-migration-rules)).

| #   | Entity → key                                  | Declaration                    | Reads today (repo SQL)                                                                                  | Target                                                                   |
| --- | --------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | product `anyGtin`                             | `00-product.entity.ts:2019`    | `EntityExternalId` source gtin, WASM term expansion (`product/repo/gtin.ts:116`)                        | §3.1 row set `barcodes`, with the `productCode` term expander            |
| 2   | product `externalIdSource`                    | `00-product.entity.ts:2034`    | `EntityExternalId` source in values (`product/repo/crud.ts:504`)                                        | §3.1 row set `identifiers`                                               |
| 3   | financialAccount `last4`                      | `13-financialAccount…:552`     | JSONB `cardNumbers[].last4` exact (`financial-account/repo.ts:280`)                                     | §3.1 JSON row set `cards`; becomes a free-value `multiselect` (wire)     |
| 4   | financialAccount `source`                     | `13-financialAccount…:557`     | JSONB `sourceAliases`, same alias as #5 via prepare (`repo.ts:259,289`)                                 | §3.1 JSON row set `aliases`, same row                                    |
| 5   | financialAccount `externalAccountId`          | `13-financialAccount…:562`     | JSONB `sourceAliases[].externalAccountId` (`repo.ts:296`)                                               | §3.1 `aliases`, same row                                                 |
| 6   | financialTransaction `sourceRefs`             | `14-financialTransaction…:972` | `EntityExternalId` kind `settlement_ref`, same row as #7 (`financial-transaction.ts:383`)               | §3.1 row set `settlementRefs`, same row                                  |
| 7   | financialTransaction `externalId`             | `14-financialTransaction…:977` | same table (`financial-transaction.ts:370`)                                                             | §3.1 `settlementRefs`, same row                                          |
| 8   | image `runId`                                 | `18-image.entity.ts:636`       | child `PhotoRunImage`, run descendants, same row as #9 (`image/repo/image.ts:1300-1325`)                | §3.1 row set `importTargets`, `.run` (hierarchy toggle generated)        |
| 9   | image `targetState`                           | `18-image.entity.ts:641`       | `PhotoRunImage.state` (`image.ts:1326`)                                                                 | §3.1 `importTargets`, same row                                           |
| 10  | imageJob `submissionId`                       | `29-imageJob.entity.ts:300`    | child `ImageProcessingSubmissionJob` → `ImageProcessingSubmission.publicId` (`image-job/repo.ts:37-44`) | §3.1 row set `submissions`; free-value `multiselect` (wire)              |
| 11  | expense `ledgerPartyId`                       | `16-expense.entity.ts:1152`    | child `ExpenseAttribution` (`expense/repo/lookup.ts:212`)                                               | §3.1 row set `attributions`, `.ledgerParty`                              |
| 12  | expense `projectFilter`                       | `16-expense.entity.ts:1157`    | computed allocation shares, "lead" prepare (`expense/repo/lookup.ts:251-281`)                           | §3.1 repository row set `allocationShares`, same row                     |
| 13  | expense `spendingCategoryFilter`              | `16-expense.entity.ts:1162`    | same                                                                                                    | §3.1 `allocationShares`                                                  |
| 14  | expense `tradeFilter`                         | `16-expense.entity.ts:1167`    | same; presence reads `Expense.trade` (`lookup.ts:276-280`)                                              | §3.1 `allocationShares` (presence: see §8)                               |
| 15  | expense `costTypeFilter`                      | `16-expense.entity.ts:1172`    | same                                                                                                    | §3.1 `allocationShares`                                                  |
| 16  | product `taskStatus`                          | `00-product.entity.ts:2050`    | tasks by effective subject, all task keys on one task (`product/repo/crud.ts:357-370`)                  | §3.1 entity row set `subjectTasks` + §3.2 effective edge                 |
| 17  | product `taskOpen`                            | `00-product.entity.ts:2055`    | same, `status <> done`                                                                                  | §3.1 `subjectTasks.status`, "Open" preset (wire: `taskOpenOnly`)         |
| 18  | product `taskDue`                             | `00-product.entity.ts:2060`    | same, due range                                                                                         | §3.1 `subjectTasks.dueDate` (today's column, not the effective due date) |
| 19  | productCategory `effectiveSpendingCategoryId` | `22-productCategory…:596`      | `categoryMappingSql` nearest non-`inherit` ancestor (`product-category.ts:118`)                         | §3.2 inherited `spendingCategoryId`                                      |
| 20  | product `categoryFeature`                     | `00-product.entity.ts:2029`    | `categoryFeatureInSql` nearest non-null ancestor (`crud.ts:491`)                                        | §3.2 `{ via: "category.feature" }`, effective                            |
| 21  | inventory `categoryFeature`                   | `05-inventory.entity.ts:511`   | same through product (`inventory/repo/crud.ts:234`)                                                     | §3.2 `{ via: "product.category.feature" }`                               |
| 22  | project `effectiveLocations`                  | `09-project.entity.ts:821`     | `effectiveProjectLocationsSql` (`project/repo/lookup.ts:123`)                                           | §3.2 inherited `locations`                                               |
| 23  | project `effectiveAssignee`                   | `09-project.entity.ts:827`     | `effectiveProjectAssigneeSql` (`lookup.ts:125-140`)                                                     | §3.2 inherited `assigneeId`                                              |
| 24  | task `assigneeFilter`                         | `10-task.entity.ts:789`        | `effectiveTaskAssigneeSql` (`task/repo/lookup.ts:76-109`)                                               | §3.2 inherited `assigneeId`                                              |
| 25  | task `projectFilter`                          | `10-task.entity.ts:795`        | `effectiveTaskProjectSql`                                                                               | §3.2 inherited `projectId`                                               |
| 26  | task `subjectProductFilter`                   | `10-task.entity.ts:801`        | `effectiveTaskSubjectProductSql`                                                                        | §3.2 inherited `subjectProductId`                                        |
| 27  | project `search`                              | `09-project.entity.ts:816`     | name, notes, effective locations (`project/repo/lookup.ts:115-122`)                                     | §3.3 `anyOf`                                                             |
| 28  | task `search`                                 | `10-task.entity.ts:807`        | name, effective subject's name (`task/repo/lookup.ts:111-118`)                                          | §3.3 `anyOf`                                                             |
| 29  | wish `search`                                 | `15-wish.entity.ts:280`        | name, notes, candidate products' name/manufacturer/model (`wish/repo.ts:272-283`)                       | §3.3 `anyOf` over `candidates` `via` entries                             |
| 30  | task `dueRelative`                            | `10-task.entity.ts:812`        | `coalesce(dueEndDate, dueDate)` vs today (`task/repo/lookup.ts:125`)                                    | §3.4 range with tokens (wire)                                            |
| 31  | expense `dateRelative`                        | `16-expense.entity.ts:1148`    | `date` vs today (`expense/repo/lookup.ts:194-205`)                                                      | §3.4 `date` range with tokens (wire)                                     |
| 32  | location `recountOverdue`                     | `04-location.entity.ts:602`    | `lastBulkInventory` older than N days or never (`location/repo/crud.ts:720`)                            | §3.4 range with tokens + No value (wire)                                 |
| 33  | planting `activeOn`                           | `19-planting.entity.ts:539`    | interval `[start, finishedOn]` contains a day (`garden/repo/garden.ts:806`)                             | §3.4 `dateInterval` value                                                |
| 34  | inventory `valuationStatus`                   | `05-inventory.entity.ts:505`   | prepared valuations; `missing` overlaps `priceable` (`inventory/repo/crud.ts:251`)                      | §3.5 disjoint enum value (wire; Q2)                                      |
| 35  | product `quantityVarianceState`               | `00-product.entity.ts:2045`    | on-hand vs expected where comparable (`product/repo/crud.ts:547`)                                       | §3.5 enum value, NULL when not comparable (wire)                         |
| 36  | product `expectedQuantityRange`               | `00-product.entity.ts:2040`    | set-based kit walk (`crud.ts:529`)                                                                      | §3.5 range over `ledgerExpectedQuantity` with a set form                 |
| 37  | purchase `reconciliation`                     | `12-purchase.entity.ts:1184`   | verdict ORs; mismatch is the `paperwork_mismatch` gap (`purchase/repo/purchase.ts:573`)                 | §3.5 enum value, if the verdicts prove disjoint (§8)                     |
| 38  | product `effectiveOwner`                      | `00-product.entity.ts:2024`    | ids resolved in app code (`inventory/repo/ownership.ts:1173`)                                           | **stays**                                                                |
| 39  | inventory `effectiveOwner`                    | `05-inventory.entity.ts:518`   | ids resolved in app code (`ownership.ts:1096`)                                                          | **stays**                                                                |
| 40  | project `attention`                           | `09-project.entity.ts:833`     | `computeAttentionItems` (`project/repo/lookup.ts:96-99,141`)                                            | §3.1 repository row set `attentionItems`, prepared                       |
| 41  | project `completionYear`                      | `09-project.entity.ts:844`     | TS subtree date fold (`lookup.ts:102-109,152`)                                                          | §3.5 prepared `type: "text"` value                                       |
| 42  | project `dateRange`                           | `09-project.entity.ts:839`     | own interval OR dated tasks/expenses (`project/repo/dashboard-shared.ts:183`)                           | **stays** (revisit after §3.1, §3.2, §3.4)                               |
| 43  | gardenEntry `journalPlantingId`               | `20-gardenEntry.entity.ts:303` | journal links OR whole-area entries in the planting's window (`garden.ts:877`)                          | §3.1 repository row set `journalPlantings`                               |
| 44  | email `purchaseId`                            | `28-email.entity.ts:475`       | one scope record, evidence SQL (`email/repo/email.ts:218-233`)                                          | **stays**                                                                |
| 45  | email `vendorId`                              | `28-email.entity.ts:476`       | same                                                                                                    | **stays**                                                                |
| 46  | email `vendorAccountId`                       | `28-email.entity.ts:477`       | same                                                                                                    | **stays**                                                                |

The two repository-applied scopes go to §3.6.

## 3. Shapes

Each subsection gives the declaration, the compile path, and whether the
shape **extends** the approved `model.derived` shape (same keys and rules, new
accepted values) or is a **material change** (a new declaration or a changed
rule). §13 of the old plan stops a chain for a material change. Here the user
approves the plan before anything starts.

| Shape                    | Removes  | Classification                                                                                                                                                                                   |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3.1 Row sets, same row  | 20       | **Material.** New `model.rows` declaration, `via` may start at it, same-row compile semantics, and a term-expander registry.                                                                     |
| §3.2 Inherited values    | 8        | **Material.** New `resolution.inherit`, and inherited fields stop filtering on their stored column.                                                                                              |
| §3.3 Multi-field filters | 3        | Extension. A descriptor names existing list fields; `model.derived` is unchanged.                                                                                                                |
| §3.4 Dates               | 4        | Declaration: extension (tokens are values; `dateInterval` adds one `type`). Runtime: **material** (every range's No value ORs; a compound value filters, which `derivedValueSql` rejects today). |
| §3.5 Values after all    | 5        | Declaration: extension (existing `type`). Repository SQL contract: **material** (a value may supply `{ value, set }`, changing `DerivedSqlArg`).                                                 |
| §3.6 Declared scopes     | 2 scopes | Material to the filter contract (outside `model.derived`). Adds `list.scope` and nested scopes.                                                                                                  |

### 3.1 Row sets and same-row matching

`model.rows` names a to-many set of rows the list compiler can walk. A row set
is not an entity: it has no shortcode, manifest entry, or relation section
([Child storage](../entities.md#child-storage)). Four storages:

```ts
rows: {
  // FK path to a child or shared table, optionally narrowed to one kind of row.
  importTargets: { label: "Import targets",
                   path: [{ edge: "PhotoRunImage.imageId", direction: "incoming" }] },
  barcodes:      { label: "Barcodes",
                   path: [{ edge: "EntityExternalId.entityId", direction: "incoming" }],
                   where: { source: "gtin" } },
  // A JSONB array of records on the row; columns come from the field's item schema.
  aliases:       { label: "Source aliases", json: "sourceAliases" },
  // A relation the repository supplies as SQL, typed from this declaration.
  allocationShares: { label: "Allocation shares",
                      repository: { project: { reference: "project" },
                                    spendingCategory: { reference: "spendingCategory" },
                                    trade: "text", costType: "text" } },
  // An entity relation, named so its filters share one related row.
  subjectTasks:  { label: "Tasks", relation: "tasks" },
}
```

Then `via` may start at a row set: `<row>.<column>`, or `<row>.<edge>` to an
entity the row references (`importTargets.run`, `attributions.ledgerParty`).
The compiler emits the reference's id filter, shortcode resolution, and
**Include sub-…** toggle exactly as it does for a `via` that ends at an entity:

```ts
derived: {
  runId:       { via: "importTargets.run" },
  targetState: { via: "importTargets.state" },
}
```

**Compile path.** `compileVia` resolves a first segment that names a row set
and accepts one terminal after it. The terminal is a row column, a JSON item
key, a repository column, or an outgoing FK edge from the row table. Path and
relation row sets compile through `compileTraversal`. JSON row sets compile to
`jsonb_array_elements(<column>)`, reading `elem->>'key'`. Repository row sets
compile to `id IN (SELECT owner FROM <relation> WHERE …)`, uncorrelated as
`expenseDerivedMembershipSql` is today. A repository row set's SQL is passed
as `listScaffold(entity, table, { derived, rows })`. Its argument type is
generated, so a declared row set without SQL fails typecheck, as `derived`
does. A row set may use `listPrepare`, which loads only when a request
filters through it.

`where` narrowing is new compiler work. Today the traversal knows only an
edge's declared `scope` (`ENTITY_EDGES`), and the `EntityExternalId.entityId`
edge declares none (`apps/web/src/server/db/entity-edges.ts:274`). It joins on
`entityId` alone, which is safe because ids are UUIDs. A row set's `where`
adds column equalities on the row table (`source = 'gtin'`,
`kind = 'settlement_ref'`). Its columns are checked against the table at
generate time.

**Terminals of an entity row set** are the target's stored columns and
outgoing references. They are not its repository values, because
`DerivedSqlArg` supplies SQL only for the list's own entity
(`field-compiler.ts:214`). So product `taskOpen` is not
`subjectTasks.completion`. It becomes an **Open** preset (`expand`, as
quantity variance's options do today) on the `subjectTasks.status` filter,
picking every non-`done` status. Wire: `taskOpenOnly` goes away. Combining
the Open preset with Done now unions the statuses instead of matching
nothing (§8). `taskDue` keeps today's column, `Task.dueDate`. Product
`taskPresenceFilter` stays the related-view presence ("has any task",
`generic/entity-links/repo/related-view.ts:955`). It is not rebound to
due-date presence, so an undated task still counts as a task.

**Prepared repository row sets.** A repository row set may render from a
`listPrepare` (`VALUES` rows from data loaded in app code). Project
`attention` becomes `attentionItems(projectId, type)`, built from
`computeAttentionItems` by the same prepare
(`project/repo/lookup.ts:96-99`). The attention rules stay in their one deep
module. The filter gains generic Exclude and presence. gardenEntry
`journalPlantingId` becomes the SQL row set `journalPlantings(entryId,
plantingId)`: explicit journal links, plus whole-area entries at the
planting's location inside its window (`garden/repo/garden.ts:877`). The
planting relation's `derived` provenance keeps naming the
`journalPlantingId` descriptor.

**Term expanders.** A text descriptor may declare `terms: "<key>"`, naming an
entry in one typed server registry, `listTermExpanders` in
`server/generic/list/repo/terms.ts`. Its key union is generated from
declarations, so an unknown key fails typecheck. An expander maps the trimmed
input to the terms the filter ORs as contains-matches. `productCode` wraps
`wasm.product_code_search_terms` (`product/repo/gtin.ts:116`). It is the only
entry. This is a typed hook registry, as
[Generic by default](../entities.md#generic-by-default) allows. B owns it.

**Same row.** Every include condition whose `via` starts at the same row set
compiles into one `EXISTS` over one row, so "source is Plaid and external id
is `ACME-0042`" means one alias. Filters through an entity relation that is
not a declared row set keep today's independent `EXISTS` per filter. To match
independently, declare two row sets over the same storage. Sibling predicates
reading each other through a prepare are deleted.

### 3.2 Inherited values

The field's `resolution` gains `inherit`. It is the one declaration of the
fallback chain that `explanation.description` describes today in prose:

```ts
// task assigneeId: today's chain, reproduced exactly
// (task-project-inheritance.ts:104-131).
resolution: {
  reset: { assigneeMode: "inherit", assigneeId: null },
  none:  { assigneeMode: "explicit", assigneeId: null },
  inherit: {
    mode: { field: "assigneeMode", inherit: "inherit" },
    from: [{ path: "parentTask", read: "stored" },   // parent's own decision
           { path: "parentTask.project.assigneeId" }, // parent's project default
           { path: "project.assigneeId" }],          // own project default
  },
}
// task projectId / subjectProductId: one parent level, as today.
inherit: { mode: { field: "projectMode", inherit: "inherit", explicitIfSet: true },
           from: [{ path: "parentTask", read: "stored" }] }
// productCategory feature: no mode field, so NULL inherits.
resolution: { inherit: { from: ["hierarchy"] } }
// productCategory spendingCategoryId: "blocked" is an explicit None.
inherit: { mode: { field: "spendingCategoryMode", inherit: "inherit", none: ["blocked"] },
           from: ["hierarchy"] }
```

- `mode` absent means NULL inherits. With `mode`, the row's stored value wins
  unless the mode field holds the `inherit` value; a `none` value reads as
  NULL.
- `explicitIfSet` keeps today's task rule that a non-NULL stored value wins
  even in `inherit` mode (`task-project-inheritance.ts:140`).
- `from` is ordered, and the first source that **decides** ends the chain. A
  value decides, and so does an explicit None. A source with no decision
  falls through. `"hierarchy"` is the nearest ancestor along
  `model.hierarchy.parentField` whose own value decides. It is cycle-guarded
  and capped at `maxDepth`. `{ path, read: "stored" }` is the stored decision
  one reference away, with no recursion. `{ path }` is the **effective** value
  of the field at the end of a to-one path, resolved by its own declaration. A
  reference along the path that is itself inherited (task `projectId`) is read
  effective.
- A decides nothing new. Each field declares the chain its helper implements
  today, so A changes no results. Task fields keep one parent level while
  project and category walk the hierarchy. Normalizing task inheritance onto
  `"hierarchy"` is a separate decision (Q1). Its equivalence tests must cover
  a parent and child on different projects and a parent project whose default
  is an explicit None.
- A generator, `effectiveFieldSql(entity, field, alias)` in
  `server/generic/list/repo/inheritance.ts`, emits the value. Repository reads
  that compute `fieldResolutions` call it, so a read and a filter cannot
  disagree ([Field resolution](../entities.md#field-resolution-and-overrides)).
  It replaces the hand helpers listed in §2. Provenance (`sourceEntity`,
  `storedValue`, `fallbackValue`) stays repository-owned.

**Compile path.** A filter, sort, or group on an inherited field reads
`effectiveFieldSql`. A `via` step along an inherited reference (product →
`subjectTasks` through task `subjectProductId`) reads the effective reference.
This retires the rule "a stored field's filters stay on its column" for
inherited fields only, which is why this shape is material. An id filter whose
target declares `model.hierarchy` keeps its generated toggle. For filters,
the generator may emit the top-down set form (`categoryFeatureInSql` starts
from matching explicit nodes and walks inheriting descendants) instead of a
correlated per-row walk. §10 measures which.

`model.derived` entries that existed only to name an effective value
(`effectiveLocations`, `effectiveAssignee`, task `assigneeId: { type }`) are
deleted. Sorts by name use the field's `via` title.

### 3.3 Multi-field filters

A text descriptor declares `anyOf`: list fields it matches when any one does.
An entry is a model field (effective when inherited) or a `model.derived` key
(`via` or `type: "text"`). A to-many `via` compiles to `EXISTS`.

```ts
// wish
derived: {
  candidateName:         { via: "candidates.name" },
  candidateManufacturer: { via: "candidates.manufacturer" },
  candidateModel:        { via: "candidates.model" },
},
filters: { search: { kind: "text", anyOf: ["name", "notes", "candidateName",
                                            "candidateManufacturer", "candidateModel"] } }
// project: anyOf: ["name", "notes", "locations"]
// task:    anyOf: ["name", "subjectName"]  with subjectName: { via: "subject.name" }
```

`stored: { columns }` on a text descriptor folds into `anyOf` in the same PR
(ingredient, recipe, location). `stored: { columns }` on a non-text
descriptor keeps its meaning. This is a descriptor change, not a
`model.derived` change.

### 3.4 Dates: relative tokens and intervals

- **Tokens (#2415).** A date range bound accepts `@today`, `@today-Nd`, and
  `@today+Nd`, resolved to the household-local date at query time by the
  entity kernel, as `@me` is ([ADR 0018](../adr/0018-current-member-filter-token.md)).
  A token is a value, so URLs, saved views, MCP, and Apple carry it as a
  string. Task "overdue" is the declared `effectiveDueDate` value
  (`coalesce(dueEndDate, dueDate)`, `task/repo/helpers.ts:24`) `to: @today-1d`. Expense "before
  today" is `date` `to: @today-1d`. Location "recount overdue" is
  `lastBulkInventory` `to: @today-Nd` with No value, for any positive N.
  The 30, 60, and 90 day presets expand to those tokens. This changes elapsed
  time (`< now() - N days`, `location/repo/crud.ts:720`) to whole household
  days, because a timestamp range bounds by household day (`list.ts:824`).
  Records on the boundary day change membership (§8).
- **Clients.** Apple's date-range editor parses each bound as a `PlainDate`
  and writes back an absolute date
  (`apps/apple/App/Shared/Entity/List/EntityFilterSheet.swift:685`), so a
  saved token would display wrong and turn into a fixed date when edited. D
  makes the web and Apple editors token-aware: they show "today − 30 days",
  keep the token on edit, and offer a relative or absolute bound. Native
  validation and wire tests for token strings ship in D.
- **No value with a range.** Today a range ANDs its presence with its bounds
  (`declaredFilterPredicates`, `server/generic/list/repo/list.ts:800-830`), so
  bounds plus No value always match nothing. D changes this for **every**
  range: No value ORs with the bounds, as any-of values do. Any value with
  bounds stays the bounds alone, because a bound already implies a value.
  `recountOverdue` needs this ("older than N days, or never"). It is a
  generic behavior change, named in §8.
- **Intervals.** `type: "dateInterval"` is a compound value
  `[start, end]` whose repository SQL returns two date parts, with NULL `end`
  meaning open. A range filter over it matches overlap. A descriptor that
  binds one date (`wire: { kind: "param" }`) matches containment. It sorts by
  start, then end, and cannot group. Planting `activeSpan` replaces
  `activeOn`. The URL key `activeOn` stays through `wire`.

As a declaration this extends `type` (one option) and #2415's value contract,
and adds no `model.derived` key. At runtime it is material: a compound value
filters, which `derivedValueSql` rejects today (`field-compiler.ts:280`), and
every range's No value composition changes.

### 3.5 Values after all

Five predicates are one row value, or can be made one:

- **inventory `valuationStatus`** becomes a prepared `type: "enum"` value with
  disjoint options `valued`, `priceable`, `unpriceable`. Today's `missing` is
  `priceable` plus `unpriceable` (Q2).
- **product `quantityVarianceState`** becomes a `listReadValue`
  `type: "enum"` (`matched`, `mismatched`) that is NULL when stock or
  comparable ledger history is missing. The read context still flows.
- **purchase `reconciliation`** becomes a `type: "enum"` CASE in verdict
  order: `unknown`, `match`, `refund_adjusted`, then `mismatch` through the
  same `gapCondition("purchase", "paperwork_mismatch")`. A purchase whose gap
  has a recorded `expected_mismatch` exception has no state (No value). §8
  gates this on proven disjointness.
- **product `expectedQuantityRange`** is the range filter of the existing
  `ledgerExpectedQuantity` value (`product/repo/crud.ts:418`,
  `expectedQuantitySql`). The filter reads `expectedQuantityReadSql`, a
  different helper under the same documented contract
  ([Filters and search](../entities.md#filters-and-search)), so E's
  equivalence test must prove the two agree before the predicate goes. The repository argument for a value may be
  `{ value, set }`: `set` is a relation `(id, value)` that filters read as
  `id IN (SELECT id FROM set WHERE …)`, so the shared kit walk stays one
  query. Sort and projection keep the scalar. This changes the repository SQL
  contract: `DerivedSqlArg` gains the `{ value, set }` form, and E owns its
  generated types.
- **project `completionYear`** becomes a prepared `type: "text"` value: one
  year per project from the existing TS fold
  (`project/repo/subtree.ts:350`, `loadProjectDateWindows`), rendered as an
  id-to-year map the way inventory valuations render today. Its prepare is
  `projectCompletion`, which the list already shares with its rollups.

Each value gains sort and Exclude, because values negate generically. The
enum and text values (`valuationStatus`, `quantityVarianceState`,
`reconciliation`, `completionYear`) also gain Group by.
`ledgerExpectedQuantity` is a number. Group by does not support numbers
(`list-fields.ts:530`), so it stays a disabled choice with its derived reason.

### 3.6 Declared scopes

- **Static scope.** `presentation.list.scope` names stored columns pinned to
  NULL. That is the shape ingredient's `resolve.scope: ["recipeId"]` already
  declares (`definition.ts:1607-1615`, `02-ingredient.entity.ts:639`), reused
  rather than a filter record, because ingredient has no `recipeId` list
  filter. `scaffold.where` ANDs it into every list and count read
  (`getEntityCounts` reads the same `where`). It shows no chip,
  and a request cannot remove it. `buildIngredientListWhere` is deleted.
- **Related scope.** A scope key whose value is another entity's list filter
  record, matched through a declared path:

  ```ts
  // task
  scopes: { projectScope: { via: "project", filters: "project" } }
  // expense
  scopes: { projectScope: { via: "allocationShares.project", filters: "project" } }
  ```

  It compiles as `EXISTS` over the path to a target row satisfying the
  target's `where`. The compiler cannot find another domain's derived SQL
  itself, and the old plan rejected a registry. So the repository passes the
  target scaffold as an argument, typed from the declaration:
  `listScaffold("task", task, { scopes: { projectScope: projectScaffold } })`.
  Task already imports from the project domain
  (`matchingEmbeddedProjectIds`). `scaffold.context(db, request)` builds the
  nested scaffold's context when the scope key is present, so the project
  predicates that stay (`completionYear`) load once, and `where` stays
  synchronous. `embeddedProjectScopeSchema` is replaced by the project list
  filter schema, keyed `status`, `kind`, `locations` (effective, §3.2),
  `search`, `dateRange`, and `completionYear`. The mapping is not identical.
  The dashboard's `search` matches the name only
  (`dashboard-shared.ts`, `buildSearchConditions` over `project.name`), while
  the list's matches name, notes, and effective locations. §8 names this.
  Apple sends `projectScope` (`CubbyKit/API/CubbyClient.swift`), so this is a
  native wire change. `matchingEmbeddedProjectIds`'s list callers and the
  `projectScope` branch of `buildExpenseWhereClause` are deleted. B deletes
  `allocationLead`.
  `buildDashboardProjectWhere` keeps only its dashboard callers, and §11
  covers them. A scope is not a filter descriptor: no chip, no Exclude, no
  any-of.

### 3.7 Stays

**Rule.** A predicate stays only when the filter value itself defines
membership, so no value or row set exists apart from the request, or when the
replacement needs a contract that only that filter would use. Computing
outside SQL does not, by itself, qualify. Prepared values and prepared row
sets carry app-computed data (§3.1, §3.5).

| Key                                               | Reason it keeps a predicate                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| product, inventory `effectiveOwner`               | The filter's value space mixes Ledger Party references with owner states (`@household`, `@unknown` sentinels), and a JS resolver produces them over every live entry (`inventory/repo/ownership.ts:1090-1105,1173`). A row set would need a column type that holds a reference or a state, and only these two filters would use it. The predicate receives the resolved id set. |
| project `dateRange`                               | Interval overlap of the project's own dates, OR a dated task through its effective project, OR an expense through computed allocation shares. It is a deliberate non-recursive approximation (`dashboard-shared.ts:170-181`). After A, B, and D it could be `anyOf` over a `dateInterval` and two row-set paths. Revisit then (§11).                                            |
| email `purchaseId`, `vendorId`, `vendorAccountId` | The filter value defines membership. Each resolves one scope record (`singleValue`) whose evidence SQL decides which Emails belong and anchors `linkState` (`email/repo/email.ts:218-233`). Each is also the filter that a `derived`-provenance relation names (purchase, vendor, vendorAccount; `entity-integrity.ts:117`).                                                    |

## 4. Cardinality, sort, group, exclude, presence, match all

- **Sort and group.** A row-set `via` is to-many. It sorts and groups only
  through a declared value, and otherwise is rejected with the derived reason
  `Goes through a list of Source aliases. Only paths that lead to a single
  record can group.` (`label` supplies the noun). Inherited fields sort and
  group by the effective value. A to-one path through an inherited reference
  is still to-one. `anyOf` descriptors and scopes do not sort or group.
  `dateInterval` sorts but does not group.
- **Exclude.** A row-set field's Exclude is
  `NOT EXISTS (row whose value is excluded)`, independent of the same-row
  group. That is the existing to-many rule ("no related row has an excluded
  value"). The §3.1 filters therefore become negatable, and their
  `Include only` reasons go away. Inherited values negate their effective
  value (`NOT COALESCE((…), false)`). §3.5 values negate as values. Stays keep
  their current `negatable`.
- **Presence.** On a row-set field, Any value joins the shared row like a
  picked value (`col IS NOT NULL`). No value matches a record when a row in
  the shared `EXISTS` has the column NULL (with the sibling conditions), **or**
  when the record has no row at all. The first half keeps today's
  allocation-share semantics: an expense with one assigned and one unassigned
  share matches No project
  (`expense/repo/expense-project-allocation.ts:284-293`). The second half keeps
  "has no identifier" for a NOT NULL column (product `externalIdSource`).
  Equivalence fixtures include mixed-share expenses. Inherited fields read
  presence on the effective value (see Q3 for product `categoryFeature`).
- **Match all.** On a row-set field, each picked value gets its own `EXISTS`,
  and each carries the sibling include conditions, so "external ids `ACME-1` and
  `ACME-2` on Plaid aliases" means two Plaid aliases. Single-valued inherited fields never
  offer Match all.
- **Hierarchy.** A row-set terminal reference to a hierarchical entity
  (`importTargets.run`, `allocationShares.project`,
  `allocationShares.spendingCategory`) gets the generated **Include sub-…**
  toggle. That replaces the hand-built descendant expansion
  (`image.ts:1286`, `expense/repo/lookup.ts:84-125`).

## 5. Unsupported choices

As in the old plan's §7: a choice stays visible, disabled, with a one-line
reason derived from the declaration. HTTP and MCP reject it with the same text,
unmasked. New reasons, derived and not hand-written:

- Row set, sort or group: "Goes through a list of ‹row label›. Only paths that
  lead to a single record can ‹verb›."
- `anyOf` descriptor in Group by: "Matches any of several fields, so it has no
  single value to group by."
- `dateInterval` in Group by: "‹Field› is a date span, so a record has no
  single date to group under."
- Scope keys never appear in filter, sort, or group menus.
- Stays keep `Filter only: ‹reason›` and, unless `negatable`,
  `Include only: ‹reason›`.

## 6. Generated surface

`generatedEntityListFields` gains `rows` (key, label, storage, columns) and,
for each field, `inherit` metadata. Web, Apple, and MCP read filter
descriptors from the manifest, so §3.1–§3.3 need no hand-written client code.
Generated descriptors do change: newly negatable filters gain an Exclude
key, and `last4` and `submissionId` change kind from `text` to `multiselect`,
which Apple's filter sheet renders differently. URL keys
stay the same (`columnId` is unchanged). §3.4–§3.6 change keys or values
(§8). `@cubby/schemas/entity-list-fields` remains the one source the server
compiler and clients read.

## 7. Interactions with existing work

- #2415 is the §3.4 sub-issue, extended with intervals and the range No value
  rule.
- #2433 (`problemFilterSemantics`) is unaffected. Problems that name a changed
  key (`dueRelative`, `valuationStatus`, `quantityVarianceState`) update in the
  same PR.
- `mappedExpenseProjectAt` (`traversal.ts:191`) is an expense-only effective
  edge. §3.2's effective edges do not cover it, because the expense project is
  an allocation, not an inheritance. It stays (§11).

## 8. Migration rules

- Write the failure modes and an equivalence test first. For each removed
  predicate, an integration test runs the old predicate and the new compiled
  filter over the same synthetic fixture and compares row ids. Then delete
  the old predicate in the same PR.
- **Shrink-only baseline.** The first PR to merge adds a generator check: a
  `model.derived` `predicate` must appear in
  `apps/web/generator/entities/predicate-baseline.json` (entity, key). PRs
  only remove entries. The final state is the stays in §3.7 (6), plus
  `reconciliation` if its gate below fails (7). The baseline stays
  as the guard ([Finish migrations](../entities.md#generic-by-default)).
- Each PR deletes the hand-written SQL it replaces and lists the deletions in
  its done report (helpers in `task-project-inheritance.ts`,
  `categoryFeatureInSql`, sibling prepares, `allocationLead` (B),
  `buildIngredientListWhere`, `matchingEmbeddedProjectIds` list callers).
- **Behavior changes** are named in the PR and in the equivalence test's
  expected diff, never silent: task inheritance normalization, only if Q1
  approves it (A otherwise reproduces today's chains), product
  `categoryFeature` No value (Q3), recount age measured in whole household
  days instead of elapsed time (D), the product Open preset unioning with a
  picked Done status (B), expense trade presence (today it reads
  `Expense.trade`; after, it reads share trade, so the equivalence test
  decides), `last4` and `submissionId` becoming exact any-of over free values,
  every range's No value ORing with its bounds (D, §3.4), the embedded
  project scope's `search` widening from name to name, notes, and effective
  locations (F), and `reconciliation` gated on disjointness (if the CASE and the OR disagree
  on the fixture, `reconciliation` stays and the PR records why in its
  `reason`).
- **Wire changes** follow [breaking changes](../agents/domain-rules.md#breaking-changes).
  Saved views and Problems are declared in code, so there is no stored-data
  migration. Update the declared saved views, Problems, web, Apple
  (`EntityFilterTests.swift`), and MCP in the same PR. As in the old plan's
  §10, the last PR of the chain to merge bumps
  `APPLE_CLIENT_COMPATIBILITY_VERSION` once. Earlier PRs do not.
- `docs/entities.md` is updated in each PR: Filters and search (row sets, same
  row, `anyOf`, tokens, scopes, retiring "is ANDed with `where` by the
  repository"), Field resolution (`inherit`), and Child storage (row sets).

## 9. Work breakdown

```text
#A inherited values ──┬─> #B row sets (product subjectTasks last) ──> #F scopes
                      ├─> #C multi-field filters
#D dates (#2415) ─────┘   (independent)
#E values after all       (independent)
```

| Issue | Scope                                                                                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | §3.2: `resolution.inherit` reproducing today's chains, `effectiveFieldSql`, effective `via` edges; rows 19–26; reads move to the generator; predicate baseline (if first to merge).                       |
| B     | §3.1: `model.rows` (path, JSON, repository incl. prepared, relation), `via` from a row set, same-row compile, row-set Exclude/presence/Match all, `listTermExpanders`; rows 1–18, 40, 43 (16–18 after A). |
| C     | §3.3: `anyOf`; rows 27–29; fold text `stored.columns`.                                                                                                                                                    |
| D     | #2415 plus §3.4: tokens, token-aware web and Apple range editors, range No value OR, `dateInterval`; rows 30–33.                                                                                          |
| E     | §3.5: rows 34–37 and 41, value `set` form and its `DerivedSqlArg` types.                                                                                                                                  |
| F     | §3.6: `list.scope`, related scopes; ingredient scope and `projectScope` (after A and B).                                                                                                                  |

## 10. Risks

- **Correlated inheritance per row.** A per-row recursive walk in `WHERE`
  costs more than today's top-down set (`categoryFeatureInSql`). Check query
  plans on the largest synthetic product, inventory, and task lists before A
  merges. Emit the set form for the `hierarchy` step if the walk is slower.
- **Allocation shares keep their bound.** Today membership is computed only
  over expenses the other row filters select (`expense/repo/lookup.ts:228-249`),
  and `expense-scope-plan.integration.test.ts:138` already checks that
  bounded work. That test is an acceptance requirement for B, not a
  measurement. The `allocationShares` row set reads the request's other
  filters through its `listPrepare` and bounds its share relation the same
  way.
- **Same-row surprises.** A user who filters account `source` and
  `externalAccountId` expecting independent matches gets one alias. That is
  already today's behavior for these pairs. The rule now applies to every
  row-set pair, so each row set is reviewed when it is declared.
- **Read/filter drift during A.** Until every `fieldResolutions` read calls
  `effectiveFieldSql`, a read and a filter can disagree. A moves all callers
  in one PR, including calendar's `effectiveTaskProjectSql` calls
  (`calendar/repo/calendar.ts:182,608`).
- **Nested scope cost.** A related scope runs the project `where` (and its
  prepares) inside a task or expense list. Test that a list without a scope
  never loads project prepares.
- **Installed native app.** Same as the old plan's §10: wire breaks between
  PRs are accepted, with one compatibility bump at the end.

## 11. Non-goals and deferred work

- Project `dateRange` as `anyOf` over an interval and row-set paths: revisit
  after A, B, and D, as its own issue if wanted.
- The project dashboard's own filter builder (`buildDashboardProjectWhere` for
  dashboard callers). Its list-scope callers move in F.
- `mappedExpenseProjectAt` and the expense effective-project relation.
- Repository read provenance (`fieldResolutions.sourceEntity` and friends)
  staying repository-owned. A generates only the value.
- Boolean filter trees, cross-filter OR, typed search syntax (unchanged
  non-goals from #2407).

## 12. Validation

Each issue lists its checks: equivalence integration tests per removed
predicate, generator unit tests for each new declaration error (unknown row
column, `via` past a row terminal, `inherit` on a field without a hierarchy),
and `pnpm --dir apps/web typecheck`. Plan-level acceptance belongs to the last
issue to merge. `rg -n 'predicate: "' packages/schemas/src/entity-definitions`
returns exactly the keys in §3.7 (plus `reconciliation` if its gate failed,
with the reason recorded), and the baseline file matches. No repository ANDs
one of the two migrated scopes, or any removed predicate, next to
`scaffold.where`. Invariants that are not filters stay. For example, inventory's
`liveProductAndLocation()` keeps rows, counts, and valuation totals off
deleted references (`inventory/repo/crud.ts:303`), and no lane removes it.

## 13. Execution

After approval, an orchestrating session runs §9: one T3 thread and `nicky/`
worktree per issue, at most two implementation threads at once ([model
routing](../agents/model-routing.md)). D and E can start alongside A. Each PR
gets its independent review and merges once final-head CI passes with no
unresolved findings. A finding that would change a §3 shape stops the chain
for the user. Work that cannot finish returns as a blocked issue with the
reason.

| Lane | Implementer (default lane)                  | Reviewer (one per PR)                                       | Owned files                                                                                                                                                                                                                                         | Depends on          | Validation owner                         |
| ---- | ------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------- |
| A    | opus / medium; `gpt-6.1-sol` / low on Codex | `gpt-6.1-sol` / high (Opus impl) or fable / high (Sol impl) | `definition.ts` `resolution`, `generator/entities/list-fields.ts`, new `generic/list/repo/inheritance.ts`, `task-project-inheritance.ts`, product-category and task/project/inventory/product repos, calendar callers                               | none                | A's thread: equivalence tests, typecheck |
| B    | same                                        | same                                                        | `definition.ts` `model.rows`, `list-fields.ts` `compileVia`, `field-compiler.ts`, `traversal.ts`, new `generic/list/repo/terms.ts`, financial-account/-transaction, image, image-job, expense, product, project (attention), garden (journal) repos | A (rows 16–18 only) | B's thread                               |
| C    | same                                        | same                                                        | filter descriptor schema (`anyOf`), project/task/wish/ingredient/recipe/location declarations and repos                                                                                                                                             | A                   | C's thread                               |
| D    | same                                        | same                                                        | #2415 token resolver (entity kernel), `list.ts` range composition, `dateInterval` in `field-compiler.ts`, web range editor, Apple `EntityFilterSheet.swift` date editor, task/expense/location/planting declarations and repos, Problems            | none                | D's thread                               |
| E    | same                                        | same                                                        | inventory/product/purchase/project (completion year) declarations and repos, `field-compiler.ts` value `set` form and `DerivedSqlArg`, Problems naming changed keys                                                                                 | none                | E's thread                               |
| F    | same                                        | same                                                        | `list.scope`/`scopes` declarations, `listScaffold` `scopes` argument, ingredient/task/expense/project repos, `project.ts` scope schema, Apple `CubbyClient.swift`                                                                                   | A, B                | F's thread                               |

Shared-file handoffs: `definition.ts`, `list-fields.ts`, and `field-compiler.ts`
are edited by several lanes. Lanes that run concurrently (A with D or E) touch
disjoint regions. The later lane rebases onto the merged one before review.
The orchestrator owns the plan-level acceptance in §12 and the single
`APPLE_CLIENT_COMPATIBILITY_VERSION` bump.

## 14. Open questions

1. **Normalize task inheritance?** A reproduces today's task chains exactly.
   Project and subject product read one parent level. Assignee reads the
   parent's own decision, then the **parent's** project default, then the
   task's own project default. Normalizing onto `"hierarchy"` (nearest
   deciding ancestor, then own project) would change results in two cases.
   First, a parent on project A with a child explicitly on project B: today
   the child inherits A's default, normalized it would inherit B's. Second, a
   parent whose project default is an explicit None: today that None blocks
   the child's own project fallback. Recommended: keep today's chains in A,
   and decide normalization separately.
2. **Valuation status options.** `missing` becomes two disjoint states,
   Priceable and Unpriceable, that a filter picks together. Recommended. The
   alternative is No value on `valuation` plus a separate `priceable` boolean.
3. **Category feature No value.** Today "No value" means "no category"
   (`presenceCondition(product.categoryId)`). Generically it means "no
   effective feature". Recommended: accept, so the filter reads its own field.
4. **Same row by default.** All include filters through one row set share a
   row, and independence needs a second row-set declaration. Recommended. The
   alternative is an explicit `sameRow` flag per row set.
5. **Related scopes (§3.6).** Replace `projectScope` with a nested project
   filter record (recommended), or keep it repository-applied as a declared
   exception with a reason.
6. **Prepared row sets for app-computed filters.** Project `attention` and
   gardenEntry `journalPlantingId` move to repository row sets (§3.1), and
   `completionYear` to a prepared value (§3.5). That gains Exclude, presence,
   and, for completion year, sort and group, but the rows are still
   repository-supplied. Recommended: move them. The alternative is to keep
   them as declared predicates (9 stays).
