# Test tiers and runtime traps

[Validation policy](validation.md) owns test selection, failure-first evidence,
retention, delivery, and delegated check results. This page owns runtime traps.
Auth configuration tests await each constructed instance's `$context` inside
the invocation that supplied its bindings. Better Auth construction starts async
plugin initialization and logging; inspecting only synchronous options can leave
that work running when Vitest closes its console transport. Keep configuration
and overlapping-invocation assertions in the existing owner, without suppressing
console errors or introducing a delay.

The UI project shares module state between files. Its shared teardown clears
Sonner notifications as well as React trees: unmounting a Toaster leaves its
notifications available to the next test.

Keep pure logic imported directly by standalone Node subprocesses in alias-free
`.ts` files. Vitest uses the application's configured aliases; server composition
keeps the declared `~/server/` boundary. Temporary subprocess workspaces declare
their module type explicitly, matching the consumer. Build-provenance
fixtures clone their immutable synthetic Git template with Git rather than
recursively copying `.git` as ordinary fixture files.

The built-Worker photo-agent scenario owns dispatch through the actual agent/MCP,
persisted proposals and review progress, no Product/Inventory before review,
explicit concern resolution and one successful approval with exact ownership,
location and quantity read-back. Do not repeat direct rejection or replay matrices
inside that expensive harness. `run/proposals.integration.test.ts` owns direct
writes without review, failed unresolved approval, atomic confirmation and replay
without changed confirmation/duplicate writes. The agent scenario keeps its real
successful approval; only duplicate direct repository branches are removed.

Photo-import route binding and source-admission unit cases import
`photo-import-route-bindings.ts`, which evaluates contracts without loading
repositories or the entity kernel. Runtime route creation, singular image owners
and SQL relationship traversal stay in the existing photo-import transaction
integration suite, which already imports those production bindings.

Photo-group review prerequisites create their Location and Product category in one
fixture graph. Independent shirt, label and boots uploads run together; keep their
ordered result tuple and wait for every verified Image before linking the Run's
ordered roster. This batches setup without changing photo groups or assertions.

Nutrition-label review fixtures already upload servable bytes and persist verified
hash/dimensions before attaching the label. Inject the external description against
that verified source; do not repeat `verifyImages` or visit an auth page just to
obtain its mutation Origin. Keep the source-panel image, Cancel preserving current
nutrition, native serving edit/Save, exact saved nutrients, image-code provenance
and inference evidence. `product-photo-first.spec.ts` owns real saved-label gallery
rendering; a dedicated label-thumbnail reload after nutrition Save is removed.
`image-verification.service.unit.test.ts` retains missing-object, legacy backfill
and changed-byte mismatch checks; this nutrition case no longer samples the
manual `verifyImages` HTTP composition.

The saved-photo evidence browser journey keeps attach/create distinctions, a real
saved cover that decodes, native label-to-name editing and one phone overflow
check. `photo-run-detail.preview.test.tsx` owns native review presentation and
candidate comparisons; the separate saved-evidence failure/recovery and noisy
care-label browser journeys retain field cross-checks against saved evidence.
Exact thumbnail widths, 28px ledger rails and pseudo-element alignment are a
deliberate presentation-verification gap, not repeated backend-connected checks.

Vendor default freshness and successful apply/read-back belong in
`finance-context.integration.test.ts`, beside the Expense review owner.
`vendor-suggestion-context.integration.test.ts` owns independent evidence and
fingerprint changes. Do not duplicate these API-only assertions in a browser
journey that merely opens a Vendor link: that also races unrelated derived work.
The emoji browser journey retains suggestion acceptance without an early write,
compound emoji Save and explicit clear with HTTP read-back. It uses one Product
Category and no longer visits Spending Category and filtered category pages.
`category-connections.integration.test.ts` owns inherited mapping identity, the
reverse category list and effective-category filtering, including blocked-child
exclusion. The reverse-list disclosure, View all URL composition and final phone
overflow sample are deliberate gaps; shared list responsive coverage remains.
This removes the dedicated HTTP Vendor-apply smoke; production serialization
conflicts remain separately tracked rather than being claimed fixed by this move.

Decision-batching model fixtures assign answers by question ID, independently of
question insertion order after asynchronous cache preparation. Reverse the returned
answer order to exercise keyed routing; choosing by enumeration position makes a
correct asynchronous batch fail nondeterministically.

MCP budget-policy unit coverage waits for the actual in-memory SDK handler to
start, then advances a fake clock across the read/model thresholds. Do not use
a short wall-clock sleep between those budgets: a busy CI event loop can turn
an intended 45ms response into a false 60ms model timeout. Drain late work before
restoring real time; production deadline values remain unchanged.

Structured Account creation reads back its saved identity and card numbers after
the real editor closes. Its contract is schema/editor persistence; a searched
list’s post-create indexing and invalidation are separate outcomes. Do not make
this editor regression depend on the newly created row entering that list.

Connected-record Plant/Project/Task and both purchase paths use one fixture
graph with one shared brand. Booking-review prerequisites settle once before
the real spending journey. Keep its stale-screen rejection/recovery, chosen
Trade/Cost type, replay/altered-approval guards and exact positive money.
`financial-booking-review.preview.test.tsx` is explicitly required native coverage
for the real credit-purpose/Purchase pickers, no commit before review, reimbursement
preview input and forwarding the exact accepted snapshot to commit. The existing
`financial-booking-category.integration.test.ts` MCP reimbursement case owns the
negative Expense, exact net total, Purchase allocation, retained explicit policy
and effective reviewed-reimbursement policy. The second full browser credit
journey is removed; dedicated Worker HTTP composition of that credit form and its
post-credit detail read-back is the explicit gap, while real spending remains E2E.

Reviewed booking corrections belong in the existing PostgreSQL category/refund
owner: reimbursement reattachment preserves category and net money, transfer
conversion retires its generated Expense and exposes non-booking coverage, and
an edited Expense prevents conversion without changing its money or transfer.
The removed API-only browser case exercised no UI. The financial-booking-review
browser journey retains stale approval and replay; required native capability and
PostgreSQL/MCP retain reimbursement interaction and stored outcomes;
finance-evidence-journey retains source-record navigation and provider immutability.
Dedicated HTTP routing for the two correction operations is no longer sampled
by that case; generic operation transport and direct correction outcomes remain.

The signed-settlement browser journey keeps the refund-specific interaction:
negative default, refusal of a positive draft without writing, explicit approval,
exact negative allocation, unchanged itemized Expense and no received stock.
Build its small prerequisite graph once. The split-settlement browser owner
keeps charge splitting and accepted residual preservation; do not repeat those
steps or reopen the dialog here. `source-transaction-record.integration.test.ts`
owns immutable intake and replay, `financial-convergence.integration.test.ts`
owns accepted-identity replay and attachment without another Expense, and
`gmail.input-first-import.spec.ts` retains real captured-import review.
`purchase-settlement-allocation.unit.test.ts` owns signed draft conservation;
`financial-transaction-allocations.integration.test.ts` owns stored signed splits
and refusal of mixed signs. Combined statement intake/retailer import/refund
HTTP composition and reopening an accepted split are deliberate coverage gaps
in this smaller browser journey. No scenario is added, deleted or split.

Run-progress browser coverage loads one target-free Run and retains phase counts,
paused-rate context, completed work, expandable Workflow handoffs, readable errors
and phone visibility. The required `run-detail.preview.test.tsx` owns shared step
counts and uncounted steps; `work-progress.unit.test.ts` owns unknown-population
and paused-rate ETA rules. Do not repeat full database snapshots merely to inspect
indeterminate animation CSS or a second progress-count presentation. Indeterminate
count/ARIA presentation, animation/reduced-motion styling and the pre-sample
generation fallback display no longer have dedicated native-browser sampling.

Detail renderer and browser tests assert the continuous page: every section is
accessible without a view switch. Select a section hash to verify scrolling,
focus and history; empty sections retain headings, index entries and actions.
When adding editable fields, complete editor-test record baselines, including
nullable output projections, and run the untouched-submit regression: an absent
baseline can make an untouched form appear changed. Run the web `typecheck`
command after the final test fixture or query edit, even when its runtime test
passes; an earlier check does not cover later test repairs. `typecheck:app`
excludes all test files, including browser previews, and cannot verify them.
Primary entity-list search uses the generated `searchQuery` URL key. Use
`entityListHref` for declared column filters, and verify the visible search
value when narrowing a fixture cohort. Obsolete `q` or view aliases can be
discarded by route validation and leave a large unfiltered virtualized list.
Routes with their own explicit `q` schema, such as combined records, retain it.
Browser grouping journeys use the visible list Group control. Header-menu
dispatch remains in `table-header-layout.unit.test.tsx`; do not duplicate its
hover/focus disclosure in a backend-connected grouping journey.
Testing Library role queries use exact string names by default; Playwright's
`exact` option is not a Testing Library option.
Shopping-list quantity assertions scope to the named Ingredient row’s Need cell; worker-shared
meal fixtures may legitimately produce the same quantity for other ingredients.
A row filter’s `has` locator is relative to that row; do not repeat an ancestor
region in the inner locator.
Connection-path assertions choose a visible matching link rather than the first
DOM match, because collapsed/responsive branches can retain hidden duplicates.
Native-workspace session bootstrap assertions include the response body on a
status mismatch so a server failure can be attributed without another replay.

Daily aggregation fixtures keep same-day rows on one recent household day;
minute offsets from wall-clock time can straddle midnight and correctly produce
multiple day groups. Keep the transport-summary regression pinned to that boundary.

For conditional expected output, construct expected data and assert once; keep
`expect` calls and asymmetric matchers outside branches.

An isolated E2E login starts without a linked member LedgerParty; the synthetic
HMR household already has one. Before visiting a member-scoped surface such as
Settings merchant routing or Mail import, call `ensureMemberParty(page, name)`
from `tests/e2e/fixtures/core.ts` so its queries can resolve the acting member.

Create searchable picker fixtures through `createEntityFixture` so the entity
kernel also creates their SearchDocument. A raw row insert can appear in the
initial picker list and disappear when typed search resolves. For typed search,
use the picker helper's query/code option to wait for the actual search response
before selecting the record.
The quality-exception browser journey batches its fixture graph, then accepts one
exception, changes the evidence, reloads to establish persistence and clears the
stale exception through the real UI. Keep required-note admission and saved
Markdown links. Do not add a second accept/clear/accept cycle: the existing
`data-quality.integration.test.ts` active-exception case owns clearing and score
restoration; `availability-explanation.integration.test.ts` owns MCP set/clear,
blank-note refusal and stale evidence. Dedicated native active-exception clearing
is no longer sampled; native stale clearing and server active clearing remain.

AI usage recent-call browser coverage retains transport/status filtering before
the row limit, search/Clear, refreshed provider choices and visible cost evidence.
Do not repeat Provider/Model/Feature full-history picker permutations there.
`ai-usage.integration.test.ts` owns exact provider/model/feature filters,
case-insensitive query matching and filter choices older than every summary
window; its separate recent-call case owns filtering before a small explicit
limit. Model/Feature picker-specific HTTP composition is the deliberate gap;
the Provider refresh interaction and real transport/status journey remain.

Suggestion queue fixtures batch each independent prerequisite graph before
publishing its proposals: Product/brand/Expense, Project/placement stock, matching
Products/tag target, and each tag's supporting Products. Preserve entity writer
defaults, identities, cardinalities and stock quantities. Proposal publication and
revision reads stay after commit/frontier settlement; do not batch across a real
review or stale-support edit.

The queue/history journey confirms a connection in the global Suggestions table,
reads back its Expense Product link and unchanged cost, then records incorrect
feedback in automatic history. Decode the successful `assessment.reviewBatch`
response, including its applied item, before storage read-back: the member
Feedback event is persisted before the application transaction and is not a
commit signal. Global and record review use the same
`SuggestionActions` renderer. Do not repeat Product-detail and Expense-list visits
for that write. `suggestion-list.integration.test.ts` owns both-endpoint filtering;
the current-policy research recommendation in `assessment-product.integration.test.ts`
owns non-actionable exclusion, and the event-only link case in
`observations.integration.test.ts` owns unverified legacy history and automatic
history exclusion from pending suggestions. Project/placement browser coverage
retains record-level Pending suggestions interaction. Dedicated Product-detail and
Expense-list pending-popover composition, their SPA navigation sample, and legacy
audit-row wording are no longer sampled by this journey. Unasserted cover-image
setup and a second Product fixture are removed; no browser scenario is deleted.

Dense-header browser coverage resizes one populated detail page across desktop,
constrained desktop and phone widths, then drives the shared action/editor dialogs
once on the phone. Do not repeat full navigation or seed an unrelated Product list
for header coverage; category navigation stays in the emoji/category journey.

Bulk-edit checkbox and nullable-reference journeys reopen their dialog on the
current populated list after committed read-back, using idempotent row selection.
They do not reload the document just to start another edit. The task-board
cold-form journey batches its two fixtures and scopes the list to their shared
name; keep its CPU-throttled initialization and dirty-field read-backs.

The required `list-capabilities.preview.test.tsx` owns Select all matching through
the real Task list, bulk dialog and outbound mutation: two loaded rows plus one
unloaded identity, held next-page reads, retained filter scope and every selected
ID in the write. `list-ids.integration.test.ts` owns canonical filtered cursor
pages; the existing Task-guard case in `bulk-update.integration.test.ts` also
selects matching Tasks, commits both and preserves an outside Task. Small real
bulk-edit browser journeys retain native editing and database read-back. This
replaces the 101-row all-matching E2E case; dedicated Worker HTTP composition of
unloaded selection with its write is the deliberate remaining coverage gap.

Infinite entity lists disable URL pagination synchronization; `pageSize` in a
list URL does not shrink their loaded page. Real-server unloaded-selection fixtures
must cross the actual default page boundary and hold the next-page response
until admission; the required capability owner uses controlled paged responses. Do not shrink that cohort using an ignored URL parameter.

For a same-kind fixture cohort without intermediate reads, use
`createEntityFixtures`; it writes through the kernel in one transaction and
settles the frontier after the cohort commits. This keeps background publication
from repeatedly processing partially created fixture cohorts. Simulator product
fixtures also settle the derived frontier before search-based native journeys begin.
After a browser write, call `drainDerivedRefreshFrontier(db)` before a direct
serializable fixture import such as `recordSourceTransactionRecords`. The
offline search pump can otherwise update the shared refresh Job under the
import's snapshot and fail it intermittently.
For a mixed-entity prerequisite graph, use `createFixtureGraph` with its supplied
kernel writer. It commits the graph and settles projections once; keep fixtures
with intermediate browser reads outside that transaction. Recipe costing,
meal-food writes and review-proposal publication that consume the committed
graph run after the transaction, rather than settling each prerequisite.
Setup that consumes only identities uses `createRepoIdentity` or
`createProductIdentityFixture`; retain the full-response fixture when its
returned fields are under test. Validation, audit, financial allocations and
publication still execute; unused presentation hydration does not.
E2E `createFixture`, `createEntityFixture` and `createFixtureGraph` return only
an identity and request only `id` through the kernel mutation reader. Browser
assertions still load the real detail/list projections. After a browser write,
use `performOperation` from `tests/e2e/support/dispatch-wire.ts` when direct
read-back needs the commit: it observes the named operation and decodes success
for singleton and batched responses. Poll only genuinely eventual work.
Filter/sort SQL-plan matrices use production progressive core reads when
available, including their baseline counts and unmatched-identity checks.
`list-read.integration.test.ts` owns complete-row/enrichment equivalence;
plan probes do not need unrelated media or quality hydration. The MCP all-kind
selection matrix keeps each entity’s four reads together and overlaps at most
two entities against its read-only seeded world, below the file’s pool size.
Filter-oracle tests that compare only row identities likewise use core reads;
retain their real PostgreSQL predicates and expected-ID assertions.
Mutation fanout probes request identity receipts when measuring bounded write
work; expanded response hydration may legitimately read related records and
retains its read-contract owners.
Query-scope probes inspect complete SQL templates before shortening report
excerpts; telemetry truncation must not hide a forbidden join from the probe.
Bind values remain outside observation.
Reconcile derived inputs once after a mutation boundary before reading several
fingerprints of that same state, rather than repeating a full reconciliation
for each read.
Filter journeys verify resulting rows and URL state after reload or history
navigation. An open editor and an active chip may share the same accessible
label; that transient duplication is not a failed filter. Keep shared range,
quality and presentation permutations in their owning regressions rather than
repeating them in each list journey.
Purchase–Email browser review keeps the suggested candidate, dismissed state after
reload, explicit Link, linked Email navigation, Gmail-original URL and member
relevance. It does not repeat a missing-Google diagnostic preview or reload again
after that failed read. `full-preview.integration.test.ts` owns the preview's
classification routing and unchanged Email/evidence storage through the real
operation/MCP composition with provider/model seams. Dedicated native preview
button/error recovery sampling is a deliberate diagnostic-UI coverage gap.

The statement Suggestions journey seeds its category, account and pending candidate
in one graph and begins after decision labels are published. It retains named
candidate attachment, reviewed Vendor correction, pending spending, explicit clean
bulk confirmation, supersession money and dismissal. `statement-transaction-kind.unit.test.ts`
owns the no-label clean-acceptance guard, and `statement-suggestions.integration.test.ts`
owns applied source `matched` state. `finance-evidence-journey.spec.ts` retains
real source-list/detail navigation and immutable provider facts. The removed
unlabeled-state visit and final source-status visit no longer sample those
specific UI states; no review/write outcome or money assertion is removed.

The Gmail convergence journey creates both exact-identifier conflicts in one
fixture graph, retains the explicit import choice, then merges identities through
the same `entity.mutate` endpoint before committing the prepared import. Native
merge confirmation remains in `suggestion-queue.spec.ts`; the real imported money,
single Product, both identifiers, exact Email–Purchase link and no-stock outcomes
remain in Gmail read-back.
`purchase-emails.spec.ts` owns related Email navigation and the Gmail-original URL.
The existing processing/accepted-source case in `email-purchase-links.integration.test.ts`
checks the exact original URL in the real Email report. Gmail convergence keeps
its credential-backed original acquisition and exact Email–Purchase read-back
without another Email page visit. Dedicated original-link composition on that
OAuth-ingested Email, Product-list multi-select merge launch and the
Vendor→Purchase→Email SPA chain are intentional UI-composition gaps.

Allocation explanation browser coverage keeps mixed-trade contributor expansion,
phone bounds and allocated Project evidence on one detail document. The existing
`field-explanation.integration.test.ts` mixed-adjustment case owns clearing a
principal trade, recomputing the adjustment to its Purchase fallback and preserving
stored null. Do not repeat that API-only update with a second browser document;
this removes dedicated HTTP sampling of that explanation refresh, while the
native contributor interaction remains. Location explanation fixtures commit
Product, Location, acquisition and Inventory together; list/detail links, partial
quantity discrepancy and nested beneficiary evidence remain native assertions.

Receiving after photo inventory exercises the Purchase's real per-line
`ReceiveExpenseDialog`: possible photo match, no-write default, required typed
quantity, exact received amount and fresh stock when reopened. Purchase and
Expense compose the same dialog; do not repeat a full Expense/Purchase route
pair just to assert its default again. Dedicated Expense action-launch composition
and collapse/reopen quantity sampling are removed; typed-quantity admission,
stock persistence and real Purchase composition remain.

Inheritance browser coverage owns the real reset from a matching explicit Project
into live Purchase inheritance, with stored-mode readback and visible provenance.
Allocation contributor interactions belong in `resolution-evidence.spec.ts`;
`purchase-inheritance.integration.test.ts` owns exact Project shares on detail
and list explanations and absence of a stored override. Do not add tax fixtures,
extra detail visits or Purchase-cell overflow checks to the reset journey.

The Gmail import-convergence journey prepares its statement-first aggregate with
`previewFinancialBooking` and `commitFinancialBooking`, preserving selected
Vendor/category and allocation/Purchase read-back before the real retailer review.
`financial-booking-review.spec.ts` owns the native booking form, stale preview,
fresh approval and replay guards; `import-order-convergence.integration.test.ts`
owns source-arrival permutations and conserved money. Do not repeat the booking
form inside Gmail's OAuth/MIME, conflicting Product choice, prepared import and
reconciliation journey. Dedicated booking HTTP composition with that same Gmail
household is the deliberate gap; final single Purchase/Product/Expense, Email
link, both identifiers and no-stock assertions remain. Socket
lifecycle checks use a warm baseline and two read/write rounds with real idle
expiry, without a request-load population. Coordinator retirement authorization,
acknowledgement and operation fences run in PostgreSQL; the cold-host disposal
rehearsal is a deliberate rare-case coverage tradeoff.
Spending-preview equivalence uses a small explicit graph for inherited and
explicit categories, split Projects, refunds and signed adjustments. Keep
the resolver/allocation comparison; do not generate household-sized random
populations or repeat the same merge solely at larger cardinality.
Give each inherited merge source an independent Purchase without another
matching Expense override, so broad Purchase scope cannot hide a missing
Vendor-default, Purchase-default or mapped-category predicate. Assert that each
isolated Expense actually inherits the changed category before comparing the
preview; a productless Vendor path needs a food-related spending profile.
The adjustment-only Purchase also needs a changed default: merely finding a
`default` allocation row does not prove that preview reclassifies it.
The jsdom browser harness supplies matching client and offset viewport dimensions
for real virtualizers; a zero client viewport renders no rows even with cached data.
A virtualized table's DOM contains only its mounted window. Cursor-pagination
fixtures that assert every row at once must fit that window; bounded-viewport
journeys inspect rows across scrolling instead of treating unmounted rows as missing.
Locate recipe ingredients through the named Ingredients region, not an `aside`
tag that couples the journey to its layout. Scope ingredient-link assertions to
the recipe's ingredient list items. Entity
previews can repeat the same ingredient name elsewhere in a sidebar; a broad
text assertion can become ambiguous when the preview opens.
Relation-table assertions target the visible record link by its href within
the section; shortcode metadata can be mounted but hidden.
When removing shared UI bindings, render every affected header branch or run
the app TypeScript check before handoff. Helper-only tests and lint do not
establish that a list or detail header can render with its actual props.
Direct component tests of feature-backed pickers call `installFeatures()` from
`~/features/registry` themselves; the browser harness supplies context, not the
route's registry installation.

Upload and photo-finalization tests configure `captureBackgroundQueue` when
running in Node. Image processing always schedules work; do not suppress its
queue seam with persisted enable/pause settings. Assert durable jobs and their
captured wakeups, draining only when the scenario needs consumer behavior.

Do not overlap PostgreSQL and E2E locally: they contend for
containers, workerd, browsers, and database connections. For changed workspace packages, run their affected test rather than every
package. A cross-package contract change may need its consumers too.
Verify every named test path exists before invoking a runner: Vitest can ignore
a nonexistent selector when another supplied file matches. Report only the
files and cases the run actually exercised.
Keep database regressions scoped to the failure: one sort/page-boundary case can
establish stable order without enumerating every field and direction. Do not
append query matrices to image or ownership cases with a default test deadline.
For a named-case handoff, copy the exact replay selector or confirm the literal
test title with `rg` before invoking the runner. A title inferred from the task
description can select no cases; that setup failure supplies no regression evidence.

CI retries a failed Playwright test, or a failed test in a service-backed
Vitest project (`integration`, `integration-workerd`, `capability`, `preview`,
`workers`), once; Node unit, UI, tooling and package projects never retry, and
locally nothing retries.
A test that passes only on retry is reported as flaky, not failed. The second
time a test is reported flaky, fix it or delete it, recording the named
failure and the deleting commit in a GitHub issue so it can be
restored once fixed. Do not skip it in place. Read the standard runner report
and confirm that the intended cases executed: skipped, pending, and empty
selections are not validation evidence. Never raise the retry count.

Scope artificial CPU throttling to the interaction whose race it guards;
restore normal speed for unrelated setup and read-back. A shared detail
renderer's section matrix renders once per entity and checks all declared
sections together; the continuous-detail browser journey owns hash navigation.

Table record-identity links open an inspector. For full-record assertions,
follow its Open full details action or navigate directly; clicking the row's
anchor does not prove a route transition. Keep shared chip-overflow layout
coverage in required table capabilities; a finance journey verifies the hidden
category's accessible action and full-record links without repeating hover
tooltip text.

Before a focused browser replay, run `pnpm --filter @cubby/web run build:cf
--ensure` after changing the recorded source revision. The prebuilt provenance
gate can reject a run after workflow or documentation edits too; a
`source-changed` startup failure executed no scenarios and is not a test result.

Secondary record actions live in the contextual header overflow. Every detail-page navigation that is followed by a secondary action uses `gotoDetailActions` with that action as its ready locator, or calls `openDetailActions` before selecting it. Repeat this after returning to the same record; a prior dialog does not leave the next navigation's overflow open. Use the declared section hash when targeting a section, and never use a hidden secondary action as the page hydration marker. Assert secondary-action availability inside the open Entity actions group before dismissing the overflow. Closed overflow owners stay mounted, so explanation checks select the visible popover rather than every popup node.

Target a browser spec as `pnpm test:e2e <spec>` without an extra `--`. E2E
serves `dist/`, so build it before a standalone run; `verify:local` does. The
coupled Workers harness rebuilds a stale web Worker itself. A
standalone Playwright request context inherits project storage state unless it
sets empty cookies and origins. workerd drops an idle keep-alive socket after 5s
while Playwright reuses it, so the E2E fixtures retry an idempotent
`page.request`/`request` call once on `ECONNRESET` ("socket hang up"); a POST
or PATCH is never replayed.

Hydration waiting polls the authenticated shell's attached hydrated marker on
browser animation frames, avoiding locator retry backoff after the shell is
already ready. Keep this single DOM condition; do not nest an auto-waiting
locator assertion inside `toPass`. Session and sign-in diagnostics
run only after timeout and distinguish an unauthenticated SSR shell from a
client bundle that never hydrated.

Request-correlation browser fixtures use a valid Cloudflare ray (hex with an
optional data-center suffix): the server rejects arbitrary `cf-ray` strings.
Browser dispatch can batch concurrent queries. A mock that parses a single
operation envelope uses `unbatchFor` before its per-operation handler. Keep
lazy-fetch assertions sensitive to every envelope; after refusing a batch,
count individual operation attempts separately from transport fallback.
Browser diagnostics require decoded RPC success, not only HTTP 200. Reuse
`operationResult` in `apps/web/tests/e2e/support/dispatch-wire.ts`: single
responses require `ok === true`; streamed NDJSON items require decoding `r`
with SuperJSON and checking both settlement `ok === true` and operation
`value.ok === true`. A successful settlement can contain a failed operation.
Compare related layout bounds in one browser evaluation so their rectangles
come from the same render state.

Playwright E2E and the coupled Workers harness share a per-worktree lock at
`/tmp/cubby-harness-<worktree hash>.lock` (`apps/web/tooling/dev-services/harness-lock.ts`,
managed by `proper-lockfile`). It keeps one checkout's suites from rebuilding
its Worker under each other or starving each other of CPU; other worktrees run
concurrently on the shared test services. The library refreshes the lock
while held and reclaims it after an interrupted process. Child processes inherit
the owner marker and pass through. `test:e2e:watch` (`--ui`) skips the lock, since
its idle session would otherwise hold it indefinitely. Only the profiles marked
"yes" below take it; a Playwright run and the `integration-workerd` project hold
it from global setup, and their workers pass through. The only machine-wide
lock, `/tmp/cubby-native-device.lock`, serializes simulator lanes
(`sim-e2e.ts`); the Mac import lane keeps its own fixture lease.

A spec's `test.use` of a
worker-scoped option (`video`, `trace`, `screenshot`, browser launch options),
even to its default, moves its tests into extra workers that each boot another
browser, database, and Worker harness; only `workerdProfile` may split
workers. Review fixture options directly rather than policing source spelling
with a test. Each split costs a shard a
worker restart, so a signed-out spec uses the test-scoped
`test.use({ signedIn: false })`, and Gmail specs are named `gmail.*.spec.ts`
so the one-worker `Gmail profile tests` project runs them together at the start
of a shard. Record video for a
run with `CUBBY_E2E_VIDEO=1`. RTable's placeholder transition can eat clicks;
cell-edit tests retry opening and filling as one action.

Responsive table toolbars mount both desktop and phone branches during SSR.
After navigation, use a retrying `toHaveCount(1)` assertion on the role locator
and `toBeEnabled()` before a strict search action. Playwright resolves strict
locators before waiting for hydration-disabled controls to become enabled;
the assertion preserves uniqueness while the responsive branches settle.
Do not select `.first()` or add a sleep to bypass duplicate controls.

Playwright request interception disables Chromium's HTTP cache. Scope synthetic
retailer documents to the retailer page, never the shared browser context or
the Cubby application page. Install transient interception immediately before
the action that needs it, including opening UI that fetches automatically.
Remove it once its regression has been observed,
before later navigations or reloads. When a test holds a response, release its
gate and await `page.unrouteAll({ behavior: "wait" })` so fulfillment finishes
before interception is disabled. Table-row fixtures used by selection actions
must include TanStack's `row.id`, not only `row.original.id`.
Image prerequisites upload synthetic bytes
to the isolated worker object store; do not fulfill application image URLs with
page routes. Assert image decoding as well as visibility. Retired-route HTTP status
contracts use `request.get`; browser scenarios own visible not-found behavior.
When a journey already exposes the destination link, follow that link to exercise
client navigation. When a record name occurs on links to multiple entity kinds,
combine its accessible name with the canonical href before choosing a link.
Keep document loads and reloads that own direct-link, SSR, or
persistence regressions. Seed incidental prerequisites through supported
fixtures instead of repeating unrelated create and search journeys. Ordinary
passing runs keep assertions and automatic failure screenshots; explicit
screenshots belong to visual comparisons or intentional demo/exploration
output. Use the existing authenticated request context for fixture setup before any
page load. A synthetic socket-only browser peer can use the same-origin session
response as its document; its separate capture page still exercises the real
external DOM. A link transition expected to stay within the app can
assert that `performance.timeOrigin` is unchanged, so a plain anchor cannot
silently turn it into another document load. When comparing card geometry across
enrichment, await the card and ancestor animations after switching list views
before recording the baseline; a visible loading field can precede the settled
view gutter. Preserve the exact before/after size assertions. After a column
customizer action removes its focused row, dialog focus restoration can consume
the next keyboard activation. An action retry must require the complete order
to remain unchanged and stop once the exact expected order is visible; never
repeat a relative move after it has applied or weaken the ordering assertion.

### Workerd test runtime and profiles

A PostgreSQL test file that starts workerd belongs in
`workerdIntegrationTests` (`apps/web/vitest.config.ts`), which forms the
`integration-workerd` project; CI runs it in the Worker build job against
that job's fresh bundle. An unlisted consumer fails in the ordinary integration
job.
A runtime borrowing a `withTestDb` database must close in `afterEach` before
the next reset. Reset diagnostics include backend state, wait type and backend/state ages, without
SQL text or connection credentials, so recurring foreign-session failures can be
attributed before weakening the ownership guard. Suite-level reuse leaves unowned Worker database sessions and
causes reset to fail; `afterAll` cleanup is too late.
Purchase-agent scenarios capture source/build provenance at suite boundaries and
write one checksummed bundle with separate per-case reports. Their Workers still
close after each case; Mail-only scenarios omit object storage. Socket-lifecycle
coverage shortens the configured pool idle timeout and observes three times that
interval per quiet window, preserving real expiry without production-length waits.
It uses a synthetic persisted session and Better Auth's signer, as the real Worker
provider-discovery owner does, to authenticate its HTTP calls. Password signup is
owned by browser runtime authentication; do not repeat it inside socket lifecycle.
Keep all three quiet windows, concurrent reads, freshness writes and socket-count
assertions; removing password setup must not shorten the expiry observation.

Native relation journeys scroll the navigation row back into view after inspecting
its badges, then wait for the destination detail marker before inspecting
inverse evidence. A successful tap alone does not establish navigation.

The Plant connection browser owner keeps its multi-hop task/project paths, both purchases,
Open all plantings and Project/Task composition. Product inverse navigation stays
in `product-clarity.spec.ts`; the existing connected-record SQL owner checks
Vendor purchased-Product traversal and duplicate Expense paths. Dedicated Vendor
Product-section rendering and its path-copy check are a presentation tradeoff;
do not repeat those visits inside the Plant journey.

Rows with interactive facts expose a separate title identifier; navigation
tests target that title rather than the aggregate row, whose center can land
on a field explanation control.

A profile (`WORKERD_PROFILES` in `workerd-harness.ts`) routes each production
queue consumer to one of:

- `real`: the built Worker's own consumer, with production settings except
  `max_batch_timeout: 0`.
- `dropped`: `local-offline-peers` acknowledges and discards each message.

`WORKERD_PROFILES` owns profile names, peers, queue modes and harness-lock
selection. Choose the declared profile that exercises the real boundary rather
than adding a spec-specific worker option.

Every profile includes `local-offline-peers` as the sink for dropped queues.
Durable Objects live in the built Worker and are real in every profile; the
harness seeds the synthetic USDA release into `USDA_RELEASES` before any USDA read. Starting a
profile throws when its routes and the compiled Worker's queue consumer names
differ in either direction. That check covers consumer queue names only, not
producers, Durable Objects, Hyperdrive, or service bindings, so it is not
exhaustive binding coverage. A separate cold-start probe of every coupled
consumer is deliberately omitted: required agent scenarios exercise real
dispatch, and paying another Worker startup to test harness wiring is not
worth the ordinary correctness gate's cost.
Required offline/Gmail browser journeys and purchase-agent integration scenarios
exercise the other profiles. Separate absence-of-consumer probes for those
harness profiles are deliberately omitted.

A browser spec may declare `objectStoragePublicUrl` for an HTTPS source identity
while its bucket remains local. Its asset transport must forward requests to the
actual stored bytes; do not substitute an image or loosen capture URL guards.
Scripted model/capture seams verify orchestration and source transport, not live
research quality, remote downloads or Gmail authorization.

The `Purchase import agent` Playwright project
(`tests/e2e/purchase-import-run.spec.ts`,
`test.use({ workerdProfile: "purchase-agent" })`)
runs the browser against the purchase-agent workerd harness with a scripted
model and gateway; `e2eRuntime.purchaseAgent` loads each test's script. It is
configured against the purpose's declared model and effort; derive ordinary
inference expectations from `importRunAgentManifest` so policy changes do not
leave stale model pins in browser journeys. Explicit escalation scenarios
still name the expected transition.
It is
excluded from the required desktop shards and runs in CI as an optional job
(`pnpm --dir apps/web test:e2e:ci:purchase-import`). Hold the model with a
`{ gate }` step to observe a live Run instead of racing it; a Run the browser
starts has no id until the click, so scripts use `currentRunId`. Prefer it over
a UI-less scenario for anything the Run or Purchase page shows; keep scenarios
for server fences the UI cannot observe.
Branch on the current public tool-result shape (`imports_read.mail` returns
the retained Email's `content` and `checksum`; `purchase_import.commit` and
`mail.resolve` settle it). Generate an item title once per fixture and reuse
it in the retained original and proposal: tests share a worker database, so
unrelated fixtures must not collide on Product name/manufacturer. Repeated
orders for the same item reuse the Product reference returned by resolution.

Garden journeys batch their Plant, Location and existing Planting prerequisites.
The populated Location journey owns its native section create action and both
Planting rows; shared empty-section/count behavior stays in the two viewport
`continuous-detail.spec.ts` cases. Dedicated empty-Location section sampling is
removed. Journal creation retains immediate display and a fresh Location document
read-back of the same saved entry; an extra intervening Planting reload adds no
write coverage. Dedicated Planting-journal reload composition is the deliberate
gap. Keep status persistence, inferred timeline and real photo-thumbnail coverage.

Independent garden create/edit/journal, meal product/ingredient/manual-food,
recipe nutrition basis/catalog/scale, and photo evidence/recovery/rejection
journeys use separate graphs. Product photo creation owns upload coverage;
label nutrition review starts from an attached verified image. Keep prerequisite
writes in `createFixtureGraph` when no intermediate read is asserted, so derived
refresh runs against the committed graph once.

CI's web E2E artifact is Playwright's built-in HTML report and retained traces.
Each Playwright job uploads them under an artifact name containing the tested
commit SHA. CI traces only the retry of a failed test (`on-first-retry`);
local runs keep failure traces (`retain-on-failure`). Open
`playwright-report/index.html` from the downloaded artifact to inspect the
run. Local native runs keep the `sim-e2e` artifacts, which record their build,
process, simulator, watchdog, scenario and replay evidence. These established
artifacts remain useful diagnostics; a custom run bundle is not required for
every E2E journey or runtime acquisition.

A failed E2E test attaches the Worker harness's structured workerd logs
(`harness.getLogs()`, credential-shaped values scrubbed) to the Playwright
result, where the HTML report can open the attachment. The local reporter also
keeps its workerd logs in `playwright-report`. Each Playwright worker prints
`<origin>/cdn-cgi/local/explorer` at startup, so a paused (`PWDEBUG`, headed, or
`--ui`) test can be inspected for Durable Object, queue, workflow, and R2 state.
The URL is only valid while that worker is alive.

List URLs in browser fixtures use the filter descriptor's declared `urlKey`
(for example, `q` for Expense and Purchase search). Assert the active filter
control and include unrelated records with a small page size when testing a
filtered record; an ignored filter can pass against a small local corpus and
hide the target behind pagination in CI. Fuzzy searches can legitimately include
neighboring records: assert the intended records and their relevance rather
than treating a fixture prefix as an exact total-result contract.

When changing shared list view controls, update interaction tests for every
consumer, including USDA lists. Preserve their query and destination regressions
when replacing the control's selectors.

Lazy quality-explanation journeys wait for the row's loaded assessment before
opening it; initial trigger visibility can precede deferred enrichment. Compare
column order by `data-column-id`, since enrichment and responsive labels can
change header text without moving a column. Complete quality cells expose the
score and spoken status together; assert the loaded cell value. When moving
hover or keyboard focus between timestamp cells or chart bars, scope assertions
to the target value's tooltip and `[data-open]`: the previous tooltip can remain
open briefly during focus transfer as well as mounted during its closing animation.

Connections workspace coverage explicitly selects its record before resizing to
phone, then waits for and dismisses the modal Graph inspector before using the
underlying Paths list toolbar. Selection retains inspector state across the
breakpoint; an open sheet correctly hides the toolbar from accessibility. Keep
the real close interaction, linked destinations/Back and native handoff; do not
use hidden-role queries or forced clicks to bypass modal focus containment.

Scope sidebar assertions by the section's own heading, not arbitrary descendant
headings: nested panels and relationship graphs can repeat the same heading.
Assert that the intended container is unique; do not use `first()` to hide a
second matching record. Replay against the final rebased source when main
changes the affected layout.

## Required component-browser tests

The `capability` Vitest project runs the explicitly selected shared list/table/explanation
coverage in `vitest.config.ts`. Production renderers run in headless Chromium
with the real Tailwind CSS. It is part of `pnpm test` and the Vitest shards;
those runners install Chromium before running the tests. No additional runner
is allocated. Other `**/*.preview.test.tsx` files remain opt-in through
`pnpm --dir apps/web test:preview`; they are not retained merge-gate coverage
until migrated into the required roster. Select a required owner with
`pnpm test:file <path> --project capability`; otherwise a workspace link can also
match the optional preview project. Explicit `--project preview` retains the full
optional preview command. Each Vitest shard uploads its blob and browser
failure attachments (`.vitest/attachments/`) for the merged CI report.

`spend-chart.preview.test.tsx` owns the real detail chart's roving keyboard focus,
single tab stop and portal readouts bounded at both viewport edges, with the chart
inside an overflow-clipped container. PostgreSQL `detail-data.integration.test.ts`
owns twelve-month zero filling and distinct live Expense sums. The continuous
Product E2E keeps the evening calendar-day Activity label; it no longer repeats
chart keyboard/geometry checks through a full server-backed record. Dedicated
Product hero chart-composition sampling is the deliberate gap in that move.

The compound date editor owner verifies local drafts, atomic replace/clear and
responsive nested popovers on desktop and phone.

Shared list, table, card, detail and photo-review presentation capabilities have
one owner here: populated/empty/loading states, responsive layout, overflow, focus and
interaction state. Use actual declarations, column modules and renderers with
schema-valid responses through their existing operation seam. Record outbound
requests; do not implement a second filter engine. A capability matrix replaces
route × viewport × state copies. Native previews retain native layout, media
queries, scrolling and observers; only jsdom setup supplies browser emulation.

`enum-field-display.unit.test.tsx` owns declared enum labels and tones;
`navigation-count-badge.unit.test.ts` and dashboard integration own count semantics.
The enum/color browser journey's repeated route visits and computed CSS comparisons
are omitted. Exact active-icon and token colors remain a visual-verification gap.

Keep server inclusion/exclusion, full-filter totals and stored effects at the
real HTTP or PostgreSQL boundary. Keep a small real browser composition suite
for navigation/history, actual inspectors, grouped/nested loading and retry,
asset rendering and consequential edits. Component responses cannot establish
those contracts. Photo-review candidate strength, failure/retry and approval
availability use the real review renderer with schema-valid responses; proposal
mutation/inference rules stay in PostgreSQL coverage, and approval, stock
receiving, variant merges and Expense linking retain real browser journeys.
When moving coverage, name the retained owner or the deliberate
coverage tradeoff in the deleting commit. Use the `ui` jsdom tier for a distinct
failure that does not need native browser behavior; avoid duplicating the same
shared capability in both tiers.

`expense-category-summary.integration.test.ts` owns category summaries beyond
25 linked lines, full money/read-back, and explicit transaction itemization policy
reset to the Purchase fallback with stored null and source provenance. The finance
browser journey keeps two refund lines for readable labels and read-only
explanations. Its per-entity enum reset is no longer sampled in a second document;
`inheritance.spec.ts` retains the real generic Use inherited interaction and
stored-mode readback. Use `openCellExplanation` when the runtime rail’s host
column has not been established; assessment placement does not identify every
derived-value explanation control.

The Wardrobe browser journeys retain ownership edits, grouped category navigation,
subtype inclusion and section exclusion. The mobile sticky-header coordinate
check is deliberately omitted: creating a scrolling inventory population solely
to assert header position costs a full browser journey for a presentation detail.
Shared responsive capabilities do not establish sticky behavior; verify that
visual detail during relevant layout work instead.

Purchase/Product relationship permutations belong in
`purchase-products.integration.test.ts`'s live-expense/explicit-evidence union case:
combined movement roles, deduplication, deleted-row handling, paging and both
relation directions. The phone relationship journey retains planned/explicit-link
presentation and Open all navigation, with its Vendor, brand, Product, Purchase
and future Expense committed as one prerequisite graph. The separate desktop
read-only role matrix is removed: it repeated those stored semantics and shared
rendering without a member write. Desktop combined-role and direct inverse-page
composition are deliberate browser coverage gaps; the phone route and real SQL
relation consumers remain.

Product ownership overviews keep the three movement states, ownership guidance
and their supporting sections. Build each acquired/exited state in one fixture
graph; uncertain ownership keeps its explicit Product link before the future
Expense. The visible Runs section covers composition without repeating an empty
report query and matching its copy for every ownership state.

Fast header pointer probes wait for the intended dnd-kit target announcement
before release; completion of mouse input alone does not establish that React
has processed drag-over. Keep the actual final header-order assertion.

The column-layout browser journey owns native header pointer/keyboard ordering,
locked edges, pointer pin transfer, downward customizer drag placement and
session reset. `table-layout-customizer.unit.test.tsx` and
`column-layout.unit.test.tsx` own shared visibility, pinning and structural
policy. Repeated per-route audit timestamp formatting and pin/unpin permutations
are omitted; the date composition journey retains the browser timestamp tooltip.
The removed pinned-order round trip no longer has a dedicated browser regression.

Purchase Email review retains dismissal across reload, replacement with a link,
Email original navigation and failed-preview evidence preservation. Vendor Email
link composition stays in `gmail.input-first-import.spec.ts`; the review journey
opens the Email directly from its Purchase row.

## Test and dev data factories

One layer builds data for Vitest, E2E, and the dev corpus:
`apps/web/tooling/factories/`. `buildEntity(entity, overrides, { faker })`
returns the entity's parsed create input (the entity list and types come from
the generated create schemas; `ENTITY_DEFAULTS` is exhaustive, so a new creatable
entity cannot skip it). `createEntity(context, ...)` writes it through the
entity kernel. A factory never defaults a relation id; pass it. E2E specs call
`createEntityFixture(page, entity, overrides)` from `tests/e2e/fixtures/core.ts`
and keep domain seeders in `tests/e2e/fixtures/*.ts`. `seedBaseWorld` seeds Home
and the taxonomy roots for every lane.

Faker fills only fields nothing asserts on, from a per-test seed (E2E title
path, Vitest test name via `testFaker()`, dev seed 1). A name a locator or
assertion uses is an override shaped `${label} ${deterministicToken(...)}`
(`uniqueName` in E2E); shortcodes come from `@cubby/shared` and UPCs are valid
literals, never Faker. E2E records the seed as a `faker-seed` annotation, and
`testFaker()` prints it when the test fails. Retailer corpora, statement CSVs,
costing and nutrition numbers, and scenario states stay literal. `build:cf`
fails if Faker reaches the Worker bundle.

When a create-dialog journey already knows its synthetic record name, scope the
background list with `searchQuery` while opening `?create=true`. Rendering the
unrelated corpus behind the dialog is not part of form, upload or capture
coverage. Keep filter and full-list composition checks in their owning journeys.

Keep kernel fixtures declaration-backed. The Drizzle v1 RC spike
(`git show fa514df72:docs/research/drizzle-v1-spike.md`) confirmed that
table-derived insert schemas omit virtual inputs and declaration-level defaults;
`drizzle-seed` generates foreign keys and writes directly to tables. Those are
storage-fixture capabilities, not replacements for `buildEntity`/`createEntity`.

### Migration rehearsals

Use `withMigrationDatabase` (`apps/web/tooling/test-database-lease.ts`) for
migration regressions. It owns an empty IntegreSQL lease, connection setup, and
cleanup on success or failure; the current-schema Vitest template cannot test a
predecessor. Use `migrationTags` and `migrateDatabase` from `tooling/db-migrate.ts`
to select and apply the committed boundaries. Keep predecessor-schema fixtures
and preservation assertions in the test; bootstrap credentials, database names,
and CREATE/DROP lifecycle belong to the shared lease infrastructure.

Rehearse from the actual deployed prefix through the canonical migration. Delete a migration's rehearsal once production has applied
it and its schema readback is verified; the invariants it guarded are then
held by domain write/readback tests (for example, source-claim-family tests own
invalid alias-family refusal, and fact-evidence-subject tests own canonical
Product/Purchase proof and idempotent preservation).

Provider discovery scenarios turn Mail import on and assert the exact targeted
queries paged, interleaved new-mail reads, and that completed coverage chains no
further pass.

Disclosure bodies mount only after opening. Explanation journeys open Technical details before asserting rule identifiers or descriptions; filter journeys use Clear all and drive inline presence controls directly. Table title subtitles can repeat category links, so scope category assertions to their declared column.

Optional nested form controls stay unmounted until requested: mounting a numeric controller can expand a null parent into an object and mark an untouched bulk field dirty. The bulk-edit checkbox journey retains the regression that unrelated fields must stay out of the write.

List sorting journeys click the named Sort by button; a column header also contains its menu trigger, so a center click can open the menu instead of sorting. Open Filters before clearing its active predicates.
