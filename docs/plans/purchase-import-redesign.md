# Purchase import redesign

Status: plan, revised after one adversarial Fable review against the checkout
(2026-09-18). Every decision was put to the operator and confirmed unless
marked **assumption**. Review findings that changed the design are noted
inline as *(review)*.

## 1. Summary

Today a purchase import is a Claude Code / Codex session driving Chrome page by
page, reading each order page into model context, hand-writing ~10 MCP
mutations per order, then opening product pages one at a time for images.
Measured in `docs/todos.md`: ~150 tool calls per 16 orders are mechanical, ~20
are judgment. The redesign moves everything without a decision into code, makes
every remaining line-level decision a closed-set choice on the decision tier
(Jev), spends one high-effort reasoning call per batch on *auditing* the
assembled result, and reaches a human only for corrections.

```text
Gmail (per member, hourly cron) ─discovers order ids──────────┐
Mac app (drives the member's own Chrome/Safari) ─fetches──────┤
                                                              ▼
   Flue agent, one per VendorAccount (SQLite Durable Object)
     └─ tool: cubby.import_order_page
          capture → fast-tier extract (+ sum-check as validate) →
          PDF attach → import_vendor_orders (writer) → Jev identity
     └─ auditor (reasoning tier, high effort, ≤25 orders) → ImportFinding
                                                              ▼
   Problems page (`importFindings` key): wrong product, sum mismatch,
   arrived — receive?, sign-in needed, unclassified vendor.
   Humans apply, dismiss, or receive.
```

Goals: near-zero human involvement for known vendors; token cost on the order
of a cent or two per order; Rebecca's full Amazon history backfilled; every
fetched order carries its primary document; no layout-specific extractors.

Non-goals: automatic receiving into inventory (never); server-side vendor
sessions or cookies (never); rejecting or back-computing anything from
`statedTotal` (tenet 5); multi-user coordination beyond per-member ownership;
shipment modelling; push notification infrastructure; a generic AI-proposal
store.

## 2. Decision log

| # | Decision | Choice |
|---|---|---|
| 1 | What "assigned to a user" means | The vendor **login** (`VendorAccount` owned by a `LedgerParty`). Purchaser is *derived on read*, never stored *(review: a third stored "who" beside `FinancialAccount.ledgerPartyId` and `ExpenseAttribution` was redundant)*. |
| 2 | Device identity | Real member auth: better-auth user ↔ `LedgerParty.userId`. |
| 3 | Rebecca's client | She runs the Mac app. |
| 4 | Discovery | Charge-driven: a statement charge at an `online_account` vendor is *something to hunt*; a server-side Gmail pull (per member mailbox, history-based, hourly cron) resolves its order id and event stream; the browser then fetches that one order by `orderUrlTemplate`. The orders-list walk is only for backfill and vendors with no email senders. |
| 5 | Automation scope | Everything automatic except receiving. |
| 6 | Auditor autonomy | Applies reversible relinks/reclassifies only, and only on rows written by the same run; everything else is an open finding with the fix attached. |
| 7 | Exception surface | Problems page is the source of truth; the Mac app posts one local notification per run with a count. No APNs *(review: none exists)*. |
| 8 | Vendor scope | Generic, all vendors. `Vendor.orderEvidence` drives expectations. |
| 9 | Backfill | Yes, paced, newest-first; Rebecca's history jump-started from an Amazon export via the MCP client. |
| 10 | Enrichment fetching | Same client, same worklist protocol, second phase. |
| 11 | Vendor challenge | Human solves it in their real browser; agent pauses. |
| 12 | Purchaser | Derived: account owner → card owner → null. No column. |
| 13 | Session ownership | Strict everywhere: a VendorAccount is only driven from a Mac signed in as its owner, and an MCP write naming a `vendorAccountId` must come from that owner's OAuth session (`@better-auth/oauth-provider` already ties every MCP call to a `user.id`). Rebecca runs her own one-off imports. |
| 14 | Vendor evidence flag | `orderEvidence: online_account \| receipt_only \| not_expected \| null`; `null` behaves as `online_account` until classified. A one-time classification pass uses Jev `vendor-evidence-suggest` (name, website, charge descriptors, presence of order mail): high-probability values auto-apply, the rest are one batch review. Expectation checks are *derived* Problems detectors: an `online_account` charge whose hunt (decision 47) failed; a `receipt_only` charge without a document. |
| 15 | Receiving | Never automatic. "All shipments delivered" (read off the order page) files an `arrived` finding once per Purchase; the human receives through the existing flow. No delivery column. |
| 16 | Existing lines | If the Purchase's live Expenses are exactly one unlinked `principal` row whose cost equals the extracted lines' sum, the writer replaces it with the lines, carrying the aggregate's title, `costType`, trade, and project onto them (the skill's snapshot rule). Any other shape — a linked row, a partial split, a sum that disagrees — writes **no lines** and files `duplicate_lines` with the extracted lines for review *(review: plain "fill gaps" would double-count)*. Populated header fields are never overwritten. |
| 17 | Extraction | AI extraction (fast tier) from capped captured text + links + image srcs. No coded extractors. Navigation is agentic with cached hints. |
| 18 | Mac app lifetime | Runs only while the app is open. |
| 19 | Backfill pacing | ~20–30 orders/hour, newest first. |
| 20 | The Markdown skill | Splits: invariants → code; judgment → agent skill + auditor prompt; mechanics → capture tool. The settlement/statement/Monarch half of the skill is untouched. |
| 21 | Capture payload | Readable text (capped) + product links + image srcs. Screenshot always taken, only sent to the repair feature. |
| 22 | Primary document | Order page rendered to PDF and attached with `documentKind: "order_confirmation"`, which *is* the primary document today. Screenshot attached as `other`. |
| 23 | Sum mismatch | Lines must equal the page's grand total to the cent **to be emitted by extraction**; after one repair turn still fails, the Purchase is created with its PDF, **one productless `principal` Expense at the page's printed grand total** (page evidence, not a rollup of `statedTotal`), and a `sum_mismatch` finding carrying the extracted lines. Spend is right immediately; lines arrive when the finding is applied. The writer never refuses on `statedTotal` *(review: tenet 5)*. |
| 24 | Vendor learning | Agent caches hints on the Vendor; hints are advisory and rediscovered on failure. First-time learning may also be a Claude Code + Chrome MCP session. |
| 25 | Delivered signal | Read from the order page; `arrived` finding only when all shipments show delivered. |
| 26 | Agentic loop | Yes: a Flue agent per VendorAccount with coarse tools. |
| 27 | Browser | The member's real Chrome (default) or Safari via Apple Events, tabs in a dedicated background window. |
| 28 | Agent granularity | Long-lived agent per VendorAccount, one run at a time; in-flight state in the DO, durable state in Postgres. |
| 29 | Model tiers | Fast tier drives and extracts; Jev decides; reasoning tier at high effort audits and repairs. |
| 30 | Browser offline | Pause instantly on socket drop, auto-resume on reconnect, nag after 24 h. |
| 31 | Run triggers | Browser runs: Mac app foreground with a browser available, a non-empty worklist (hunts from charges or Gmail), manual "Sync now". Gmail polling and charge matching run on an hourly cron *(review: Workflows do not self-schedule)*. |
| 32 | Prompts | In-repo under `apps/web/src/server/agents/purchase-import/`, versioned like features, with an offline eval. |
| 33 | Loop implementation | Flue, gated on a spike with the definition of done in §8.1. Fallback: Agents SDK primitives. |
| 34 | Browser bridge tools | `navigate`, `evaluate`, `capture`, `screenshot`, `pdf`, `tabs`. |
| 35 | Auditor batching | Per run; per ≤25 orders during backfill; input is the rendered import only. |
| 36 | `ImportRun` | A plain table (not an entity): one row per run, `Purchase.importRunId`; cost is `SUM(AiUsage)` by job id, never stored. |
| 37 | Pause semantics | As 30. Status lives on `VendorAccount` only. |
| 38 | Findings | `ImportFinding`, a plain table surfaced through a new `importFindings` Problems key *(review: Problems is a key registry with detectors; no abstraction needed)*. |
| 39 | Gmail grant | Per member via better-auth's Google provider (`linkSocial`, `gmail.readonly`, offline access); refresh token in better-auth's `account` row; `historyId` on our side. |
| 40 | UI split | Web: VendorAccounts, runs, hints, findings. Mac app: status line, "Sync now", browser choice. |
| 41 | Currency | Lines are written at the USD figure the page shows; a page with no USD figure gets a `foreign_currency` finding and no lines. Nothing is scaled from `statedTotal` or held for settlement *(review: tenet 5)*. Further handling is deferred until the first such order exists. |
| 42 | Dedupe key | The existing `Purchase.orderId` + `Purchase_vendorId_orderId_key`; `vendorAccountId` is an attribute *(review)*. |
| 43 | Shortcode prefixes | 2–5 letters (§10 item 0). `VendorAccount` is `VACCT-`; `ImportRun`/`ImportFinding` have no shortcode. |
| 44 | Completeness | Every entity gets a 0–100 completeness score derived from its data-quality checks, each check weighted and carrying an `expectedIf` predicate; a Purchase at a `receipt_only` vendor is complete at amount + project + date, one at an `online_account` vendor is not complete without lines. Generalises today's `complete \| needs_data \| defect` (§10 item 2). |
| 45 | "Tried, not available" | A data exception with reason `history_expired` (or `unavailable`) on `empty_expenses` / `primary_document`. The agent sets it automatically for orders older than the earliest order the vendor still shows; a human can set it from the Purchase. |
| 46 | Exception staleness | **All** data exceptions are fingerprinted on the inputs their check reads (live expense count, document set, `orderId`, …) instead of the row's `updatedAt`: an exception is valid while the check's inputs are unchanged. Reasons stay mandatory and typed as today. |
| 47 | Hunt | A charge at an `online_account` vendor with no allocated Purchase opens a hunt: Gmail match (sender, date window, amount) → order id → targeted browser fetch. No email match → on the next run the browser walks the orders list bounded to the charge date ±7 days → still nothing → `expected order not found` Problem. |
| 48 | Hunt routing | The charge routes by `FinancialAccount.ledgerPartyId` to that member's VendorAccount. The Gmail step runs server-side immediately, so the order id is known before the owner's Mac appears; only the fetch waits for their session. |

## 3. Domain model changes

Migrations follow `docs/agents/domain-rules.md`. CHECK constraints are not
diffed by `db:push`; §8.2 lists the hand-applied ALTERs.

### 3.1 `LedgerParty.userId`

Nullable text FK to better-auth `user.id` (`auth.schema.ts`, so the reference
is `(): AnyPgColumn =>` across modules), unique, CHECK `userId IS NULL OR kind
= 'member'`.

### 3.2 `VendorAccount` (entity, `VACCT-`)

| column | notes |
|---|---|
| `vendorId` | FK Vendor |
| `ledgerPartyId` | FK LedgerParty (member); the owner |
| `label` | e.g. "Nicky's Amazon" |
| `cursor` | JSON `{ newestOrderAt, orderIdsOnNewestDate[], backfillBeforeOrderAt, earliestAvailableOrderAt }` — order ids are not monotonic, so the cursor is a date plus the ids already seen on it; `earliestAvailableOrderAt` is the oldest order the site still shows, which bounds what backfill can ever recover |
| `status` | `active \| paused_auth \| paused_offline \| disabled` — the only run status |
| `lastRunAt`, `lastSuccessAt` | |

Unique on `(vendorId, ledgerPartyId)` where not deleted. Full entity work per
`docs/entities.md` "Adding an entity": declaration, branded id, kernel
adapter, incoming-edge dispositions for Vendor and LedgerParty,
`EXPECTED_EDGE_COUNT`, `pnpm generate`, Swift catalog mirror,
`generate-openapi.sh` + `xcodegen generate`.

### 3.3 `Vendor` additions

| column | notes |
|---|---|
| `orderEvidence` | `online_account \| receipt_only \| not_expected \| null` |
| `orderEmailSenders` | text[] used by discovery |
| `agentHints` | JSON the agent writes: orders-list URL, pagination shape, order-link pattern, notes. Detail URLs come from the existing `Vendor.orderUrlTemplate`; hints never store a second template. |

### 3.4 `Purchase` additions

| column | notes |
|---|---|
| `vendorAccountId` | nullable FK; set on every fetched or export-imported order |
| `importRunId` | nullable FK to `ImportRun` |

No import state column: a Purchase either has lines or has an open finding.
Purchaser is exposed on read as account owner → card owner (via the allocated
transaction's `FinancialAccount.ledgerPartyId`) → null.

### 3.5 `ImportRun` (table)

`id`, `vendorAccountId`, `trigger` (`foreground \| discovery \| manual \|
backfill`), `startedAt`, `endedAt`, counts (`ordersSeen`, `imported`,
`updated`, `skipped`), `agentSessionId`. No status column; "running" is
`endedAt IS NULL`, and `finish_run` is idempotent so a resumed run closes the
same row. Cost is `SUM(AiUsage.costUsd) WHERE jobKind = 'import_run' AND jobId = id`.

### 3.6 `ImportFinding` (table)

`id`, `importRunId`, exclusive-arc target (`purchaseId` / `expenseId` /
`productId`; CHECK exactly one non-null, same shape as
`LedgerSourceClaim_owner_check`), `kind` (`wrong_product \| duplicate_product
\| sum_mismatch \| duplicate_lines \| foreign_currency \| reversal_kind \|
missing_line \| kit_double_booked \| variant_doubt \| arrived \| other`),
`summary`, `proposedFix` (entity-kernel commands, JSON), `autoApplied`,
`probability`, `status` (`open \| applied \| dismissed`), `resolvedAt`,
`resolvedByUserId`. Partial unique on `(purchaseId, kind)` where `status =
'open'` so `arrived` and `sum_mismatch` file once, not once per run.

### 3.7 `AiUsage.jobKind` / `AiUsage.jobId`

Untyped pair (telemetry may dangle), threaded through `AiRunContext`,
`GatewayMetadata`, `jev.ts`, the versioned telemetry queue event, and the
consumer in `repo/telemetry.ts`. Import runs are one `jobKind`.

### 3.8 `MailboxCursor` and `OrderMail` (tables)

`MailboxCursor`: `ledgerPartyId`, `provider = 'gmail'`, `historyId`,
`lastPolledAt`. Tokens live in better-auth's `account` table.

`OrderMail`: `ledgerPartyId`, `vendorId`, `orderId`, `amount`, `event`,
`messageId` (unique), `receivedAt`. The parsed, deduplicated event stream
that hunts and the delivered/refunded signals read; never money.

### 3.9 Documents

Fetched order pages attach through the existing purchase document path with
`documentKind: "order_confirmation"` (already primary) using the server-side
`sourceUrl` path and `Image_attachment_idempotency_key` so reruns do not
duplicate; the screenshot attaches as `other`.

## 4. Components

### 4.1 Mac app: browser bridge

- Drives the member's real browser via Apple Events: Chrome `execute
  javascript` or Safari `do JavaScript`. Requires the browser's "Allow
  JavaScript from Apple Events" toggle and the
  `com.apple.security.automation.apple-events` entitlement +
  `NSAppleEventsUsageDescription`. Sandbox stays on.
- Opens a dedicated "Cubby" browser window kept behind the front window.
- **Socket.** Connects to `GET /api/import/agent/socket?vendorAccount=VACCT-…`
  (a normal route, not a dot-directory) with the better-auth bearer token. The
  Worker resolves the session, maps `user.id → LedgerParty.userId →
  VendorAccount.ledgerPartyId`, rejects a non-owner with 403 before the
  upgrade, then forwards to the DO, which `acceptWebSocket`s and stores
  `{ partyId, vendorAccountId }` via `serializeAttachment` because in-memory
  state does not survive hibernation. Long-poll REST fallback on the OpenAPI
  client.
- Executes six tools: `navigate(url)`, `evaluate(js)`, `capture()` →
  `{ text, links[], images[] }` with text capped at 24 KB and links/images
  limited to product-shaped hrefs, `screenshot()`, `pdf()`, `tabs()`.
- Paces requests; reports `auth_required` on a sign-in or challenge page,
  raises the window and posts a local notification.
- UI: per-account status line, "Sync now", browser choice.
- Shared code in `CubbyKit` (`BrowserBridge` protocol; Apple Events executor
  on macOS, `WKWebView` executor stub for iOS later).

### 4.2 Server: VendorAccount agent (Flue)

One SQLite-backed Durable Object per VendorAccount: `new_sqlite_classes` +
`migrations` block in `wrangler.jsonc`, exported from `cf-server.ts`, Postgres
via `withRequestDbClient(env.HYPERDRIVE.connectionString, …)` as the existing
DOs do. Skill file = the judgment half of the current skill. Tools:

| tool | executes | notes |
|---|---|---|
| `browser.*` (six) | on the Mac over the socket | blocking; the agent pauses when no socket is attached |
| `cubby.import_order_page(orderId, capture)` | server | extract (+validate) → PDF attach → writer → Jev; returns one line |
| `cubby.list_known_orders(vendorAccountId, since)` | server | so the agent stops at the cursor |
| `cubby.save_hints(patch)` | server | writes `Vendor.agentHints` |
| `cubby.finish_run(summary)` | server | closes the `ImportRun` (idempotent), triggers the auditor |
| `cubby.mark_history_expired(vendorAccountId, earliestAvailableOrderAt)` | server | records the bound on the cursor and sets `history_expired` exceptions on `empty_expenses` / `primary_document` for this account's Purchases dated before it that have neither; never touches a Purchase that has lines or a document |

The DO's worklist has three sources, in priority order: **hunts** (a charge
resolved to an order id by Gmail, or an unresolved charge with a date window
to walk), **events** (shipped/delivered/refunded emails for known orders),
and the **cursor walk** (backfill, or vendors with no email senders). Items
are not Purchases until lines exist; the hourly cron re-derives them if the
DO was evicted.

### 4.3 Server: extraction features

Two features *(review: `runStructuredFeature` cannot switch tier mid-run)*:

- `vendor-order-extract` — fast tier, `cache: false` (page text is unique),
  structured output = the writer payload: header (`orderId`, date,
  `statedTotal`, currency as shown), lines (`name`, `qty`, `unitPrice`,
  `extended`, external ids from hrefs, `imageUrl`, `seller`), adjustments
  (`lineKind`, amount), shipment states, refund/return events. The sum-check
  runs as its `validate` hook, buying the one repair turn the runtime allows.
- `vendor-order-repair` — reasoning tier with the screenshot, invoked once
  when extraction still fails validation; its failure yields a `sum_mismatch`
  finding with the PDF.

### 4.4 Server: `import_vendor_orders` (writer)

A workflow service with its own `withTransaction`, also an MCP tool. Accepts
`{ vendorAccountId, orders: [...] }` from any client. Per order:

- the caller's session must own `vendorAccountId` (agent socket or MCP
  OAuth user → `LedgerParty.userId`);
- `findOrCreatePurchase` on `(vendorId, orderId)`; set `vendorAccountId`,
  `importRunId`; never overwrite populated header fields;
- existing lines (decision 16): exactly one unlinked `principal` Expense
  equal to the lines' sum → replace it, carrying its title, `costType`,
  trade, and project onto every line; any other shape → write no lines, file
  `duplicate_lines` with the extracted lines in `proposedFix`;
- sum mismatch (decision 23): one productless `principal` at the page's
  printed grand total plus a `sum_mismatch` finding; no lines;
- typed `lineKind` on every row; no inference;
- signed `productQuantity`, direction from cost; `null` on concessions;
- allocation rows never carry a `productId`;
- Jev order per line: `expense-line-role` → `kit-detection` →
  `product-line-identity` → `product-promotion` → `reversal-kind` (negative
  lines only);
- identity: exact external-id hit → link; else shortlist of ≤20
  (`resolve_products` + collisions + name/model search) rendered as short
  labels → Jev; `probability ≥ 0.85` link, `< 0.6` create, between → create
  and file `variant_doubt`;
- image: server-side `sourceUrl` attach with the idempotency key;
- `statedTotal` is stored as the header cue and never used to reject or scale.

Returns per order:
`{ purchaseId, wroteLines, findings[], lines: [{ expenseId, productId, decision, probability }] }`.

### 4.5 Jev features

| feature | choice set | cap |
|---|---|---|
| `product-line-identity` | shortlist ∪ `none` | 20 labels |
| `expense-line-role` | the seven `lineKind`s | |
| `product-promotion` | `promote \| coarse_only` | |
| `reversal-kind` | `return \| concession \| cancellation \| replacement` | |
| `charge-purchase-match` | open Purchases ±7 days, ±0 amount first | 30 labels |
| `product-image-pick` | candidate images as `#n WxH alt…` labels, never URLs | 12 |
| `kit-detection` | `kit_with_components \| single \| n_pack` | |
| `order-mail-classify` | `order_mail \| not_order_mail` | |
| `charge-mail-match` | candidate order mails in the charge's date window ∪ `none` (tie-break after sender + amount filtering) | 20 labels |
| `vendor-evidence-suggest` | `online_account \| receipt_only \| not_expected` | |
| `product-category-suggestion` | existing | |

Every request stays under Jev's 32 000-byte cap by construction (labels, not
payloads). All register in `AI_FEATURES` with versioned prompts. Thresholds
use the raw probability exposed by §10 item 5.

### 4.6 Server: auditor

`purchase-import-audit`, reasoning tier, adaptive thinking, high effort. Input
per ≤25 orders: the *rendered* import only — rows, probabilities, linked
Product name/model/last price, settlement match — roughly 400 tokens per
order; never raw captures. Output: `ImportFinding[]`. Auto-applies
`wrong_product` / `reversal_kind` relinks only when the target row was written
by this run (no audit-log `userId` on it) and the probability is high; files
everything else `open`. `apply` replays `proposedFix` through the kernel and
renders a structured refusal if the targets have since merged or deleted.

### 4.7 Server: Gmail discovery

Hourly cron (`"crons"` gains `0 * * * *`) → one Workflow with two steps.

*Mail.* Per connected mailbox: `users.history.list` since `historyId` →
metadata `messages.get` → match `From` against `Vendor.orderEmailSenders` →
parse order id + amount + event (`placed \| shipped \| delivered \| refunded
\| cancelled`) into a small `OrderMail` table (`ledgerPartyId`, `vendorId`,
`orderId`, `amount`, `event`, `messageId`, `receivedAt`). Unknown senders →
Jev `order-mail-classify` → if order mail, a derived Problem "new vendor?".

*Hunts.* For every unallocated `FinancialTransaction` at an `online_account`
(or `null`) vendor: route to the card owner's VendorAccount
(`FinancialAccount.ledgerPartyId`); find `OrderMail` rows for that vendor and
party within the charge's date window; exact amount match wins, otherwise
Jev `charge-mail-match`; push `{ orderId }` (matched) or `{ walkWindow }`
(unmatched, charge date ±7 days) to the DO worklist; trigger a run if a
socket is attached. A hunt whose walk found nothing files the
`expected order not found` Problem.

### 4.8 Server: expectation detectors

Derived Problems detectors beside the existing
`purchasesNotReconciling` / `purchaseFinancialSettlementMismatches`: a hunt
that exhausted mail and walk (naming the card owner's VendorAccount);
`receipt_only` charge with no document. No nightly workflow.

### 4.9 Problems page

New `importFindings` key: schema in `packages/schemas/src/problems.ts`,
detector in `problems.service.ts`, counts cache, apply/dismiss actions
recording user and time. Plus the derived detectors above and `paused_auth`
accounts ("Sign in to Amazon to fetch N orders").

### 4.10 Web UI

VendorAccounts (status, cursor, last run, connect Gmail), `ImportRun` list with
derived cost, Vendor hints editor, findings on Problems.

### 4.11 MCP client (Claude Code / Codex)

`purchase-import/SKILL.md` shrinks to: learn a new vendor (walk it once with
the Chrome MCP, save hints), one-off imports (an export → payload →
`import_vendor_orders` with an explicit `vendorAccountId` the caller's OAuth
user owns), and enrichment fallbacks. Invariant prose for vendor orders is deleted; the financial
settlement half stays.

## 5. Flows

1. **Normal sync.** App foregrounds → socket authenticates and attaches → run
   starts → orders list via hints or discovery → for each order newer than
   `cursor.newestOrderAt` (or on that date and not in
   `orderIdsOnNewestDate`): `import_order_page` → cursor advances →
   `finish_run` → auditor → local notification "Amazon (Nicky): 6 imported,
   1 needs you".
2. **Charge-driven hunt.** Monarch syncs a $84.12 Amazon charge on
   Rebecca's card → routed to her Amazon VendorAccount → the hourly cron
   finds her order mail for $84.12 two days earlier → `{ orderId }` on her
   worklist → her Mac's next run fetches that one order by
   `orderUrlTemplate` → `import_order_page` → the charge is allocated. No
   mail match → the run walks her orders list for the charge date ±7 days →
   still nothing → `expected order not found` on Problems.
3. **Backfill.** `trigger = backfill` walks older than
   `backfillBeforeOrderAt`, newest first, paced; auditor per 25.
4. **Export jump-start.** Claude Code reads the Amazon export, posts the
   payload with Rebecca's `vendorAccountId`; Purchases land with lines and
   Products; the enrichment worklist fills images by ASIN.
5. **Sign-in / captcha.** `auth_required` → `status = paused_auth`, Problem
   shown, window raised → member signs in → app sends `resumed` → run
   continues at the same order.
6. **Browser offline.** Socket drops → `paused_offline` → reconnect resumes
   at the same step → 24 h without reconnect → Problem.
7. **Sum mismatch.** Extraction fails validate → repair feature with
   screenshot → still off → Purchase created with PDF and one productless
   `principal` at the printed grand total; `sum_mismatch` finding carries the
   extracted lines; applying it splits that row.
8. **Finding lifecycle.** Filed → Problems → apply runs `proposedFix` through
   the kernel → `applied`; dismiss → `dismissed` (labelled data for evals).
9. **Delivered.** Page shows all shipments delivered → `arrived` finding
   (once) → human receives via the existing flow → finding dismissed.
10. **Enrichment worklist.** Products missing a cover → server lists
    `{ productId, pageUrls[] }` → Mac app captures each *page* (bot-guarded)
    → Jev picks the image → server fetches the *bytes* from the CDN URL
    (not bot-guarded) → verify.
11. **Vendor learning.** New vendor → the agent (or a Claude Code session)
    finds the orders page, saves hints; failure later invalidates hints →
    rediscover.
12. **History expired.** Backfill reaches the last page the site offers →
    `mark_history_expired` → older line-less, document-less Purchases on that
    account stop counting as incomplete; their score reflects amount +
    project + date only. A `receipt_only` vendor's Purchases never expected
    lines in the first place, so nothing needs marking there.

## 6. Cost and evaluation

Per order ≈ 8 K fast-tier tokens (capped capture) + ~400 reasoning tokens of
audit + ~8 Jev calls ≈ one to two cents; a 300-order backfill ≈ a few dollars.
Exact prices come from the cookbook catalog through `models.ts`.

Offline eval before relying on thresholds: 100 previously imported lines with
known outcomes for `product-line-identity`, 50 for `reversal-kind`, 50 for
`expense-line-role`; pattern from `inventory-detection-evals.ts`.

## 7. Security and privacy

- No vendor cookies, passwords, or sessions ever reach the server.
- The socket is the only new auth boundary: session resolved before upgrade,
  owner check against `VendorAccount.ledgerPartyId`, identity persisted with
  `serializeAttachment`; tested (§8.4).
- Gmail refresh tokens sit in better-auth's `account` table with
  `gmail.readonly` only; one grant per member; revocable in settings.
- Apple Events automation permission is per app pair and revocable.
- No real household data in fixtures.

## 8. Implementation sequence

### 8.1 Flue spike — definition of done

One day. Go/no-go for Flue vs Agents SDK primitives. Done means, in a branch:
a SQLite DO class registered in `wrangler.jsonc` `migrations`, exported from
`cf-server.ts`; a Flue agent in it with a custom tool that blocks on a
WebSocket message from a stub client; Postgres reached via
`withRequestDbClient(env.HYPERDRIVE.connectionString, …)`; the tool call
survives a redeploy mid-wait and resumes when the stub reconnects; hibernation
does not lose the attached identity.

### 8.2 Order

0. Pre-implementation work (§10), as separate PRs.
1. Spike (§8.1).
2. Schema (§3): `LedgerParty.userId`, `VendorAccount` (full entity work),
   `Vendor` columns, `Purchase` columns, `ImportRun`, `ImportFinding`,
   `MailboxCursor`, `AiUsage.jobKind/jobId`; hand-applied CHECKs
   (`LedgerParty_userId_member_check`, `ImportFinding_target_check`);
   `schema-template-inputs.ts` updated for the new tables.
3. Writer service + MCP tool (§4.4).
4. Jev features + evals (§4.5, §6).
5. Extraction + repair features (§4.3).
6. Agent + tools + hints; Mac app browser bridge; socket auth (§4.1–4.2).
7. Auditor + findings + Problems key (§4.6, §4.9).
8. Gmail discovery + cron + expectation detectors (§4.7–4.8).
9. Web UI (§4.10).
10. Skill rewrite (§4.11); `docs/todos.md`: retire "Receipt-shaped import",
    "Durable import checkpoints", "Marketplace seller on Amazon purchases",
    "PurchaseLine SKU annotation".

### 8.3 Validation

Per AGENTS.md: `pnpm typecheck`, `pnpm test:file` per touched file, `pnpm
check` at handoff, `pnpm verify:local` before merge, `generate:check`, Apple
build for the Mac app.

### 8.4 Tests the plan requires

- Writer: one table-driven test with a row per §4.4 invariant, including
  "single unlinked aggregate → replaced with snapshot carried", "any other
  existing shape → no lines + `duplicate_lines`", "sum mismatch → one
  grand-total row + finding", and "non-owner session → refused".
- Hunts: charge → exact-amount mail match; ambiguous → Jev; no mail → walk
  window on the worklist; walk exhausted → Problem.
- Exceptions: input-scoped fingerprint survives a notes/project edit and
  reopens on a new Expense or document, for every check in the catalog.
- `AI_FEATURES` registry + `features.unit.test.ts` for every new feature;
  Jev raw-probability exposure; byte-cap assertion for each shortlist
  renderer.
- Extraction `validate` → one repair turn → finding path.
- Problems: `importFindings` contract, detector, counts cache,
  `problem-read-architecture.unit.test.ts` file list.
- Socket: non-owner rejected before upgrade; identity survives hibernation.
- Entity: `VendorAccount` incoming edges, `EXPECTED_EDGE_COUNT`,
  `EntityCatalogTests.swift`.
- Auditor: auto-apply refused on a row with an audit-log `userId`.

## 9. Assumptions and open questions

- **Chrome Apple Events** toggle survives updates; Safari is the fallback and
  a Cubby extension the upgrade.
- **Flue maturity:** 1.0 beta; the spike decides.
- **Gmail volume:** hourly polling across two mailboxes is far under quota;
  `users.watch` push is a later option.
- **Foreign-currency orders** are rare enough that a finding plus a human
  entering the settled amount is acceptable.

## 10. Pre-implementation improvements

Each is a blocker for the above *and* a good change on its own. Land these
first, as separate small PRs, in this order.

0. **Shortcode prefixes of 2–5 letters.** The `XXX-` shape is asserted in
   `scripts/generator/entities/compile.ts` (`/^[A-Z]{3}-$/` on
   `shortcodePrefix`), `CubbyKitTests/EntityCatalogTests.swift`,
   `packages/schemas/src/test-support/identifiers.unit.test.ts`,
   `apps/web/src/server/mcp/entity-kernel.integration.test.ts`, the README
   prefix table, and the MCP server instructions list. The parser splits on
   the first dash, the registry is generated, and the column is `text`, so
   relaxing to `/^[A-Z]{2,5}-$/` is a regex change in those places plus a
   doc line in `docs/entities.md`. Existing codes untouched; no migration.
1. **Member identity.** `LedgerParty.userId` and a `currentParty()` helper in
   the request context; expose "which member am I" on the OpenAPI session
   endpoint. Needed by strict ownership; useful today for attribution
   defaults.
2. **Completeness score and durable "not available" exceptions.** Three
   changes to `apps/web/src/server/repo/data-quality.ts` and the manifest:
   - *Vendor-aware checks.* Each check gains an `expectedIf` predicate
     evaluated against the row and its Vendor: `empty_expenses` and
     `primary_document` are expected only when `orderEvidence =
     online_account` (or `null`, which should nag once); a `receipt_only`
     vendor expects a document but not lines; `not_expected` expects
     neither. Unexpected checks do not count.
   - *Exceptable `empty_expenses`, input-scoped fingerprints.* Add
     `empty_expenses` to `EXCEPTION_REASONS` with `history_expired` and
     `unavailable`; add `history_expired` to `primary_document`. Change the
     fingerprint for **every** check from `<check>:<updatedAt>` to a hash of
     the inputs that check reads (live expense count, document set,
     `orderId`, …), so an exception stays valid until its evidence changes
     and unrelated edits (project, notes) no longer reopen it. Each check
     declares its `inputsFingerprint` beside its predicate; the
     `domain-rules.md` paragraph on fingerprints is rewritten.
   - *Score.* Replace the three-valued status with a weighted 0–100 score
     per entity (each manifest declaration lists its checks with weights;
     excepted and unexpected checks count as satisfied), keep the status as
     a derived bucket for existing filters, and expose the score on list
     reads and as a sort for every entity — today only Purchase and Product
     have checks, and only Product has a sort (`identity_strength`). The
     import expectation detectors (§4.8), the Problems worklists, and the
     enrichment backlog all read this instead of their own predicates.
3. **Google provider in better-auth.** Enable `google` with `linkSocial`,
   offline access, incremental scopes; a settings card to connect/disconnect.
4. **Job id through AI telemetry.** `jobKind`/`jobId` on `AiRunContext`,
   `GatewayMetadata`, `jev.ts`, the versioned telemetry queue event, the
   consumer, and `AiUsage`. Makes any workflow's cost `SUM(AiUsage)`.
5. **Expose Jev's raw probability.** `JevChoiceResult.probability` beside the
   bucketed `confidence` (the TODO in `jev.ts`); surface it on the suggestion
   schemas as nullable. Thresholds above depend on it.
6. **SQLite Durable Object pattern.** First `new_sqlite_classes` +
   `migrations` entry in `wrangler.jsonc`, documented in
   `docs/agents/domain-rules.md` next to the Workers section; the spike
   produces it.
7. **Polymorphic reference rule (doc only).** Write into
   `docs/agents/domain-rules.md`: untyped `entityType + entityId` for
   derived/telemetry rows that may dangle; exclusive-arc nullable FKs with a
   CHECK (precedent `LedgerSourceClaim_owner_check`) for rows that must not;
   ≤4 targets. No helper code.
8. **Mac app networking.** WebSocket client in `CubbyKit` with bearer auth and
   reconnect; the Apple Events entitlement and usage string in the macOS
   target; the `BrowserBridge` protocol.
9. **Delete the superseded Markdown** (after step 3 of §8.2): remove the
   vendor-order invariant paragraphs from `purchase-import/SKILL.md` and its
   references; keep judgment, settlement, and client mechanics; the war
   stories become writer test names.

Reviewed and rejected as blockers: a kernel-level multi-command transaction
(the writer is a workflow service with its own `withTransaction`); a
"primary document" attach option (`documentKind` already is it); a stored
problem abstraction (`ProblemKey` registry + `dataExceptions` already cover
it); per-account `get_vendor_coverage` (an optional filter, not a
prerequisite).
