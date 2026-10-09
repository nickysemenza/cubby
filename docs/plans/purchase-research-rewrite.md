# Purchase import and Product research rewrite

Status: replacement and recovery/retention follow-ups shipped in #1767–#1774.
The approved preserving `0025_purchase_research` production cutover and schema
readback completed; do not apply it again. The sections below retain the settled
design and implementation record, not an unshipped migration worklist. Authorized
live research, full-history/new-mail acceptance and client verification remain
open. A terminal Run or populated fields do not establish research completion.
The [current simplification audit](research-simplification.md) owns the next
deletion/consolidation proposal; the canonical backlog is `docs/todos.md`.

Replace the purchase coordinator with a capable research agent using ordinary
mail, browser, web, and Cubby tools. The reference experience is interactive
Claude or Codex researching an order through Gmail and Chrome and writing
through Cubby MCP. Cubby owns evidence retention, domain writes, replay, and
recovery; the agent investigates unfamiliar sources and makes supported
identity judgments. Reuse the durable host where it earns its place.

## Agreed behavior

- Discover all retained Gmail history, including archives and unfamiliar
  vendors, excluding Spam and Trash. Prioritize known-vendor backfills and
  unmatched FinancialTransactions before the broad history scan. Scoped
  search completion does not advance mailbox-wide coverage.
- Jev routes messages as purchase-related, unrelated, or uncertain. Relevant
  and uncertain messages reach the research agent. Subject patterns and
  sender-domain lists do not exclude messages before content classification.
- Retain only message identity, classification/version, and processing status
  for unrelated mail. This applies to database rows, attachments, transcripts,
  caches, and logs; a durable agent transcript cannot become an incidental
  archive of rejected mail.
- Automatically create supported Vendors, Purchases, and Products and attach
  related emails. Cover actual acquisitions including services, food,
  subscriptions, and digital goods under the existing Product/expense rules.
- One message can concern several orders; one Purchase can have confirmation,
  shipment, delivery, cancellation, and refund sources. A Gmail thread is
  context, not an order identity.
- An identified real order may create an incomplete Purchase before
  itemization arrives. An evidenced item may create a Product with known
  facts before its exact catalog variant is established. Unknown facts remain
  absent; neither case fabricates Expense lines, prices, dates, or quantities.
  Check supported existing Product matches before creating a new one.
- Exact order references are the simplest email-linking evidence. A unique
  supported semantic match may also link automatically without an order ID.
  Sender, thread membership, model confidence, and amount/date coincidence
  alone do not establish a Purchase association or financial settlement.
- Automatically fill empty Product facts and record verification of matching
  existing values. Contradictory values, identity collisions, and financial
  reversals remain reviewable proposals. Preserve own images and chosen
  gallery/cover order.
- Retained visible content and selected-variant state can support claims.
  JSON-LD is one evidence representation, not a retailer eligibility rule.
  Every accepted claim needs source support and a purchased-item-to-variant
  connection. Quoting observed text alone does not prove that connection.
- Distinguish verified, partially verified, ambiguous, temporarily blocked,
  and researched with gaps. Execution ending is separate from goal success.
  Changed relevant evidence or capabilities can cause a new attempt; repeated
  identical failures pause. Settled historical targets remain immutable.
- Gmail and public-source work continue while the Mac is unavailable. Only
  work requiring its authenticated browser waits. Member sign-in and browser
  permissions remain recoverable interactions.
- Measure a pilot before setting the spending cap for the full live history
  launch. Synthetic validation and implementation can proceed first.
  The pilot has explicit purchase-candidate, Product-research and metered-API
  limits. Continuous new-mail discovery and automatic research have a separate
  monthly API cap. Operational approvals and configured amounts remain outside
  repository content.
  Luna/Sol use the connected ChatGPT subscription; unavailable subscription
  research waits for reconnect instead of silently switching to paid inference.
  Jev/Clef metered calls count toward the applicable cap. Full historical
  backfill remains disabled until the measured pilot is reviewed and its cap
  is separately approved.

## Replacement interface

Use general research capabilities and a few deep domain operations. The
following names illustrate responsibilities rather than prescribe final tool
names:

```text
mail.search / mail.read       Find original and related messages
web.search / web.read         Follow public sources and leads
browser.observe / browser.act Navigate, click, type, select, scroll, read
cubby.search / cubby.read     Compare current records and candidates

purchase.import              Import or improve a supported order
purchase.attachEvidence      Associate another supported source
product.verify               Add supported facts or verify existing facts
```

The host supplies a research objective, current records, original order-line
context, available capabilities, and server-issued source references. Source
reads retain evidence automatically within the authorized research scope.
The host owns command suspension, reconnects, operation identity, canonical
identifier sources, checkpoints, and mechanical progress. Domain operations
own transactional replay, live-record checks, identifier collisions, financial
conservation, and stock neutrality.

The agent follows leads and selects supported business decisions. It does not
issue a command, end a submission, read a result, bind that result, invent
source/operation identities, and ceremonially finish a run. Research context
can span related emails and product pages; task isolation must preserve that
capability. Purpose-appropriate tools exclude unrelated finance administration
and generic mutations.

Evaluate [Cloudflare Web Search API](https://developers.cloudflare.com/web-search/)
as an implementation of `web.search`. Its Worker binding routes to Ceramic,
Exa, or Linkup and returns URLs and excerpts. Public catalog discovery can use
it without a connected Mac. Search results provide leads; exact-variant claims
still require sufficient retained source support, and selected-state or
authenticated interaction still needs a browser. Keep search-provider quality
separate from the interface/capability comparison: pin the provider and supplied
results for that comparison, then measure provider retrieval quality and cost
on public synthetic catalog queries. Inspect gateway logging and provider
retention before live use; provider zero-retention claims do not establish
gateway settings. The service is currently open beta, so verify its live
contract when implementing the adapter.

Semantic validation must compare the purchased item, the observed selected
variant, and each claim. Deterministic checks enforce evidence ownership,
completeness, claim references, typed identifiers, contradictions, live record
revision, and images. Real-model validation evaluates the remaining semantic judgment;
confidence and arbitrary substring matches do not replace evidence.

## Evidence and lifecycle

Retained observations record immutable bytes/checksum, acquisition method,
requested and served URLs, capture time, completeness, and selected state.
Source references and identifier/image candidates are host-derived. Claims
record their value, supporting observations, purchased-variant relationship,
and disposition. Category selection derives from supported identity attributes
and existing taxonomy rather than requiring a literal category on a page.

Matching-value verification is a durable result even when no Product field
changes. Conflicting evidence remains inspectable beside the current value.
Refused commit inputs and reasons persist outside the transaction whose
business writes were refused. Retry identities distinguish replay of the same
decision from a corrected decision against retained evidence.

Keep existing Run, target, evidence, operation, source-claim, finding, and
approval primitives where their semantics fit. Storage must retain fact-level
support, which current scalar audit entries do not supply. Determine the
minimal declaration-derived fact-support representation during implementation;
use one shared representation rather than per-workflow provenance tables.
Source reuse needs explicit authorized associations, not copying or implicit
next-target binding. Interactive callers can share domain/evidence contracts
without driving the unattended Run protocol.

Mailbox acquisition has bounded pages and durable checkpoints. Persist the
baseline for incremental catch-up before history enumeration; keep broad
backfill coverage, scoped-query coverage, and Gmail history position distinct.
Catch up new mail while old history is still scanning. An expired history
cursor reports a recoverable error and preserves checkpoints. Recovery
enumeration needs separately authorized historical discovery; new-mail discovery
never silently starts a full-history scan. Apply Spam/Trash eligibility to fetched messages and label changes
as well as listing queries. Deleted messages and revoked authentication have
explicit outcomes; a classifier outage is not an unrelated-mail verdict.
Verify acquisition and model-provider logging/cache retention settings before
routing live mailbox content, including uncertain mail later judged unrelated.

Targeted objectives are ordinary research questions: find orders for a known
Vendor, find evidence for an existing charge, or improve an unresolved Product.
They share the message ledger and domain writes with broad discovery. Merchant
identity comes from supported source content and existing records, including
hosted/shared senders. Existing FinancialTransactions remain settlement
evidence; finding mail does not manufacture transactions or spend.

## Shared presentation

Use existing Activity, Run reports, entity details, field explanations, and
declaration-driven report commands/choices. Show outcomes and sources beside
Purchases and Products. Shared reports present the concrete proposed change,
support, conflict, and available action on web and Apple.

Data-quality exceptions describe accepted missing data; review proposals
describe a possible mutation; offline/authentication describes execution.
Preserve these distinctions while reusing presentation and commands. Research
not finding a fact does not silently create an accepted DataException. No new
Gmail, enrichment, or reconciliation workbench or generic job/review engine is
required.

## Research validation during implementation

Use the subscription-only purchase-decision acceptance path and synthetic fixtures. Pin the same
research model snapshot, effort, transport, aggregate token/time budget,
source fixtures, semantic validator, and acceptance rules for every arm.
Count all extraction and validation model calls in the aggregate budget.

Build the general researcher and deep shared writes directly. Use bounded
real-model checks to discover remaining capability/interface limits during
implementation; keep source fixtures and acceptance rules fixed when comparing
interface or browser changes. Do not ship a separate comparison platform or
delay the rewrite behind a reconstructed legacy-agent benchmark. Document any
unavoidable comparator differences rather than attributing them to interface
simplification.

Cover an ordinary Product, multiple variants, site search/selection, missing
JSON-LD, equal existing facts lacking provenance, identifier collision,
genuine ambiguity, cross-email/manufacturer research, and interruption/replay.
Add a small real-Jev corpus with unfamiliar/shared senders, attachment-only
receipts, irrelevant mail, and relevant messages without order references.
Truncated or unreadable input escalates instead of becoming a negative label.

Research validation must exercise mail-domain decisions as well as
Product research. Give these synthetic traces required outcomes and refusals:

- Uniquely supported association without an order reference links to the
  existing Purchase; competing supported candidates remain unresolved.
- An identified order with unknown date/itemization creates an incomplete
  Purchase without invented Expenses, then improves from later evidence.
- One message supports two distinct orders; both source associations survive
  replay without duplicate Purchases or Expenses.

Exercise the replacement domain boundary, with fixture answers kept outside
the model's context. Record existing-interface incompatibilities without
silently supplying semantic help. Evaluation-only storage adapters cannot
establish production write guarantees.

Also leave a native-browser request unresolved while an independent Gmail or
public-source objective reaches a supported result. Start public Product
research with no Mac connected. Reconnect afterward and require the native
objective to resume without duplicate writes. Include these traces in the
replacement acceptance; recovery alone does not prove independent cloud
progress. Choose the smallest hosting mechanism that passes,
without presupposing another scheduler or parallel-agent framework.

Measure supported facts, wrong-variant/unsupported accepted facts, retained
provenance, false negatives and triage escalation, interventions, model turns,
tool calls, completion time, and cost per verified result. Any unsupported
accepted fact or ownership violation fails acceptance. Positive cases must
produce supported results; all-skipped runs cannot pass. Real models establish
research behavior; deterministic harnesses establish financial, ownership,
write-fence, and recovery guarantees. Reuse the current harness rather than
building an evaluation platform.

## Vertical slices and deletion

Implement complete vertical slices within one breaking-change PR against main.
Each slice updates all affected contracts/clients and its owning docs, removes
the replaced path, and has a complete acceptance scenario. The PR becomes ready
only when the full replacement and deletion inventory are complete.

| Slice                          | Complete behavior                                                                                                                                                          | Replacements and removals                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research validation            | Real models interpret synthetic sources and make supported decisions through the replacement boundaries                                                                    | Reuse billed evaluation support; no standalone experiment platform or production rerouting before the replacement is ready                                                                  |
| Product research               | A targeted Product objective obtains explicitly scoped observations, verifies new/equal facts, and exposes retained provenance on web/Apple with durable recovery          | Replace enrichment choreography, bare scalar writes, implicit capture targeting, model source/operation IDs, ceremonial finish, permanent skip suppression, and inline enrichment twins     |
| Mail to Purchase               | Related messages identify/import an order and link further evidence, including incomplete orders and supported matches without IDs; Product research follows automatically | Replace sender/subject exclusion, fixed confirmation-only agent workflow, per-vendor auto-import ceiling, and mail-specific review presentation; preserve historical link/dismiss decisions |
| Coverage and targeted backfill | Known-vendor/charge research and whole-history enumeration reuse prior messages, recover interrupted pages/authentication, and keep new mail flowing                       | Replace gather-all-ID listing, date-limited recovery, vendor-specific search-job choreography, and unconditional retention of unrelated bodies/attachments                                  |
| Cutover and live acceptance    | Supported mail import, browser observation, Product verification, visible provenance, deployment/readback, and authorized backlog completion                               | Remove remaining purchase coordinator policy duplicates; supersede contradictory skill text and architecture TODOs                                                                          |

The removed `gmail/import.integration.test.ts` exercised the replaced
claim/prepare/finish controller. Its surviving contracts have replacement
coverage:

| Preserved contract                                                                                                               | Replacement coverage                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Retained sources, member ownership, checksums, overlapping selections and dispatch replay                                        | `research-run.integration.test.ts`, `research-legacy-mail.integration.test.ts`, `gmail/manual-research.integration.test.ts`             |
| Money conservation, replay, unknown dates, multiple orders and stock neutrality                                                  | `research-orders.integration.test.ts`, `research-import.integration.test.ts`, shared writer and financial-settlement regressions        |
| Expense-only shared-SKU lines, differently titled exact-variant lines, order-line URLs and missed post-commit research admission | The named shared-SKU/missed-admission case in `research-orders.integration.test.ts` passes through the real writer and discovery sweep  |
| Every selected message continues after ambiguity; final unresolved work reports review rather than success                       | The named selected-mail case in `research-service.integration.test.ts` resolves both real tasks through the retained-operation boundary |
| Preview and launch use the same permitted browser account                                                                        | The named preview/launch regression in `run-target.integration.test.ts`                                                                 |
| Public research without a Mac, racing admissions, changed-context retries and provenance for populated facts                     | `product-research-run.integration.test.ts`, `enrichment-sweep.integration.test.ts`, `research-product.integration.test.ts`              |
| Discovery pagination, interruption, authentication and durable handoff                                                           | `gmail/discovery.integration.test.ts` and Worker acceptance                                                                             |

Mail presentation uses the same report records and commands on web and Apple.
The retained source can appear on several Vendors through accepted Purchase
associations; a nullable ingestion hint does not hide those associations or
become a single-Vendor assignment. Current checksums, earlier human decisions,
original links and actual research outcomes remain distinct.

The inline `post-import-autofill` path and its probability/budget policy are
removed. Its domain contracts have stronger retained-evidence coverage:

| Removed inline regression                                                        | Retained replacement                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fill only supported gaps; preserve a member value set during interpretation      | Product research's populated-contradiction and independent-supported-fact cases; live rows are reread under the commit lock                                                           |
| Ingredient linking assigns Food and preserves inherited Food classification      | Product research's unclassified-Ingredient and inherited-Food replay cases, including proof only for accepted claims                                                                  |
| Member non-Food classification refuses Ingredient without discarding other facts | Product research's member non-Food/refused-Ingredient case                                                                                                                            |
| Fill an empty Purchase purpose and preserve a member's purpose                   | Retained-mail research's original-order-index, matching-purpose, contradiction and repeated-Purchase operand cases                                                                    |
| Purchase purpose must not silently affect linked Expense policy                  | “records supported source purposes without changing existing Expense classification” verifies the ordinary `source` origin contract, retained proof, Product link and conserved spend |

The old four-second suggestion deadline is not a retained domain contract.
Research is durable work; task/Run execution fences, operation receipts and
retirement races govern whether an interrupted or late operation may write.
No detached suggestion continues changing records after an inline import call.

| Preserved presentation or admission regression                                            | Named replacement                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accepted multi-Vendor source with a null hint, including an absent original timestamp     | `gmail/review.integration.test.ts`: “shows accepted multiVendor mail with no vendor hint on each related Vendor and Purchase”                                                  |
| Human links without a Vendor hint and unchanged source/member/retirement fences           | `gmail/review.integration.test.ts`: “links a member reviewed retained original without requiring a vendor hint”, plus its retained source-before-Purchase and retirement cases |
| Shipment without an order ID and every returned research Run link                         | `mail-report-commands.unit.test.tsx`: “researches a shipment without an order ID and links every server-created Run”                                                           |
| Declared command operands must be supplied before mutation                                | `report-commands.unit.test.tsx`: “collects declared report command inputs before dispatching their exact operand”                                                              |
| Historical dismiss/link interaction and original navigation on Purchase                   | `vendor-order-mail-review.spec.ts`: “reviews a vendor email match through the generic report and shows the linked original on Purchase”                                        |
| Cloud Vendor admission without a website or browser account                               | `vendor-order-mail-review.spec.ts`: “launches cloud Vendor purchase research from the generic report without a website or account”                                             |
| Saved original, stale checksum refusal, live Run, persisted Purchase and source ownership | `purchase-import-run.spec.ts`: “imports saved order mail from the generic Vendor report and follows the live Run to the committed Purchase”                                    |
| Several originals in one Run with a separate task and exact source association for each   | `purchase-import-run.spec.ts`: “admits several retained confirmations as separate tasks in the same research Run”                                                              |

The deleted `order-mail-worklist.unit.test.tsx` had two named cases: missing
original timestamp and a no-ID shipment returning several Runs. The null-hint
projection regression preserves its Unknown date/no-epoch assertions, and the
generic mail command regression preserves its exact input and every Run link;
both replacement checks passed before deletion.

The four search-engine E2E cases for failure diagnostics, live summary,
retry/cancel and full-page progress remain until their named generic-runtime
replacements pass. Authored browser replacements and focused projection checks
are not a claim of completed browser or native acceptance.

Confirmation-only import, same-vendor selection, mandatory Mac/domain access,
mail-arrival dates as purchase dates, permanent skips and fixed retry ceilings
were obsolete expectations, not preserved contracts. The Product research and
shared purchase skills now describe the replacement; the old purchase
`references/run-workflow.md` has been deleted. These test migrations do not
establish final current-source E2E or client acceptance.

Core owning files: `server/purchase-agent/{run-agent,tools,environment,
import-run-workflows}.ts`; `server/purchase-import/{run-service,import-orders,
structured-products,structured-identifier-proof,browser-results,
enrichment-sweep,targeted-run}.ts`; `server/purchase-import/gmail/`; shared
purchase/agent contracts and child-table declarations; generic entity/report
projections; `CubbyKit/PurchaseImport/` and native browser controller code.
Generated clients derive from shared contracts. A native wire break bumps
`APPLE_CLIENT_COMPATIBILITY_VERSION` and ships every client together.

Preserve the deterministic order writer's guarantees while replacing its
incompatible complete-order, required-date, and single-Purchase source-replay
assumptions. Keep money rules, identifier registry and
ownership handling, source checksums, transactional operation replay, image
integrity/cleanup, Google authorization/normalization, useful capture parsing,
and useful pi-durable/broker hosting. Preserve clickable account-row/order-label
coverage, browsing-account parity, proof-refusal/corrected-retry coverage, and
reconnect/terminal-state regressions through the new interface. Removing old
tests requires retaining their named failure in stronger coverage.

Historical mail source conversion preserves every original claim UUID, textual
key, order/payment owner and prepared extraction. Verified per-order identities
become direct aliases of a separate canonical root. Existing aliases participate
in whole-family collision/ownership checks; candidate roots with incoming aliases
remain blocked instead of creating chains. Acquisition advances current original
and root checksums atomically, while accepted order snapshots retain their own
versions. Shared readers expose that distinction, and routing/provider removal
cannot clear unresolved ownership. These source contracts have focused regression
coverage; full cutover rehearsal, client acceptance and final reviews remain
required before production approval.

Receipt submission also supports a stopped unresolved historical receipt whose
Run has no typed input: derive the new objective from the owned hunt, charge and
finalized original, preserve old evidence/tasks, and atomically transfer the
hunt's active Run reference. Replay reuses that new admission; unknown attempt
counts remain unknown. Public retry/restart now connects this receipt conversion
and current frozen account/charge/receipt objectives to fresh admission, with
new task references and stable successor/dispatch replay. Historical Product
continuation now derives a validated Product-only saved roster and preserves
skipped unresolved work, refreshed context, nullable attempts and stopped-child
replay. Historical mail selections now prove the complete event/order/checksum
and candidate roster before carrying unresolved originals into source-only
research admission. Multi-mailbox selections preserve each original's mailbox;
repeated provider message IDs cannot alias ownership. Eight historical-mail
regressions pass, including changed checksum, supersession, mismatched order ID
and incomplete-candidate refusal, ledgerless-original admission and settled
covered-candidate preservation. The nine mailbox-search cases also pass: fresh
investigations can select another owned mailbox, while pagination and interrupted
search replay keep exact task/query/account scope. Historical backfills now
preserve their saved date range without substituting today's account cursor.
Selected-charge conversion validates the whole saved Hunt roster and financial
ownership, preserves consistent retained claim amount/range observations, and
freezes current owned context only for unvisited Hunts. Missing historical
merchant/date facts stay unknown. Contradictory claims and unprovable plain
account-walk boundaries refuse conversion. Seven historical-objective cases
and the affected objective, continuation, retirement and race suites pass
55 cases. A follow-up public conversion → failed child → retry regression
preserves all three additional unresolved charge states through their shared
eligibility policy; it and retirement continuation pass 27 cases. Scoped Astra
review found the prior retry blocker resolved. Purchase validation now uses
fresh typed tasks for public launch and retry, with retained-original selection,
cloud execution, explicit missing-evidence state, and member-reviewed financial
corrections. Its preview shares canonical-source freshness and optional owned
browser transport with admission. Purchase validation and retirement continuation
pass 35 focused cases, including disposed-source transfer with known and unknown
attempt counts. Ordinary
controls take account admission before
Run locks. Ordinary and retirement-authorized objective successors now share
account and sorted-hunt locking before predecessor/task/image locks; real
contention regressions cover blocked account and receipt-hunt admission. The
combined continuation, retirement and receipt suites pass 57 cases, including
allocated-receipt exclusion, incomplete-roster refusal, and stopped-successor
replay after account changes. The actual cleanup boundary refuses missing
rosters rather than treating them as exhausted, and receipt-replacement races
reuse the existing owned child without replacing its original.
Existing children replay after receipt/member
authority but before mutable-source checks; fresh children share the ordinary
financial ownership/eligibility fence. Replacement
receipt evidence preserves the original discovery parent and nullable attempts.
Listing and admission use the same financial-account ownership boundary. Missing
transaction dates remain unknown across the shared API and native picker;
manual photo selection stays available without inventing a nearby-photo window.

The separately owned MCP-only caller-driven enrichment/server capture work
shares the evidence/write seam. It owns its caller transport and launch mode;
this change supplies no parallel implementation. `repo/spending-classification-review.ts`
and the MCP HTTP handler remain outside scope.

## Delivery and acceptance

The main Sol agent owns architecture, schema/data transforms, core
implementation, integration, and final validation in the target checkout.
The user's explicit Luna/Sol selection supersedes the normal Opus delegation
lane: use Sol for consequential implementation and Luna for bounded mechanical
work, with disjoint files and focused checks.
Every PR receives an independent T3 Codex Sol/high review; production migration
or major infrastructure PRs additionally receive Astra/high. Fable/high
resolves material implementation/review disagreements. Reviewers reuse valid
validation evidence; the main agent owns any broad gate.

Write plausible failures and failing regressions before implementation. The
primary system acceptance is synthetic mail -> new Product -> automatic
research -> browser observation -> supported commit -> provenance visible on
the Product, plus a subsequent shipment linked to the same Purchase. Cover
source-before-record and record-before-source, partial records improved later,
multi-order mail, wrong variants, identifier collisions, equal-value support,
contradictions, own-photo priority, auth/offline interruptions, stale writes,
and replay without duplicated Expenses or stock changes.

Every completed E2E run retains the required sanitized revision/replay/results/
checksums bundle. Before merge, hosted applicable checks must pass on the exact
final head. Review/CI ownership and affected local checks follow
`docs/agents/validation.md`.

Production schema changes and cleanup require explicit approval of a concrete
lossless transform, existing-reference checks, and readback plan. Preserve
historical Runs, captures, source claims, decisions, and money. Retire old
writers/readers before contract drops and handle in-flight durable conversations
explicitly; new attempts do not reopen old settled targets.

Legacy automatic classification/checksum markers do not establish completion
under the replacement classifier/research version. Reprocess eligible unchanged
messages as needed while preserving explicit historical human link/dismiss
decisions and existing domain associations. Cutover acceptance includes an
unchanged previously processed message becoming actionable under the new
policy, with those human decisions and associations intact.

After deployment, verify persisted supported outcomes through the actual
model/browser path, then complete the authorized live backlog through new
attempts. Reconcile the requested-versus-selected target count before claiming
completion. Report verified facts, research gaps, failures, and every check or
deployment boundary that remains unverified.
