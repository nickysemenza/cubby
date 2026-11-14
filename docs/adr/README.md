# Architecture decision records

Each ADR records one durable decision and its reasoning, and stays after the
decision ships. Once a superseded ADR's successor or owning doc carries
everything still in force, shrink it to a stub: title, status naming its
successor, acceptance date, a one-paragraph decision and a pointer to git
history for the full text. Name a new ADR `NNNN-kebab-title.md` with the next unused
number, head it `# ADR NNNN: Title`, and add a `Status:` line plus a row here.
Supersede an accepted decision with a new ADR rather than rewriting it; edit
live contract details in place.

| ADR                                                           | Decision                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [0001](0001-entity-relationship-authority.md)                 | Entity relationship authority                                                     |
| [0002](0002-meal-recipe-preparations.md)                      | Use Meal Recipe occurrences as preparations                                       |
| [0003](0003-meal-nutrition-entries.md)                        | Derive meal intake status from its date                                           |
| [0004](0004-plant-cultivar-grain.md)                          | Plant as the cultivar grain between Ingredient and Planting                       |
| [0005](0005-image-capture-provenance-from-sightings.md)       | Image capture provenance derived from sightings, not stored per device            |
| [0006](0006-durable-entity-identity-and-attachments.md)       | Durable entity identity and one attachment table                                  |
| [0007](0007-generic-entity-links-and-external-ids.md)         | One entity link table and one external identifier table                           |
| [0008](0008-usda-release-durable-object.md)                   | Serve each USDA release from a SQLite Durable Object                              |
| [0009](0009-content-hash-merge-gate.md)                       | Gate merges on content-hashed check results                                       |
| [0010](0010-mail-import-unattended-burn-down-interactive.md)  | Unattended Mail import, interactive Burn-down                                     |
| [0011](0011-email-as-a-first-class-entity.md)                 | Email as a first-class entity                                                     |
| [0012](0012-import-convergence-through-burn-down.md)          | Import convergence through Burn-down                                              |
| [0013](0013-stock-tracking-inherits-from-product-category.md) | Stock tracking inherits from Product Category                                     |
| [0014](0014-path-routed-ci-lanes.md)                          | Start only the CI lanes whose inputs changed (superseded by 0020)                 |
| [0015](0015-unified-durable-work-coordination.md)             | Shared durable execution for member-requested AI work (superseded by 0025)        |
| [0016](0016-shared-assessments-and-feedback.md)               | Shared Assessments and Feedback (superseded by 0025)                              |
| [0017](0017-subscription-funded-model-fallback.md)            | Subscription-funded model fallback (superseded by 0027)                           |
| [0018](0018-current-member-filter-token.md)                   | `@me` is a declared value of Ledger Party filters                                 |
| [0019](0019-domain-first-server-layout.md)                    | Domain-first server layout                                                        |
| [0020](0020-cache-routed-ci.md)                               | Start every Linux lane and let the cache route                                    |
| [0021](0021-derived-values.md)                                | Derived values: one declaration, one cache, one drain (engine superseded by 0025) |
| [0022](0022-named-groupings-are-saved-views.md)               | Named groupings use saved views and Locations                                     |
| [0023](0023-lists-are-declared-over-a-relation.md)            | Lists are declared over a relation                                                |
| [0024](0024-repository-read-declaration.md)                   | Every entity reads through one declared scaffold port                             |
| [0025](0025-radical-simplification-of-background-work.md)     | Shrink Cubby's machinery in place on Workers and Neon                             |
| [0026](0026-source-occurrence-and-accepted-evidence.md)       | Source occurrence owns accepted bank evidence                                     |
| [0027](0027-tier-routed-models-on-a-funding-first-ladder.md)  | Tier-routed models on a funding-first ladder                                      |
| [0028](0028-cubby-acts-first.md)                              | Cubby acts first; members correct                                                 |
| [0029](0029-evidence-facts-and-reconcilers.md)                | Records are reconciled from evidence, answers and decisions                       |
