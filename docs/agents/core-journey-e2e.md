# Local input-first journey checks

These checks run against disposable local databases and synthetic evidence. Start
at the same boundary a person uses: a photo file, CSV row, browser page, or app
control. Seed only prerequisites that the journey cannot create itself, such as
the signed-in member, a configured account, or an existing item being matched.
Assert the final linked records after the review action, not just an upload or
an agent message. Keep raw household exports, real entity codes, and production
screenshots out of fixtures and test reports.

## Product identity and settlement

| Journey in [product identity](../product-identity-journey.md) | Local check and actual input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Seeded prerequisites                                                                           | Current boundary                                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct photo, no run; manual Product                          | [`product-photo-first.spec.ts`](../../apps/web/tests/e2e/product-photo-first.spec.ts) opens the Product create dialog and uploads synthetic item and label PNGs                                                                                                                                                                                                                                                                                                                                                     | Signed-in test member                                                                          | Web creation and persisted image roles; native direct attachment still needs a simulator journey                                                                                              |
| Photo inventory run                                           | `pnpm test:e2e:sim -- --headless --photo --purchase` uploads synthetic PNG bytes through native APIs, adopts synthetic descriptions, submits scripted groups through the `photo_run.propose_groups` MCP tool (no agent run), and approves in Chromium; `photo-group-review.spec.ts` checks a selected two-group batch in the browser                                                                                                                                                                                | Signed-in member, isolated database, local object storage                                      | Tests the non-AI pipeline and review; grouping quality is `pnpm --dir apps/web eval:flue-models`, and physical iPhone interaction is a separate check                                         |
| Retailer order and Product match                              | [`input-first-import.spec.ts`](../../apps/web/tests/e2e/input-first-import.spec.ts) exercises both statement-first and retailer-first arrivals, captures saved synthetic order and Product pages through the authenticated production browser peer, prepares the captured order, and explicitly chooses and merges conflicting Products before approval                                                                                                                                                             | Signed-in member, synthetic vendor and financial accounts, candidate Products                  | Production capture, shared preparation, and visible approval are covered; external extraction is deterministic. Live extraction quality and native interactive acceptance remain separate     |
| Gmail order event                                             | [`input-first-import.spec.ts`](../../apps/web/tests/e2e/input-first-import.spec.ts) clicks Connect Google & Gmail, grants synthetic consent through the real OAuth callback, discovers MIME order evidence, opens its Run, and links the mail to the reviewed Purchase; `vendor-order-mail-review.spec.ts` also checks dismiss, reload, link, and timeline                                                                                                                                                          | Offline external Google and model responses; signed-in member and vendor/account prerequisites | The application callback and discovery pipeline are exercised locally; live Google authorization and extraction quality remain separate                                                       |
| Monarch statement transaction                                 | [`input-first-import.spec.ts`](../../apps/web/tests/e2e/input-first-import.spec.ts) covers both retailer/statement arrival orders; [`input-first-settlement.spec.ts`](../../apps/web/tests/e2e/input-first-settlement.spec.ts) uploads synthetic charge, refund, and held-payment CSV rows, approves two captured retailer orders, reviews a charge split across both Purchases and a signed refund, rejects nonconserving or wrong-sign amounts, and replays the CSV without duplicate transactions or allocations | Synthetic financial account because CSV cannot establish account identity                      | Browser arrival orders, grouped settlement, refund review, held rows, and replay are covered. Both Mac arrival orders passed on clean `720068012`; iOS interactive CSV review remains pending |
| Native statement review contract                              | [`statement-row.integration.test.ts`](../../apps/web/src/server/repo/statement-row.integration.test.ts) previews, maps, pages, commits, and replays synthetic CSV through the native HTTP contract                                                                                                                                                                                                                                                                                                                  | Signed-in test member and synthetic rows                                                       | The server contract and both Mac file-selection/review arrival orders are covered; iOS simulator acceptance remains pending                                                                   |
| Full-size and unfamiliar statement CSV                        | [`statement-import.spec.ts`](../../apps/web/tests/e2e/statement-import.spec.ts) uploads a synthetic 501-row export in Chromium, confirms bounded source-row saves and replay, then maps unfamiliar columns and amount direction before saving another export                                                                                                                                                                                                                                                        | Signed-in test member; no seeded financial account                                             | Browser source evidence and manual mapping; PDF/OFX extraction and AI-proposed mapping remain future checks                                                                                   |
| Explicit receive and later recount                            | Wardrobe run verifies that order import leaves stock unchanged; [inventory session E2E](../../apps/web/tests/e2e/inventory-session.spec.ts) reviews and completes a real browser recount                                                                                                                                                                                                                                                                                                                            | A location with two stock rows for recount                                                     | The wardrobe run creates its room and initial inventory through the entity writer; a photo-to-optional-receive UI check remains                                                               |

The joined browser import checks cover both arrival orders with the same explicit
Product conflict review and merge. The prepared Run cannot commit until a Product
choice and expense trade are supplied. After approval, durable readback requires
one live Product with both identifiers, one Purchase and its economic line, and
no automatic inventory change. Gmail discovery starts from the real app Connect
control and callback, using an offline external Google provider and model ports;
it does not establish live Google or model quality.

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
harness with isolated PostgreSQL and a real local workerd R2 binding per run.
The local HTTP adapter preserves browser/native upload and public-read contracts
over that isolated bucket. Only external service
bindings return offline responses; one local peer handles USDA, UPC, and the
inactive purchase agent, and acknowledges background queues. Photo journeys
seed the signed-in actor but create their Products from the uploaded photos.

## Other documented core journeys

| Documented journey                                                 | Local browser check                                                                                                                                                                                                                                   | Actual user action exercised                                                                                                                                                                            | Gap to close                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Inventory recount](../inventory-audit.md)                         | [`inventory-session.spec.ts`](../../apps/web/tests/e2e/inventory-session.spec.ts)                                                                                                                                                                     | Open a count sheet, finish, reload, and resume                                                                                                                                                          | Native recount and scanned bin input                                                                        |
| [Product relationships](../product-relationship-route.md)          | [`relationship-discovery.spec.ts`](../../apps/web/tests/e2e/relationship-discovery.spec.ts) and [`connected-records.spec.ts`](../../apps/web/tests/e2e/connected-records.spec.ts)                                                                     | Review a relationship and navigate connected records                                                                                                                                                    | An input-first Purchase/stock relationship path without seeded relation rows                                |
| [Garden](../garden.md)                                             | [`garden.spec.ts`](../../apps/web/tests/e2e/garden.spec.ts)                                                                                                                                                                                           | Create a planting, edit it, log a journal entry, and see its photo                                                                                                                                      | Native camera capture and whole-season planning input                                                       |
| Recipes and meals                                                  | [`create-recipe-full-flow.spec.ts`](../../apps/web/tests/e2e/create-recipe-full-flow.spec.ts), [`recipe-flow.spec.ts`](../../apps/web/tests/e2e/recipe-flow.spec.ts), and [`meal-nutrition.spec.ts`](../../apps/web/tests/e2e/meal-nutrition.spec.ts) | Create and use recipe/meal controls                                                                                                                                                                     | A single source-file-to-meal journey without injected extraction artifact                                   |
| [Projects and household work](../household-contribution-ledger.md) | [`project-tracker.spec.ts`](../../apps/web/tests/e2e/project-tracker.spec.ts)                                                                                                                                                                         | Add and navigate a Task                                                                                                                                                                                 | Full contribution attribution through Project, Task, and Expense                                            |
| Label nutrition review                                             | [`label-nutrition-review.spec.ts`](../../apps/web/tests/e2e/label-nutrition-review.spec.ts)                                                                                                                                                           | Compare a detected proposal with the source photo and previous nutrition, edit it, Cancel without replacing stored values, then Save and reload without another prompt for the accepted analysis        | Detection is supplied deterministically; live label extraction and native review acceptance remain separate |
| Cookbook import                                                    | [`cookbook-photos.spec.ts`](../../apps/web/tests/e2e/cookbook-photos.spec.ts) and [`cookbook-bundle.spec.ts`](../../apps/web/tests/e2e/cookbook-bundle.spec.ts)                                                                                       | Upload a synthetic EPUB or incomplete `.cookbook` bundle, import a recipe, retry its failed photo attachment, reselect the bundle without duplicating the imported recipe, and load the persisted photo | Cover through extracted recipe to meal in one run                                                           |

This table is a coverage contract, not a claim that every row is complete.
When adding a journey, keep the original input in a synthetic fixture, minimize
pre-created records, assert the durable final graph and replay behavior, and
update the gap column only after that local check passes. Browser videos and
simulator captures stay in ignored local artifacts.

## Run the current Product checks

```sh
pnpm test:e2e:sim -- --headless --photo --purchase
pnpm test:e2e product-photo-first.spec.ts
pnpm test:e2e photo-group-review.spec.ts
pnpm test:e2e inventory-session.spec.ts
pnpm test:e2e input-first-import.spec.ts
pnpm test:e2e input-first-settlement.spec.ts
pnpm test:e2e cookbook-bundle.spec.ts
pnpm test:e2e label-nutrition-review.spec.ts
```

Playwright's standalone command uses the built web app, so build it after web
source changes. See [validation policy](validation.md) for test tiers and the
exact-head GitHub merge gate.

## Available native input checks

These commands exercise authored native file-selection and review scenarios.
Both Mac `csv,photo,receipt` and `receipt,photo,csv` cases passed at clean
`720068012`, in 116.3 and 124.1 seconds respectively. Their sealed artifacts have
437 and 464 verified checksums, matching builds, and passing final graph
assertions. Receipt-first classification uses the Expense editor and explicit
Save because settlement links preserve existing receipt classifications. iOS
`--input-journey` remains pending; these two Mac cases do not establish all six
arrival orders. Run on an unlocked host and retain a sealed artifact before
closing the remaining native gap.

```sh
pnpm test:e2e:sim -- --input-journey
pnpm --dir apps/web exec tsx tooling/mac-import-e2e.ts --order csv,photo,receipt
pnpm --dir apps/web exec tsx tooling/mac-import-e2e.ts --order receipt,photo,csv
pnpm --dir apps/web exec tsx tooling/mac-import-orders-e2e.ts
```

The simulator scenario uses native CSV intake and photo review controls. The Mac
order scenarios compose CSV, photo, and retailer receipt input; the final command
runs all six orders sequentially. See [Mac import checks](../../apps/web/tooling/mac-import-e2e.md)
for fixture signing, host requirements, and artifact boundaries.

The interactive CSV/photo journey can also run on the dedicated hosted simulator
job, which retains the checksum-listed evidence in its downloadable run bundle:

```sh
gh workflow run ci.yaml --ref "$(git branch --show-current)" -f simulator_e2e=true -f simulator_journey=inputs
```

## Delivery evidence

[PR #1491](https://github.com/nickysemenza/cubby/pull/1491) was merged at
`1dfbae716a48b4a22de752d1da3b350c19804405`. The exact PR head
`51c179035a3258dce0e3621e4ab1472846a5dbcc` passed
[CI](https://github.com/nickysemenza/cubby/actions/runs/37048868431), and the
merged revision passed [deployment](https://github.com/nickysemenza/cubby/actions/runs/37048929595).

The production rollout was verified separately: processing enabled and resumed,
a bounded description-only batch ready with no failures, current cloud prompt and
schema revision preferred in sampled immutable histories, and durable recipe
totals refreshed with no stale totals or persisted/live drift. A synthetic older
Apple 2.2 client was refused with HTTP 426. Physical-device background-window
acceptance remains separate from these server operations and native package checks.
