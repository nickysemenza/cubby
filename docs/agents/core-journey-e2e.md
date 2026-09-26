# Local input-first journey checks

These checks run against disposable local databases and synthetic evidence. Start
at the same boundary a person uses: a photo file, CSV row, browser page, or app
control. Seed only prerequisites that the journey cannot create itself, such as
the signed-in member, a configured account, or an existing item being matched.
Assert the final linked records after the review action, not just an upload or
an agent message. Keep raw household exports, real entity codes, and production
screenshots out of fixtures and test reports.

## Product identity and settlement

| Journey in [product identity](../product-identity-journey.md) | Local check and actual input                                                                                                                                                                                                                                                                                         | Seeded prerequisites                                                      | Current boundary                                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct photo, no run; manual Product                          | [`product-photo-first.spec.ts`](../../apps/web/tests/e2e/product-photo-first.spec.ts) opens the Product create dialog and uploads synthetic item and label PNGs                                                                                                                                                      | Signed-in test member                                                     | Web creation and persisted image roles; native direct attachment still needs a simulator journey                                                       |
| Photo inventory run                                           | `pnpm test:e2e:headless:wardrobe` uploads synthetic PNG bytes through native APIs, adopts synthetic descriptions, submits scripted groups through the `propose_photo_groups` MCP tool (no agent run), and approves in Chromium                                                                                       | Signed-in member, isolated database, local object storage                 | Tests the non-AI pipeline and review; grouping quality is `pnpm --dir apps/web eval:flue-models`, and physical iPhone interaction is a separate check  |
| Retailer order and Product match                              | The wardrobe run opens saved synthetic order-history, order, and Product HTML in Chromium, classifies the history with the production order-list parser, derives the prepared order from page evidence, then reviews the Product merge in Cubby                                                                      | Synthetic vendor account and candidate Product from the photo path        | The deterministic semantic-markup reader stands in for Flue's extraction; browser capture handoff and the purchase approval UI still need a joined run |
| Gmail order event                                             | [Purchase agent workerd integration](../../apps/web/src/server/purchase-import/purchase-agent-workerd.integration.test.ts) exercises durable browser handoff; [Gmail tests](../../apps/web/src/server/purchase-import/gmail/gmail.unit.test.ts) cover mail interpretation                                            | Synthetic mail/API response                                               | No local click-through from Google connect through mailbox discovery and itemized order approval yet                                                   |
| Monarch statement transaction                                 | `pnpm test:e2e:headless:wardrobe` uploads [`synthetic-monarch-wardrobe.csv`](../../apps/web/tests/e2e/fixtures/synthetic-monarch-wardrobe.csv) at `/statement-rows/import`, explicitly classifies the purchase charge, holds a card-payment row, repeats the upload, and confirms the late charge in the Purchase UI | Synthetic financial account because CSV cannot establish account identity | Native CSV review still needs a simulator journey; split payments and refunds need a review worklist                                                   |
| Native statement review contract                              | [`statement-row.integration.test.ts`](../../apps/web/src/server/repo/statement-row.integration.test.ts) previews, maps, pages, commits, and replays synthetic CSV through the native HTTP contract                                                                                                                   | Signed-in test member and synthetic rows                                  | The server contract is covered; native file selection and review need a simulator journey                                                              |
| Full-size and unfamiliar statement CSV                        | [`statement-import.spec.ts`](../../apps/web/tests/e2e/statement-import.spec.ts) uploads a synthetic 501-row export in Chromium, confirms bounded source-row saves and replay, then maps unfamiliar columns and amount direction before saving another export                                                         | Signed-in test member; no seeded financial account                        | Browser source evidence and manual mapping; PDF/OFX extraction and AI-proposed mapping remain future checks                                            |
| Explicit receive and later recount                            | Wardrobe run verifies that order import leaves stock unchanged; [inventory session E2E](../../apps/web/tests/e2e/inventory-session.spec.ts) reviews and completes a real browser recount                                                                                                                             | A location with two stock rows for recount                                | The wardrobe run creates its room and initial inventory through the entity writer; a photo-to-optional-receive UI check remains                        |

The wardrobe run verifies the joined graph after merge: one live Product, own
item and label Images, one InventoryEntry, one Purchase, its Expense, a posted
FinancialTransaction, and one allocation. It creates the Purchase before the
statement, leaves it unsettled after CSV import, and requires a human to choose
the charge in the Purchase UI. It also checks that replaying the
statement does not create another transaction or statement source row. The
held card-payment row never silently becomes a purchase or refund. The
retailer fixture exposes semantic order and Product data for a deterministic
reader; the photo model seam is likewise deterministic. These are regression
checks for Cubby's non-AI contracts, not scores for model decisions. Run a
separate live Flue trial for capture/extraction quality, streaming, and wall
time.

The browser and simulator loops run the built Cubby Worker in a local Wrangler
harness with isolated PostgreSQL and object storage. Only external service
bindings return offline responses; one local peer handles USDA, UPC, and the
inactive purchase agent, and acknowledges background queues. Photo journeys
seed the signed-in actor but create their Products from the uploaded photos.

## Other documented core journeys

| Documented journey                                                 | Local browser check                                                                                                                                                                                                                                   | Actual user action exercised                                       | Gap to close                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [Inventory recount](../inventory-audit.md)                         | [`inventory-session.spec.ts`](../../apps/web/tests/e2e/inventory-session.spec.ts)                                                                                                                                                                     | Open a count sheet, finish, reload, and resume                     | Native recount and scanned bin input                                         |
| [Product relationships](../product-relationship-route.md)          | [`relationship-discovery.spec.ts`](../../apps/web/tests/e2e/relationship-discovery.spec.ts) and [`connected-records.spec.ts`](../../apps/web/tests/e2e/connected-records.spec.ts)                                                                     | Review a relationship and navigate connected records               | An input-first Purchase/stock relationship path without seeded relation rows |
| [Garden](../garden.md)                                             | [`garden.spec.ts`](../../apps/web/tests/e2e/garden.spec.ts)                                                                                                                                                                                           | Create a planting, edit it, log a journal entry, and see its photo | Native camera capture and whole-season planning input                        |
| Recipes and meals                                                  | [`create-recipe-full-flow.spec.ts`](../../apps/web/tests/e2e/create-recipe-full-flow.spec.ts), [`recipe-flow.spec.ts`](../../apps/web/tests/e2e/recipe-flow.spec.ts), and [`meal-nutrition.spec.ts`](../../apps/web/tests/e2e/meal-nutrition.spec.ts) | Create and use recipe/meal controls                                | A single source-file-to-meal journey without injected extraction artifact    |
| [Projects and household work](../household-contribution-ledger.md) | [`project-tracker.spec.ts`](../../apps/web/tests/e2e/project-tracker.spec.ts)                                                                                                                                                                         | Add and navigate a Task                                            | Full contribution attribution through Project, Task, and Expense             |
| Cookbook import                                                    | [`cookbook-photos.spec.ts`](../../apps/web/tests/e2e/cookbook-photos.spec.ts)                                                                                                                                                                         | Upload a synthetic EPUB with photos                                | Cover through extracted recipe to meal in one run                            |

This table is a coverage contract, not a claim that every row is complete.
When adding a journey, keep the original input in a synthetic fixture, minimize
pre-created records, assert the durable final graph and replay behavior, and
update the gap column only after that local check passes. Browser videos and
simulator captures stay in ignored local artifacts.

## Run the current Product checks

```sh
pnpm test:e2e:headless:wardrobe
pnpm test:e2e product-photo-first.spec.ts
pnpm test:e2e photo-group-review.spec.ts
pnpm test:e2e inventory-session.spec.ts
```

Playwright's standalone command uses the built web app, so build it after web
source changes. See [validation policy](validation.md) for test tiers and the
exact-head GitHub merge gate.
