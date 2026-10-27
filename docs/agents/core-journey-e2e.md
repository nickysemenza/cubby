# Local input-first journey checks

These checks run against disposable local databases and synthetic evidence. Start
at the same boundary a person uses: a photo file, CSV row, browser page, or app
control. Seed only prerequisites that the journey cannot create itself, such as
the signed-in member, a configured account, or an existing item being matched.
Assert the final linked records after the review action, not just an upload or
an agent message. Keep raw household exports, real entity codes, and production
screenshots out of fixtures and test reports.

## Product identity and settlement

| Journey in [product identity](../guide/product-identity-journey.md) | Local check and actual input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Seeded prerequisites                                                      | Current boundary                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct photo, no run; manual Product                                | [`photo-group-review.spec.ts`](../../apps/web/tests/e2e/photo-group-review.spec.ts) opens the Product create dialog and uploads synthetic item and label PNGs                                                                                                                                                                                                                                                                                                                                                                       | Signed-in test member                                                     | Web creation and persisted image roles; native direct attachment still needs a simulator journey                                                                                |
| Photo inventory run                                                 | `pnpm test:e2e:sim -- --headless --photo --purchase` uploads synthetic PNG bytes through native APIs, adopts synthetic descriptions, submits scripted groups through the `photo_run.propose_groups` MCP tool (no agent run), and approves in Chromium; `photo-group-review.spec.ts` checks a selected two-group batch in the browser                                                                                                                                                                                                | Signed-in member, isolated database, local object storage                 | Tests the non-AI pipeline and review; grouping quality is `pnpm --dir apps/web eval:agent-models`, and physical iPhone interaction is a separate check                          |
| Retailer order and Product match                                    | `prepare-commit.integration.test.ts` owns exact-ASIN reuse and committed Product binding; `report-slot.unit.test.tsx` drives the actual prepared form with two exact suggestions, trade, explicit second choice and confirmation                                                                                                                                                                                                                                                                                                    | Synthetic Vendor/account and Product identities                           | SQL and renderer owners preserve writes and request assembly. Conflicting-choice HTTP/native-browser composition and merge between preparation and approval are deliberate gaps |
| Gmail order event                                                   | [`gmail.input-first-import.spec.ts`](../../apps/web/tests/e2e/gmail.input-first-import.spec.ts) connects Google through real OAuth, discovers MIME evidence using exchanged credentials and checks exact retained content with no economic writes. `purchase-import-run.spec.ts` separately owns saved-mail → Run → committed Purchase navigation/read-back; `purchase-emails.spec.ts` owns review and Gmail-original navigation                                                                                                    | Offline Google provider and signed-in member                              | Callback and credential-backed acquisition are real. Triage is injected; live Google/model quality and the joined OAuth-to-prepared-approval composition are separate gaps      |
| Monarch statement transaction                                       | `finance-evidence-journey.spec.ts` owns statement source navigation; `financial-booking-review.spec.ts` owns booking approval; `import-order-convergence.integration.test.ts` owns statement-first arrival and conserved money. `purchase-split-settlement.spec.ts` retains real split review; `purchase-settlement-candidates.integration.test.ts` owns signed refunds and stale refusal                                                                                                                                           | Synthetic financial account because CSV cannot establish account identity | Browser source/booking/allocation controls remain. Their composition with the same OAuth household and refund-specific HTTP composition are deliberate gaps                     |
| Native statement review contract                                    | [`source-transaction-record.integration.test.ts`](../../apps/web/src/server/domains/transaction-import/repo/source-transaction-record.integration.test.ts) previews, maps, pages, commits, and replays synthetic CSV through the native HTTP contract                                                                                                                                                                                                                                                                               | Signed-in test member and synthetic rows                                  | The server contract and both Mac file-selection/review arrival orders are covered; iOS simulator file-selection/review/approval passed on clean `877c35e22`                     |
| Financial evidence and reviewed ledger corrections                  | [`catalog.integration.test.ts`](../../apps/web/src/server/mcp/catalog.integration.test.ts) proves public intake preview/replay purity; [`financial-evidence-correction.integration.test.ts`](../../apps/web/src/server/domains/financial-transaction/repo/financial-evidence-correction.integration.test.ts) exercises normalized source corrections and persisted withdrawal proof; [`finance-evidence-journey.spec.ts`](../../apps/web/tests/e2e/finance-evidence-journey.spec.ts) verifies reviewed ledger corrections over HTTP | Signed-in test member; synthetic owned accounts and bookings              | CSV parsing belongs to the client skill; Cubby retains normalized evidence and protects money, attribution, review and replay                                                   |
| Explicit receive and later recount                                  | Wardrobe run verifies that order import leaves stock unchanged; [native fieldwork API E2E](../../apps/web/tests/e2e/native-fieldwork-api.spec.ts) commits and rejects a stale native recount over HTTP                                                                                                                                                                                                                                                                                                                              | A location with two stock rows for recount                                | The wardrobe run creates its room and initial inventory through the entity writer; a photo-to-optional-receive UI check remains                                                 |

The Gmail browser check retains only its unique authorization and original
acquisition boundary. It uses the real Connect control, callback and exchanged
token against an offline external Google provider, then checks retained MIME
identity/content and absence of economic writes. It does not establish live
Google or model quality. Prepared-form choice and confirmation are owned by the
actual renderer test; exact Product binding, merge preservation and sampled
source-arrival convergence remain in PostgreSQL. The former combined browser
sequence, including conflicting-choice HTTP projection and merging identities
between preparation and approval, is intentionally omitted to reduce CI work.
The removed capture helper constructed synthetic HTML text rather than driving a
production authenticated retailer browser.

The headless photo and wardrobe runs verify that subject-lift jobs wait for an
Apple device even when the synthetic cloud description marks a label ineligible;
cloud eligibility does not suppress Apple subject lifting.
The Node harness supplies the checkout's Git revision for in-process MCP calls,
matching the release constant injected into the built Worker.
Wardrobe order preparation names the source's seller explicitly on initial
import, replay and duplicate capture, creating or reusing the Vendor through
the import contract.
Purchase import-history report semantics remain in
`entity-report/repo/records.integration.test.ts`; the wardrobe settlement browser
step does not wait for the superseded direct `run.history` request.
The browser steps open settlement review from More actions, review the Product
pair in Suggestions, and check the joined Product's ownership/evidence guidance.
These steps use pinned `playwright-recorder-plus` and save H.264 MP4 recordings named
`late-charge-review.mp4`, `match-review.mp4` and `joined-product.mp4` in the run's
artifact directory. The package captures through Playwright's public screencast
API and ships its own FFmpeg binary; no system FFmpeg or WebM conversion is needed.
Stop each recorder and await `finalized` before reporting or attaching its MP4.
As in `photo-group-review.spec.ts`, identity judgment is scripted through
`publishProductPair`; name-only MCP proposals are informational and do not
establish merge admission. Exact-identity admission remains in Product match
integration coverage.
The final SQL read-back owns the exact settlement allocation count; retired
workbench-card images and settlement-panel wording are not browser assertions.
The duplicate-capture trap supplies a conflicting line amount and expects a
conflict finding while preserving the original Expense and settlement; identical
lines in a new capture are a no-op, not a conflict.

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
separate live import-run agent trial for capture/extraction quality, streaming, and wall
time.

The browser and simulator loops run the built Cubby Worker in a local Wrangler
harness with isolated PostgreSQL and a real local workerd R2 binding per run.
The local HTTP adapter preserves browser/native upload and public-read contracts
over that isolated bucket. Only external service
bindings return offline responses; one local peer handles USDA, UPC, and the
inactive purchase agent, and acknowledges background queues. Photo journeys
seed the signed-in actor but create their Products from the uploaded photos.

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

Playwright's standalone command uses the built web app, so build it after web
source changes. See [validation policy](validation.md) for test tiers and the
exact-head GitHub merge gate.

## Available native input checks

These commands exercise authored native file-selection and review scenarios.
The iOS input journey selects a real Files CSV, reviews account/row choices,
uploads 25 distinct synthetic photos through the authorized Library grid, closes the upload
sheet while work continues and reopens the import. Stored readback checks
transaction/account, every original photo digest, capture dates and library
sightings, current cloud-description jobs, and no automatic Product, Inventory,
Expense or transaction write. Group review is web's; `photo-group-review.spec.ts`
covers it. The
PhotosPicker fallback has separate authored scripts; this journey grants
Photos access and exercises the Library grid. Files
navigation handles the captured OS starting states; sheet review uses the
visible button when a phantom Toolbar's accessibility bounds cover the sheet.

A focused native scenario does not establish every arrival order. Live external
model/provider quality and physical-device background scheduling remain
separate. Run on an unlocked host and retain a sealed artifact.

```sh
pnpm test:e2e:sim -- --input-journey
```

The simulator scenario uses native CSV intake and photo upload controls. The Mac
arrival-order scenarios that composed retailer browser capture were retired with
the Mac browser bridge ([ADR 0010](../adr/0010-mail-import-unattended-burn-down-interactive.md));
the backend arrival-order matrix still covers that logic, without a Mac UI run.
See [Mac import checks](../../apps/web/tooling/mac-import-e2e.md) for fixture
signing, host requirements, and artifact boundaries.

The interactive CSV/photo journey can also run on the dedicated hosted simulator
job, which retains the checksum-listed evidence in its downloadable run bundle:

```sh
gh workflow run journeys.yaml --ref "$(git branch --show-current)" -f journey=simulator-inputs
```
