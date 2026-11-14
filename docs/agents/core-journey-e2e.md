# Local input-first journey checks

These checks run against disposable local databases and synthetic evidence. Start
at the same boundary a person uses: a photo file, CSV row, browser page, or app
control. Seed only prerequisites that the journey cannot create itself, such as
the signed-in member, a configured account, or an existing item being matched.
Assert the final linked records after the review action, not just an upload or
an agent message. Keep raw household exports, real entity codes, and production
screenshots out of fixtures and test reports.

## Product identity and settlement

| Journey in [product identity](../guide/product-identity-journey.md) | Local check and actual input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Seeded prerequisites                                                      | Current boundary                                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct photo, no run; manual Product                                | [`photo-group-review.spec.ts`](../../apps/web/tests/e2e/photo-group-review.spec.ts) opens the Product create dialog and uploads synthetic item and label PNGs                                                                                                                                                                                                                                                                                                                                                      | Signed-in test member                                                     | Web creation and persisted image roles; native direct attachment still needs a simulator journey                                                                                |
| Photo inventory run                                                 | `pnpm test:e2e:sim -- --headless --photo --purchase` uploads synthetic PNG bytes through native APIs, adopts synthetic descriptions, submits scripted groups through the `run.propose_groups` MCP tool (no agent run), and approves in Chromium; `photo-group-review.spec.ts` checks a selected two-group batch in the browser                                                                                                                                                                                     | Signed-in member, isolated database, local object storage                 | Tests the non-AI pipeline and review; grouping quality is `pnpm --dir apps/web eval:agent-models`, and physical iPhone interaction is a separate check                          |
| Retailer order and Product match                                    | `prepare-commit.integration.test.ts` owns exact-ASIN reuse and committed Product binding; `report-slot.unit.test.tsx` drives the actual prepared form with two exact suggestions, trade, explicit second choice and confirmation                                                                                                                                                                                                                                                                                   | Synthetic Vendor/account and Product identities                           | SQL and renderer owners preserve writes and request assembly. Conflicting-choice HTTP/native-browser composition and merge between preparation and approval are deliberate gaps |
| Gmail order event                                                   | [`gmail.input-first-import.spec.ts`](../../apps/web/tests/e2e/gmail.input-first-import.spec.ts) connects Google through real OAuth, discovers MIME evidence using exchanged credentials and checks exact retained content with no economic writes. `purchase-import-run.spec.ts` separately owns saved-mail → Run → committed Purchase navigation/read-back; `purchase-emails.spec.ts` owns review and Gmail-original navigation                                                                                   | Offline Google provider and signed-in member                              | Callback and credential-backed acquisition are real. Triage is injected; live Google/model quality and the joined OAuth-to-prepared-approval composition are separate gaps      |
| Monarch statement transaction                                       | `finance-evidence-journey.spec.ts` owns statement source navigation; `financial-booking-review.spec.ts` owns booking approval; `import-order-convergence.integration.test.ts` owns statement-first arrival and conserved money. `purchase-split-settlement.spec.ts` retains real split review; `purchase-settlement-candidates.integration.test.ts` owns signed refunds and stale refusal                                                                                                                          | Synthetic financial account because CSV cannot establish account identity | Browser source/booking/allocation controls remain. Their composition with the same OAuth household and refund-specific HTTP composition are deliberate gaps                     |
| Native statement review contract                                    | [`source-transaction-record.integration.test.ts`](../../apps/web/src/server/domains/transaction-import/repo/source-transaction-record.integration.test.ts) previews, maps, pages, commits, and replays synthetic CSV through the native HTTP contract                                                                                                                                                                                                                                                              | Signed-in test member and synthetic rows                                  | The server contract and both Mac file-selection/review arrival orders are covered; the iOS simulator input journey covers file selection, review and approval                   |
| Financial evidence and reviewed ledger corrections                  | [`catalog.integration.test.ts`](../../apps/web/src/server/mcp/catalog.integration.test.ts) proves public intake preview/replay purity; [`statement-spending.integration.test.ts`](../../apps/web/src/server/domains/transaction-import/repo/statement-spending.integration.test.ts) proves statement booking, durable decisions, replay, splits and baseline drift; [`finance-evidence-journey.spec.ts`](../../apps/web/tests/e2e/finance-evidence-journey.spec.ts) verifies reviewed ledger corrections over HTTP | Signed-in test member; synthetic owned accounts and bookings              | CSV parsing belongs to the client skill; Cubby retains normalized evidence and protects money, attribution, review and replay                                                   |
| Explicit receive and later recount                                  | Wardrobe run verifies that order import leaves stock unchanged; [native fieldwork API E2E](../../apps/web/tests/e2e/native-fieldwork-api.spec.ts) commits and rejects a stale native recount over HTTP                                                                                                                                                                                                                                                                                                             | A location with two stock rows for recount                                | The wardrobe run creates its room and initial inventory through the entity writer; a photo-to-optional-receive UI check remains                                                 |

The Gmail check covers the real Connect control, OAuth callback and token
exchange against an offline Google provider, then checks retained MIME content
with no economic writes; it does not measure live Google or model quality.

The headless photo and wardrobe runs are regression checks for Cubby's non-AI
contracts, not model scores: retailer reader and photo model seams are
deterministic and identity judgment is scripted through `publishProductPair`.
Use a separate live import-run agent trial for extraction quality and wall
time. The wardrobe run verifies that:

- subject-lift jobs wait for an Apple device even when the cloud description
  marks a label ineligible;
- order preparation names the seller explicitly, creating or reusing the
  Vendor through the import contract on import, replay and duplicate capture;
- the Purchase stays unsettled after CSV import until a human chooses the
  charge, statement replay creates no new rows, and a held card-payment row
  never becomes a purchase or refund;
- a duplicate capture with a conflicting line amount yields a conflict finding
  and preserves the original Expense and settlement; identical lines are a no-op;
- after merge there is one live Product with item and label Images, one
  InventoryEntry, one Purchase and Expense, a posted FinancialTransaction and
  one allocation.

Browser steps record MP4s with the pinned `playwright-recorder-plus`; await each
recorder's `finalized` before attaching it. The loops run the built Worker in a
local Wrangler harness with isolated PostgreSQL and a local R2 binding per run.
Only external bindings are offline: one local peer handles USDA, UPC and the
inactive purchase agent and acknowledges background queues. Photo journeys
create their Products from the uploaded photos.

## Other documented core journeys

| Documented journey                                                 | Local browser check                                                                                                                                                           | Actual user action exercised                                                                                                                                                                            | Gap to close                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Inventory recount](../inventory-audit.md)                         | [`native-fieldwork-api.spec.ts`](../../apps/web/tests/e2e/native-fieldwork-api.spec.ts) (server contract; the recount UI is native)                                           | Snapshot a bin, reconcile it, and refuse a stale snapshot                                                                                                                                               |
| [Product relationships](../entities.md#product-relationship-route) | [`relationship-discovery.spec.ts`](../../apps/web/tests/e2e/relationship-discovery.spec.ts)                                                                                   | Review a relationship and navigate connected records                                                                                                                                                    | An input-first Purchase/stock relationship path without seeded relation rows                                |
| [Garden](../garden.md)                                             | [`garden.spec.ts`](../../apps/web/tests/e2e/garden.spec.ts)                                                                                                                   | Create a planting, edit it, log a journal entry, and see its photo                                                                                                                                      | Native camera capture and whole-season planning input                                                       |
| Recipes and meals                                                  | [`create-recipe-full-flow.spec.ts`](../../apps/web/tests/e2e/create-recipe-full-flow.spec.ts) and [`meal-nutrition.spec.ts`](../../apps/web/tests/e2e/meal-nutrition.spec.ts) | Create and use recipe/meal controls                                                                                                                                                                     | A single source-file-to-meal journey without injected extraction artifact                                   |
| [Projects and household work](../household-contribution-ledger.md) | [`project-tracker.spec.ts`](../../apps/web/tests/e2e/project-tracker.spec.ts)                                                                                                 | Add and navigate a Task                                                                                                                                                                                 | Full contribution attribution through Project, Task, and Expense                                            |
| Label nutrition review                                             | [`label-nutrition-review.spec.ts`](../../apps/web/tests/e2e/label-nutrition-review.spec.ts)                                                                                   | Compare a detected proposal with the source photo and previous nutrition, edit it, Cancel without replacing stored values, then Save and reload without another prompt for the accepted analysis        | Detection is supplied deterministically; live label extraction and native review acceptance remain separate |
| Cookbook import                                                    | [`cookbook-photos.spec.ts`](../../apps/web/tests/e2e/cookbook-photos.spec.ts) and [`cookbook-bundle.spec.ts`](../../apps/web/tests/e2e/cookbook-bundle.spec.ts)               | Upload a synthetic EPUB or incomplete `.cookbook` bundle, import a recipe, retry its failed photo attachment, reselect the bundle without duplicating the imported recipe, and load the persisted photo | Cover through extracted recipe to meal in one run                                                           |

This table is a coverage contract, not a claim that every row is complete.
When adding a journey, keep the original input in a synthetic fixture, minimize
pre-created records, assert the durable final graph and replay behavior, and
update the gap column only after that local check passes. Browser videos and
simulator captures stay in ignored local artifacts.

## Run the current Product checks

```sh
pnpm test:e2e:sim -- --headless --photo --purchase
pnpm test:e2e photo-group-review.spec.ts
pnpm test:e2e shelf-triage.spec.ts
pnpm test:e2e native-fieldwork-api.spec.ts
pnpm test:e2e gmail.input-first-import.spec.ts
pnpm test:e2e purchase-split-settlement.spec.ts
pnpm test:e2e cookbook-bundle.spec.ts
pnpm test:e2e label-nutrition-review.spec.ts
```

`pnpm test:e2e` builds the web Worker first; see
[test tiers](validation-tests.md#build-and-serve) and the
[validation policy](validation.md) for the merge gate.

## Available native input checks

The iOS input journey selects a real Files CSV, reviews account and row
choices, uploads 25 synthetic photos through the authorized Library grid,
closes the upload sheet while work continues and reopens the import. Stored
read-back checks the transaction and account, every original photo digest,
capture dates and library sightings, current cloud-description jobs, and no
automatic Product, Inventory, Expense or transaction write. Group review is
web's (`photo-group-review.spec.ts`). Run it on an unlocked host and retain the
sealed artifact; it does not establish every arrival order, live provider
quality or physical-device background scheduling.

```sh
pnpm test:e2e:sim -- --input-journey
```

The backend arrival-order matrix covers retailer capture ordering without a Mac
UI run; [Mac import checks](../../apps/web/tooling/mac-import-e2e.md) cover
fixture signing, host requirements and artifact boundaries. The same journey
runs on the hosted simulator job, which keeps checksum-listed evidence in its
run bundle:

```sh
gh workflow run journeys.yaml --ref "$(git branch --show-current)" -f journey=simulator-inputs
```
