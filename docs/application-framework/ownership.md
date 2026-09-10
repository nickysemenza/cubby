# Framework ownership reconciliation

Working-tree audit against baseline a65b1f68f982876a98de33470df1ea9f31f40aaf.

The literal parser reports the following field policies. Counts describe declared
mechanical ownership; domain-specific validators, repository transactions, image
storage, quantity reconciliation, and relationship renderers retain explicit ports.
Zero create/update fields preserve a workflow-only or read-only contract.

| Entity declaration | Fields | Stored columns | Create fields | Update fields | Bulk fields |
| --- | ---: | ---: | ---: | ---: | ---: |
| [product](../../scripts/entity-literals/entities/00-product.entity.ts) | 30 | 19 | 18 | 20 | 1 |
| [recipe](../../scripts/entity-literals/entities/01-recipe.entity.ts) | 24 | 18 | 8 | 10 | 0 |
| [ingredient](../../scripts/entity-literals/entities/02-ingredient.entity.ts) | 10 | 10 | 4 | 4 | 1 |
| [cookbook](../../scripts/entity-literals/entities/03-cookbook.entity.ts) | 17 | 13 | 0 | 0 | 0 |
| [location](../../scripts/entity-literals/entities/04-location.entity.ts) | 19 | 14 | 7 | 9 | 1 |
| [inventory](../../scripts/entity-literals/entities/05-inventory.entity.ts) | 11 | 11 | 4 | 4 | 0 |
| [meal](../../scripts/entity-literals/entities/06-meal.entity.ts) | 12 | 10 | 6 | 5 | 0 |
| [ledgerParty](../../scripts/entity-literals/entities/07-ledgerParty.entity.ts) | 8 | 8 | 3 | 3 | 0 |
| [ledgerTransfer](../../scripts/entity-literals/entities/08-ledgerTransfer.entity.ts) | 15 | 10 | 7 | 7 | 0 |
| [project](../../scripts/entity-literals/entities/09-project.entity.ts) | 24 | 18 | 12 | 13 | 0 |
| [task](../../scripts/entity-literals/entities/10-task.entity.ts) | 22 | 15 | 9 | 10 | 5 |
| [vendor](../../scripts/entity-literals/entities/11-vendor.entity.ts) | 14 | 10 | 4 | 4 | 0 |
| [purchase](../../scripts/entity-literals/entities/12-purchase.entity.ts) | 26 | 12 | 7 | 9 | 0 |
| [financialAccount](../../scripts/entity-literals/entities/13-financialAccount.entity.ts) | 13 | 11 | 6 | 6 | 0 |
| [financialTransaction](../../scripts/entity-literals/entities/14-financialTransaction.entity.ts) | 21 | 17 | 13 | 13 | 0 |
| [wish](../../scripts/entity-literals/entities/15-wish.entity.ts) | 11 | 8 | 3 | 4 | 0 |
| [expense](../../scripts/entity-literals/entities/16-expense.entity.ts) | 32 | 20 | 19 | 19 | 3 |
| [usda-food](../../scripts/entity-literals/entities/17-usda-food.entity.ts) | 8 | 0 | 0 | 0 | 0 |
| [image](../../scripts/entity-literals/entities/18-image.entity.ts) | 21 | 20 | 0 | 1 | 0 |

The generated operation registry retains all **249** baseline operation IDs and
their query/mutation/subscription kinds. All have generated handler entries.
All **111** baseline route files still exist. Route modules continue to own
loaders and authored sections; generated navigation and entity routes own the
shared destinations and shells.

Field presentation now uses declared form sections, list membership, and detail
membership/order/sections. Specialized renderers preserve domain controls and
computed facts. No production editor passes a local primitive-field include list,
and no application detail page retains a manual BasicInfo field roster.

Scalar patching covers Ingredient marking, ordinary Vendor scalar updates,
Product stock-tracking decisions, Task status, and Expense trade/cost type.
Task/Expense bulk writes retain complete-ID and
cross-field validation; their audit rosters derive from declarations. Other
repository transactions retain their alias, tree, relationship, import, or domain
invariants and consume declared audit/validation policy.

The baseline workflow export census is recorded separately in
[workflow-status.json](./workflow-status.json). Deeper background-job ownership
now includes named payload graphs, ordered draining with one batch-kind lookup
per batch, and explicit start/continue/advance commit/effect definitions. Delivery
has its own durable-row retry boundary; generic workflow recovery still rejects
new or ambiguous writes. Cookbook comparison and Notion preview expose their
lookup/availability branches and page processing. Relatedness and tag propagation
expose source and evidence reads, candidate keys, and readiness decisions;
placement exposes eligibility and unique-destination selection. Provider clients,
repository transactions, and pure scoring remain explicit domain ports.

Validation and delivery requirements are in
[README.md](./README.md#validation-and-delivery). This audit is evidence of ownership
coverage, not an exact-final-commit verification record.
