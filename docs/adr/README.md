# Architecture decision records

Each ADR records one durable decision and its reasoning, and stays after the
decision ships. Name a new ADR `NNNN-kebab-title.md` with the next unused
number, head it `# ADR NNNN: Title`, and add a `Status:` line plus a row here.
Amend or supersede an accepted ADR in a new section or a new ADR rather than
rewriting its decision.

| ADR                                                           | Decision                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [0001](0001-entity-relationship-authority.md)                 | Entity relationship authority                                          |
| [0002](0002-meal-recipe-preparations.md)                      | Use Meal Recipe occurrences as preparations                            |
| [0003](0003-meal-nutrition-entries.md)                        | Derive meal intake status from its date                                |
| [0004](0004-plant-cultivar-grain.md)                          | Plant as the cultivar grain between Ingredient and Planting            |
| [0005](0005-image-capture-provenance-from-sightings.md)       | Image capture provenance derived from sightings, not stored per device |
| [0006](0006-durable-entity-identity-and-attachments.md)       | Durable entity identity and one attachment table                       |
| [0007](0007-generic-entity-links-and-external-ids.md)         | One entity link table and one external identifier table                |
| [0008](0008-usda-release-durable-object.md)                   | Serve each USDA release from a SQLite Durable Object                   |
| [0009](0009-content-hash-merge-gate.md)                       | Gate merges on content-hashed check results                            |
| [0010](0010-mail-import-unattended-burn-down-interactive.md)  | Unattended Mail import, interactive Burn-down                          |
| [0011](0011-email-as-a-first-class-entity.md)                 | Email as a first-class entity                                          |
| [0012](0012-import-convergence-through-burn-down.md)          | Import convergence through Burn-down                                   |
| [0013](0013-stock-tracking-inherits-from-product-category.md) | Stock tracking inherits from Product Category                          |
| [0014](0014-path-routed-ci-lanes.md)                          | Start only the CI lanes whose inputs changed                           |
| [0015](0015-unified-durable-work-coordination.md)             | Shared durable execution for member-requested AI work                  |
| [0016](0016-shared-assessments-and-feedback.md)               | Shared Assessments and Feedback                                        |
| [0017](0017-subscription-funded-model-fallback.md)            | Subscription-funded model fallback                                     |
| [0018](0018-current-member-filter-token.md)                   | `@me` is a declared value of Ledger Party filters                      |
| [0019](0019-domain-first-server-layout.md)                    | Domain-first server layout                                             |
