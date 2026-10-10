# Purchase import: how a Run moves through the Worker

A purchase-import Run spans the web Worker's request path, its purchase agent,
and a Mac browser. The host code here owns every write. The purchase agent
(`server/purchase-agent/`) runs in the same Worker but owns only the model
conversation: it reaches Cubby through one Run's services and nothing else
(the boundary: [infrastructure](../../../../../docs/infrastructure.md#purchase-agent)).

Run lineage distinguishes causal work (`parentRunId`) from another attempt at
the same work (`predecessorRunId`). New starters record `cause` and `attempt`;
historical rows retain null lineage rather than inferred AuditLog links. Parent
links preserve the initiating member scope. Generic Run relations expose the
parent and children, and a replay of an unfinished keyed starter preserves its
null `endedAt`.

The shared activity projection groups research descendants and their image jobs
under the highest retained live causal parent. Group filters apply to matching
work, while an unmatched root remains visible as context; expanded children use
the same filters and cursor protocol. A deleted parent starts a new visible root
at its live child. Historical null lineage stays independent, and retry
predecessors do not become causal parents.
Group liveness includes retained descendants without changing the root's own
state. Collapsed active groups continue refreshing; expanded child pages use
the shared query cache, refresh through settlement, and reload when reopened.
Child pagination traverses lightweight lineage before evaluating accounting
and activity details for the selected group's members.

Product and Purchase research history use the shared entity report and record
renderer on web and Apple clients. Each attempt shows its Run lifecycle alongside
the target outcome, retained warning and target completion time (or Run start
while unfinished). A completed attempt does not imply a verified purchased
variant. No-write research remains visible, and each row opens its actual Run.

Execution allowance is separate from causal lineage. A member's explicit
approval is an immutable, completed background Run; completed RunOperation
receipts retain every conservative paid reservation and distinct candidate or
Product claim. Descendants and retries copy the host-issued
`executionAuthorization` reference while preserving their real parent and
predecessor. The latest approval for each member, mailbox and scope kind cannot
fall back to an older allowance after revocation or invalidation. A blocked
pilot, backfill or continuous scope does not block another scope or mailbox.
Approval roots never start a coordinator or lease jobs. The Run's required model
metadata does not initiate execution.

The authenticated `run.executionMailboxes` query lists only the acting member's
connected Google mailboxes. The human-only `run.approveExecution` operation
requires an exact mailbox scope, pilot candidate/Product limits when applicable,
metered cap and period, and future expiry. The host supplies the login and linked
live member LedgerParty; issuance rechecks the connected owned mailbox and
commits the immutable completed approval root through its own durable database
transaction. These declarations feed HTTP and native clients; MCP cannot issue
approvals. Each submission creates a fresh authorization. After interruption,
read back the existing approval root rather than blindly retrying or reissuing
the request. Targeted pilot and continuous new-mail approvals grant no
full-history permission; that always requires a separate backfill approval.

After approval, the authenticated human-only `run.discoverMail` operation starts
discovery for one selected connected owned mailbox. It reuses current immutable
allowances and the scheduled discovery policy; the caller cannot supply or widen
scope, and launch does not reissue approval or start global catch-up work. An
already running discovery returns `running: 1` without another Workflow launch.
Scheduled global discovery continues to visit all connected member mailboxes.

Paid research inference reserves the exact catalog model's full billing bound
before each physical transmission, including retries. Unknown pricing or token
bounds refuse the request. Reservations commit independently before network
work; timeout, interruption and gateway-cache hits never refund them. Pilot
money and candidate/Product limits apply across its descendants; continuous
money uses UTC calendar months without carrying unused allowance forward.
The transport rechecks the executing Run and immutable approval binding after
pricing and after reservation. Its final database admission read is the
cancellation boundary: cancellation completed before that read prevents
transmission, while an already admitted request can finish. A reservation
committed before cancellation remains spent conservatively. Exhausted discovery stays in review;
scheduled passes reuse its approval and wait for a new explicit lifetime grant
or the next continuous calendar bucket rather than restarting the same failure.
Research prefers the connected ChatGPT subscription. Explicit budgeted fallback
permits a disconnected plan or a complete exact
`subscription_sharing_usage_limit_exceeded` refusal to use AI Gateway. An HTTP
429 JSON refusal qualifies. For a requested ChatGPT Responses stream, a bounded
pre-SDK admission probe also recognizes an HTTP 200 `event: error` carrying that
code, including when Content-Type is missing. Before the refusal, only matching
`response.created`/`response.in_progress` metadata with absent/queued/in-progress status,
absent or empty output and absent/null error can qualify. Admission validates the
complete error envelope separately from diagnostic extraction: a conflicting type,
Response wrapper, output-bearing error or unrecognized metadata field replays
unchanged. Recognized request-configuration fields remain metadata; future provider
fields require explicit admission support. Current admitted configuration includes
nullable `user`, the strict documented access-program object, numeric frequency/presence
penalties, null moderation and reasoning context/mode settings. Context and mode
are request configuration, not generated reasoning items; see the
[Responses API contract](https://developers.openai.com/api/reference/resources/responses/methods/create).
The observed structural rejection reproduced in a synthetic regression; live
paid recovery remains unverified. Any output, tool,
reasoning, unknown/malformed event or other failure ends eligibility immediately.
The probe holds at most the first 64 KiB for inspection and waits at most 30 s;
non-refusals replay the original held chunks and unread remainder without changing
bytes, headers, read failures or cancellation. It never probes a paid response or
synthetic peer. Every
physical paid call first reserves its complete catalog-priced input/output
billing bounds against the Run's existing execution authorization. Unknown
prices/bounds, missing authority, cancellation or insufficient allowance prevent
transmission; budget exhaustion pauses the scope. A reservation is conservative
and remains consumed even if cancellation or provider failure follows admission.
Actual usage and reservations are distinct. A retry cannot reset the bucket.
Other HTTP errors, network/abort errors and partial streaming failures do not
fall back. Passive stream diagnostics retain a complete JSON error envelope from
the first 64 KiB read by the SDK: actual HTTP status, content type, request ID,
first eight preceding event names and their total count, plus serialized error
data. Observation follows a decoded request's `stream: true` or an SSE response
Content-Type; missing or incorrect response MIME does not hide a requested
stream's error. Stream/blob request bodies remain unread. A JSON-string
`event: error` is retained within the same bounds; strings in other events are
never retained as diagnostics. Structured-feature failures without an observed
error envelope retain response status, Content-Type and request ID separately
from usage accounting, with each displayed header capped at 128 characters.
Recovered responses do not label a later admission or network failure.
The complete diagnostic is capped at 4 KiB at a UTF-8 boundary. Nested provider error objects retain their fields; direct
error events retain type/code/message/param. Failed-response output is excluded. Observation is bounded to 64 KiB of buffered SSE characters and ignores error
data over 16 KiB regardless of chunk boundaries. Oversized preceding events are
counted without retaining their data; later bounded errors remain observable.
CR/CRLF/LF framing is normalized only for observation. It does
not pull ahead or retain preceding output, and preserves original bytes and
cancellation. Incomplete/oversized/non-JSON error data remain unobserved; ignorable SSE field
warnings do not suppress later errors. Event
names alone do not prove absence of useful output. Passive observation never
grants paid replay: only the opt-in pre-SDK admission probe can recover the
complete pre-output quota refusal. `response.failed`, partial output and
unrecognized failures remain on their original transport. When a replayed stream
later fails, its error also reports the admission probe's first rejection reason,
event name, elapsed time, inspected byte count, and bounded schema issue paths,
codes and unknown-key names. This separate diagnostic adds at most 2 KiB and
retains no lifecycle values or preceding output. It distinguishes schema rejection,
time/byte limits, frame overflow, EOF and read failure without changing admission.
Interactive calls
without this explicit policy retain their defaults.
Pi can open before dispatch binds its Run, so the coordinator resolves transport
policy from its persisted identity at each request. Photo inventory keeps its
existing transport policy; an unbound coordinator cannot bypass research admission.
New mail and Product research Runs without inherited authority can bind the
existing backfill approval only when every target has retained original mail in
the member's single connected Google mailbox. Canonical sources must match the
raw checksum. Historical `gmail:synthetic-message:order:EXAMPLE-101` sources
instead bind through their message identity and the owned retained original:
their old checksum describes derived order data, not raw mail. This proves
budget ownership only; it does not revalidate old claims, rewrite source history,
or make historical identities writable. Selected Product sources constrain that
check. Missing, foreign, ambiguous or sources without a retained original remain
unpaid. The latest approval is authoritative even if revoked or expired;
inherited authority always wins, keeping retry buckets stable. Settled Run inputs
are never rewritten. Both launch paths use the same evidence/ownership check.
Retirement receipts fence originals before cleanup finishes. Mail identity and
a preserved checksum alone do not prove retained content: cleared content
tombstones and fenced originals cannot grant new paid authority, for either
historical or canonical keys.
No caps, provider credentials or billing arrangements change.

Gmail discovery initializes a new-mail history baseline even without historical
approval. Targeted approval permits only host-derived known-Vendor and unmatched
transaction queries; separately approved full-history coverage can enumerate
all retained mail excluding Spam and Trash. New-mail discovery neither advances
historical coverage nor converts an expired history cursor into a broad scan.
Such a gap remains an inspectable failure until authorized recovery is available.
Pilot queries, full-history scans and incremental history use their respective
immutable approvals. The existing mailbox cursor and single active discovery
Run serialize their pages: targeted queries precede broad scans, each scan page
yields to an independently approved continuous catch-up, and paginated history
drains before scanning resumes. A durable continuation creates a fresh Run for
its selected allowance; it never changes an existing Run or attaches a different
allowance through parent or predecessor lineage. Without any approval, the
existing new-mail baseline behavior remains available; it grants no historical
scan authority.

Mail retry and restart re-enter the original source admission boundary rather
than copying Run inputs or targets. Retry carries only unresolved supported
messages; an explicit restart may also research supported settled messages.
The public restart disclosure shows the frozen retained source count, without
exposing source UUIDs, mailbox identities or checksums.
Order and email-link resolution operands use `evidenceIds`, the same retained
observation references used by facts and identity judgments. A mail `messageRef`
is an acquisition selector, not evidence. Context observations can support
identity reasoning; the assigned primary source still bounds write authority.
Order proposals and links use the same source-supported mail event. Shipping
mail can create the Purchase first without losing its shipped event; an
unspecified event remains `other`, rather than asserting order placement.
The source checksum, mailbox exclusion, member ownership and exact predecessor
are checked again under source locks before the predecessor Run lock. Another
Run's source cannot transfer implicitly. A retry leaves sources with their valid
current owners and admits only originals the predecessor still owns; those
already covered elsewhere do not block its remaining work. One canonical successor is replayed
across controls, preserving its frozen scope and cancelled or removed state.
New attempts preserve the real causal parent and leave unknown historical
attempt numbers null. Admission and dispatch are separate: queue publication
waits for the outermost transaction to commit and is discarded on rollback.
Frozen mail scope is a list of original UUID/checksum pairs. Each original owns
its mailbox provenance; one Run may investigate retained sources from several
owned mailboxes without confusing repeated provider message IDs. Fresh searches
can choose any connected owned mailbox. Pagination remains bound to the issued
Run, work, query and account; retained context never steals another Run's source.
An original already owned by another valid research Run stays with that owner,
including blocked originals; retry admits only the predecessor's remaining
sources. A blocked disposition does not invalidate matching frozen ownership.
Historical `order_mail_import` selections convert only after every saved event,
order ID, checksum, member and candidate mapping is proved. Imported candidates
and covered candidates stay settled. Missing historical mailbox records are
established from exact original identity under admission locks, without changing
existing exclusion, retirement or ownership dispositions. Assignment must cover
every newly admitted source. The recognized historical shape alone authorizes the change from
`account_sync` to `mail_import`; it cannot authorize an arbitrary purpose change.
Product continuation uses the same successor and lineage rules, but re-enters
Product admission to refresh the original purchase context and target
fingerprint. Retry carries unresolved work; restart creates new tasks for the
saved scope. Neither changes old settled targets or copies stale fingerprints.
Attempt fingerprints derive Product facts from the declaration's research
fields, matching the facts supplied to the researcher. Changed Ingredient or
Plant references can reopen unresolved work; unchanged facts do not loop.
Manual launch and its preview use this admission with an optional owned browser
account; a Vendor URL or awake Mac is not a prerequisite for research.
Each explicit member retry retains that catalog-research permission, including
later attempts whose causal label is `retry`. It still loads only owned original
purchase context and cannot fabricate a purchase or bypass supported writes.
Complete field provenance does not suppress an explicit continuation: unresolved
variant research can need another attempt even when every declared field has
support. Automatic admission still skips unchanged attempts and complete coverage.
An unchanged manual launch that admits no Run reports that outcome in the dialog.
Older Product Runs with null input derive their scope from an exact saved
Product-only target roster. A retry can carry historical skipped work; restart
can reverify the saved roster in new tasks. Wrong-kind or duplicate rosters are
refused, and existing stopped successors replay before mutable source checks.

Historical mail and coverage without a proven Google subject retain an explicit
legacy mailbox scope. A currently connected account cannot establish that old
ownership, even when it is the only connection. Current mailboxes start their
own coverage; moving history requires a separately verified mapping of originals,
cursors and dependent references, with collision checks and production approval.

The generic Vendor report includes retained originals before order events have
been interpreted. Vendor scope is a research hint; displaying an original does
not establish a Purchase match or authorize a write. Restart diagnostics retain
the frozen Vendor objective and date range using public Vendor references,
including target source labels.

Historical per-order Gmail claims resolve to one canonical message identity only
when frozen Run selections, retained events, originals and exact stored checksums
agree. Direct aliases preserve each old claim, order-association and payment
owner and every historical source key. A separate canonical root is created
when none exists; old prepared extracts keep their original lookup identities.
Existing orders replay under their original claim; new orders use the
canonical root. Duplicate family order keys require review instead of choosing
an owner. Historical aliases are readable lineage, never new writable sources.

The canonical checksum tracks current original bytes. Each order association
retains the checksum and original extraction it accepted; refreshing one order
does not revalidate its siblings. Selected Product sources check the canonical
current checksum under the same root-before-association locks as the writer.
Acquisition updates an existing canonical root in the original-write transaction,
before research can select the refreshed source. Historical accepted snapshots
remain useful research context with separately identified accepted/current
checksums; a stale snapshot is not offered as a current replayable source.
Unproved history retains its originals and an explicit blocked mailbox record
plus a normal Run finding. Dismissing the finding cannot permit research or
source cleanup; both recheck the ownership disposition independently.
Routine routing, deletion and Spam/Trash handling cannot erase that disposition.

A negative Gmail routing decision cannot overwrite an original protected by
accepted source associations, attachments, research history or an ownership
block. Acquisition retains its stored bytes and checksum and reuses its existing
mailbox disposition. Completed work stays completed; blocked work stays blocked.

The coordinator execution fence checks ownership, replacement inputs and the
matching admitted tasks before queue delivery, SDK hydration or research-tool
replay. Old inputs remain readable history but cannot execute the new tools.
Missing or mismatched task admission is a refusal, never empty-work success.
Retirement cleanup remains available independently of execution. A fresh,
deliberately admitted successor is required for legacy work; legacy Runs are
not classified as unrelated mail or automatically reopened. Contract validity
is separate from active status, so completing its own work does not invalidate
an operation's successful response. A started replacement-tool checkpoint may
recover a pre-change import proposal only through its original hidden call ID
and matching completed receipt. Receipt decoding preserves the old normalized
fingerprint; new proposals still use the current strict tool schema. Removed
operands never authorize new writes, and ownership/retirement fences still apply.
Photo inventory keeps its explicitly selected shared owner and live initiating
member; that permission never grants research another member's source scope.

Research admission counts unique generations in Durable Object SQLite across
replay and eviction. Exhausting its allowance retains a concrete review reason
and denies inference at the provider fetch boundary before every transport.
SDK hooks may report an exception and continue; a hook exception alone cannot
enforce the allowance. The local denial is terminal, avoiding provider retries
for intentionally stopped work. Explicit member aborts retain their failure
semantics, while allowance exhaustion leaves unfinished targets for review.
Research host tools also stop after three distinct calls repeat identical
arguments and the same credential-scrubbed error. The existing Durable Object
state retains call receipts and the failure count atomically with the review
reason; replay does not count twice and a successful action clears its failures.
The terminating tool preserves the diagnostic, and the same provider fence
denies further inference. Changed arguments or errors are separate attempts.
This bound covers thrown service failures and returned browser `blocked`
responses. Browser and member waits do not count as failures. Zero-progress
corrective resolution refusals already use the task's three-attempt allowance
from completed operation receipts; they do not need another counter. Active-time
accounting remains a separate follow-up.

The replacement's migration chain follows the current main journal, including
Neon diagnostics. Its populated-history rehearsal rebuilds main's actual schema,
restores synthetic service-created records, and invokes the production migrator
twice. Signed Expenses, stock, owned photos, source/payment associations, settled
targets and operation/member decisions must survive. Interrupted purchase/mail
Runs become `needs_review` with `research_rewrite_required`; old inputs and
diagnostics remain, and photo inventory and terminal Runs stay unchanged. Apply
the cutover with writers and deliveries quiesced; resume only freshly admitted
replacement work after the new code/schema pair and client versions are verified.
The operational holds, quiescence acknowledgement, legacy upload-grant window
and deployment/readback order are owned by the
[cutover procedure](../../../../../docs/development.md#purchase-research-schema-cutover).

## One Run, end to end

1. **Start.** `targeted-run.ts` (`startTargetedImport`, `dispatchStartedRun`)
   commits the Run and sends a `start_or_resume` event to the
   `PURCHASE_AGENT_QUEUE` (`cubby-purchase-agent`). A failed send is recorded
   as `dispatch_failed` and is never thrown.
2. **Coordinator.** The Worker's queue handler (`cf-server.ts`) loads
   `server/purchase-agent/queue.ts` (`consumePurchaseAgentQueue`), which wakes
   the per-Run `PurchaseImportRunAgent` Durable Object. Its exported shell
   (`agent-host.ts`) loads the agent (`server/purchase-agent/run-agent.ts`) on
   first use and forwards `dispatch`. Queue events reach the model as
   `<signal type="…">` user text (`signals.ts`).
3. **Tools call Run services.** The researcher receives the focused tools in
   `server/purchase-agent/tools.ts`: next work, observations, mail, public web
   research and supported resolution. `agent-services.ts` supplies one
   Run-bound environment and parses the shared contracts; `research-service.ts`
   owns task references, source retention and domain-service writes. The
   separate photo-inventory workflow retains its own tool environment.
   Next mail work and resolution results include bounded current Purchase
   context from this member's same-run committed source associations, using
   public Purchase/Product references. Search-index lag cannot hide a record
   just committed by this conversation. Context supplies investigation leads;
   the primary retained source still has to support any proposed email link.
   Printed order days remain calendar dates; only explicit timestamp evidence
   is converted to the household-local day. Mail task verification records the
   supported event even when unrelated payment/delivery/catalog facts remain
   unknown. Broader scope coverage belongs to explicit research objectives.
   Unknown source currency remains null. Unknown or foreign-unit totals and
   payments stay in the immutable original, outside canonical USD financial
   writes. Unpriced item descriptions remain retained source evidence until
   priced itemization is available. The researcher supplies an explicit Product
   decision for every principal order line. Missing decisions return exact
   per-order paths before source assessment. The host applies the approved
   `other` trade fallback only to new principal Expense rows whose shared
   effective trade remains null after Product/Project inheritance. This policy
   is separate from source-verified facts, preserves member attribution and
   leaves Purchase defaults and adjustments intact.
   A returned domain refusal that leaves the same task active upgrades the
   coordinator from Luna/medium to Sol/low for the remainder of that Run.
   Independent source assessment uses Sol/low with the same retained-original
   inputs and structured acceptance/refusal contract.
   Mail relevance presents visible HTML text, exact links and structured order
   JSON-LD through the shared
   page compactor, omits layout bytes and identical plain/HTML text, and bounds
   the serialized model content to 256 KiB including attachment encoding.
   Original attachment acquisition retains its separate 10 MiB envelope, so
   an attachment omitted from the model view remains available for retention.
   Image labels and source URLs remain visible; missing image pixels cannot
   justify unrelated mail. Omitted structured blocks also keep relevance
   uncertain. An oversized readable body goes directly to uncertain without an inference request;
   incomplete compacted views or attachments cannot establish unrelated mail.
   Original mail remains unchanged for retention and subsequent research.
   Both purchase and Product research start with Luna/medium. The host
   retains this mode before returning the tool result and reapplies it after
   eviction or result replay. Settled ambiguity, member contradictions,
   exhausted attempts and unrelated-source retirement do not upgrade another
   task. Schema exceptions and transport failures do not trigger this policy;
   escalation preserves the existing attempt/generation limits and
   subscription preference and the same approved per-call paid allowance.
   A normal final answer yields to the host's next-work decision before pi
   settles the submission. Runnable work continues within that same durable
   submission; done, waiting and stopped dispositions settle normally. Queued
   user input and reset retain pi's precedence: no-progress accounting is
   committed only when a generation consumes the selected host continuation.
   Its exact signal must match the durable host-issued record; member text
   cannot manufacture continuation authority.
   Repeated final answers pause
   only the affected task after three decisions with unchanged retained source
   checksums and accepted writes, including each canonical fact subject.
   Replaying a decision or rereading identical
   source bytes does not count as progress. The retained decision includes the
   last actual refusal/error, and other tasks continue. Failure, explicit abort
   and the generation ceiling retain the existing settlement backstop.
   A late final answer after cancellation creates no continuation ledger writes.
   Continuation admission locks the Run and binds its next-work decisions to
   the same transaction, so cancellation cannot commit between its status check
   and ledger writes. Derived Product work dispatches after that transaction commits.
   Continuations acquire the owning member before sources and Runs, matching
   mail admission and the terminal Product sweep. Continuations then lock
   frozen mail sources and eligible Product targets' owned originals in ID order
   before the Run,
   matching source exposure, retirement and history erasure so those paths cannot invert locks.
   Product selection reuses that preloaded context for the continuation; a newly
   committed original appears on the next call, never after the Run lock.
   Run status/ledger fences use key-preserving locks: cancellation still waits,
   while a concurrent child admission can check its parent foreign key.
   Retained mail observations present plain text and compact visible HTML with
   source links before applying the model-view size limit. Layout/CSS bytes never
   crowd receipt facts out of that view. The immutable original MIME content and
   checksum remain unchanged for support assessment and replay; attachment bytes
   still use the original binary assessment path.
4. **Browser observations.** `research-browser-service.ts` binds commands and
   immutable retained observations to the explicit work reference. It enqueues
   on the per-account bridge Durable Object (`durable-object.ts`). The Mac
   connects through `direct-socket-route.ts`; a result publishes
   `browser_result`, and reconnect publishes `browser_connected`. The host
   supplies retained page content and actionable references directly to the
   conversation. The model does not issue/read/bind commands or invent sources.
   Delivery stays pending until the durable harness accepts its signal. The
   coordinator retains the signal/request binding in SQLite and checks pi's
   committed submission before acknowledging it. Every model request and mounted
   tool effect reconciles admitted deliveries first, including cold tool recovery;
   a failed submission cannot acknowledge its page. Failed ACKs retain the binding
   for replay. The browser service still refuses implicit reads/navigation while
   delivery is pending; an explicitly retained control must match the same
   evidence, observation and concrete account. Stale, foreign, disabled and
   authentication controls remain refused.
   A broker delivery fenced by cancellation is acknowledged without submitting
   a model turn. Transport acceptance does not authorize retention or writes;
   duplicate late deliveries preserve the cancelled Run and its domain state.
   An offline browser command returns `browser_pending`; it does not end
   investigation through public web or mail sources. Next can select another
   runnable task, or return this task's exact retained non-authentication
   observation with its evidence and candidates before delivery acknowledgement.
   Another unresolved command still blocks that task. Only browser-dependent
   work waits for connection, and an all-offline remainder pauses the Run.
   Public-page reads commit their immutable manifest before storage. Replaying
   an uncertain upload verifies the original retained bytes and checksum under
   Run/task locks before marking it uploaded. Missing or changed bytes remain
   pending and refuse resolution; a fresh page cannot replace that original.
5. **Writes and finish.** `work_resolve` calls the shared purchase or Product
   resolver. The host checks identity, retained support, ownership, collisions
   and financial contracts; purchase import remains stock-neutral. Matching
   existing Product values can gain provenance without changing the value.
   Retailer identifiers use one shared issuer resolver for purchase preparation,
   line grouping, exact Product lookup, identifier learning and Product research.
   Canonical Vendor websites and browser domains establish issuer ownership;
   the resolver reuses that Vendor's sole registered ExternalSource and refuses
   ambiguous domains, competing registrations or incompatible ownership. An
   unregistered issuer uses `host-` followed by reversible lowercase hexadecimal
   bytes of its canonical full hostname, preserving dots and hyphens. Legacy
   prefix or name registrations never establish domain ownership and are never
   reassigned. Learned identifiers retain their source URL; manufacturer parts
   remain manufacturer-scoped and GTINs remain global.
   The declaration-derived accepted-field writer also fills a Purchase's
   supported purpose through its ordinary domain service, marking only new
   source-filled values as `source`. A source purpose is evidence about the
   Purchase; it does not change effective Expense classification. Matching member values gain proof without
   changing their origin; contradictions preserve the value and return a
   retained refusal. Each fact names the original proposal's order index.
   The host binds it to the writer-selected Purchase after its source
   association succeeds, and rereads that Purchase under lock for each group.
   A rejected or member-refused order cannot acquire facts or provenance.
   Existing Product line resolutions use public references from `cubby_find`.
   Preparation and automatic line matching use the shared declaration-driven
   Product name/alias resolver: full-title lexical relevance is ranked before
   its bounded candidate limit. Broad leading brand/category words never select
   an alphabetical shortlist. Typed identifier hits retain priority; a ranked
   name, alias or shared-model candidate is not proof of exact variant identity.
   Hosted `new` resolutions also expose the ranked live candidates and their
   typed identity to source assessment. Supported existing variants require a
   revised `existing` proposal; the assessor never repairs a proposed write.
   Search supplies candidates; retained-original assessment verifies the selected
   identity with bounded live metadata and canonically ordered typed identifiers.
   Settlement rereads that projection under sorted Product, matching Entity-parent
   and identifier locks before translating accepted public references. A fresh
   supported original retains its principal line-to-Product binding when that
   Product already appears on the canonical Purchase, without duplicating Expenses
   or stock. Human-refused, unaccepted and mismatched originals gain no binding.
   Canonical import takes settlement, sorted existing source-family roots,
   Products, matching Entity identity parents, then identifier children in that
   order. Family prelocks do not create or refresh claims; missing sources enter
   the claim writer only after their operand is admitted.
   Only accepted
   import lines translate to private Product IDs in the canonical transaction.
   Purchase validation keeps public operands and writes no money or stock.
   `RunFactEvidence` retains the canonical entity subject separately from the
   originating task and exact task-owned observation. Historical proof derives
   its subject from its original target during the reviewed data-preserving
   migration. A shared source can support several canonical Purchases without
   inventing entity targets or merging their proof identities.
   Product and Purchase tasks retain their admitted UUID in `workKey` while
   `entityId` follows an ordinary merge to its live survivor. Distinct original
   task keys never fold: completed receipts, evidence and frozen inputs keep
   their identity. A fresh retry deduplicates canonical subjects and rereads
   fingerprints; competing selected originals remain a refusal.
   Product context presents the accepted original order line separately from
   the current editable Expense description, URL and quantity. Its optional
   joined line starts with the non-null row identity, so an unknown category
   cannot hide an existing line; genuinely absent lines remain null.
   Supported Product facts that differ from populated values become one atomic
   generic Run finding, showing the saved values, proposed facts and retained
   support. Facts remain unchanged until explicit approval. Approval rechecks
   the accepted assessment, immutable admission and identity, original source
   bytes and metadata, ordered context and current Product snapshot; a stale
   proposal refuses without overwriting member edits. The canonical field writer
   then applies the approved facts and records matching-value provenance.
   An Ingredient link change recomputes recipes using both the previous and
   resulting Ingredient through the ordinary costing service; an empty-field
   fill affects only the new Ingredient, and a matching link needs no refresh.
   Mutable Finding and Run locks apply only to those rows; separate member
   share locks preserve eligibility while remaining compatible with the owner
   foreign keys of concurrent findings. Correction approval retains the
   Product → Run → Target lock order.
   Verified exact-variant images can take cover ahead of an explicitly marked
   automatic order thumbnail. Own photos, explicit member gallery edits and
   unmarked historical covers preserve their order. Ordinary gallery requests
   record intent even when the member reselects the existing order; catalog
   provenance alone never establishes permission to change a cover.
   Under the existing Product lock, same-byte research images reuse a live item
   attachment by SHA-256 even when source URLs differ. New observations add
   support to that same member path using the original image's canonical metadata.
   Labels never qualify as item matches. Only newly staged unreferenced images
   are discarded; historical attachments, own photos and their ordering remain.
   Historical images without SHA-256 cannot establish different-URL byte equality.
   Work iteration and completion accounting belong to the host. Unresolved
   targets remain visible; a settled conversation does not imply verification.
   Failed model turns retain their upstream diagnostic as ordinary conversation
   text, including when no answer was produced or a partial answer preceded the
   failure. The shared error scrubber removes credentials and applies its
   existing display bound; settlement reasons do not replace that diagnostic.
   An unresolved Product report may include declined claims. When exact ordered
   identity is unsupported, resolution records that outcome and its refusal
   reasons without writing facts or provenance. A proposed verified or partially
   verified outcome still requires supported identity. Declined operands alone
   never count as partial verification. Every Product resolution keeps the
   submitted proposal in its operation receipt, including declined operands
   when recording the unresolved outcome succeeds.
   Completion accounting counts researched gaps separately from partial
   verification; both remain unresolved work.
   `server/purchase-agent/run-settlement.ts` reports each operation's
   settlement through a durable Lifecycle job to `reconcileSettledRun`. Only
   the newest submission reports, once the conversation is idle, and it lists
   every queue event the agent has received. The run stays `running` while
   the server has issued a wake the agent has not received (the current
   dispatch generation, an approval decision, a Mac browser result): that
   event resumes the conversation. Settlement inventories the actual owned
   browser accounts named by commands, including borrowed accounts on mail
   research, and preserves an undelivered retained page until acknowledgement.
   Photo inventory keeps its separate shared-household ownership and human
   proposal review; settlement does not apply researcher browser ownership to it.
6. **UI.** The Mac Browser Sync sidebar pane lists browser-enabled accounts in
   a searchable, sortable table, with live bridge status and the server sync
   plan on the same row. Rows deduplicate by account shortcode, never by
   vendor name. Sync and Resume open the returned run console before
   refreshing the advisory plan; Sync all opens Activity when it submits
   multiple runs. Partial batches retain submitted runs and raw failure/skip
   diagnostics. Replacing or disconnecting the controller invalidates pending
   sync navigation and plan reads, so late results cannot show another server’s
   accounts or open its runs.
   Sync on an authentication- or offline-paused Run uses the ordinary owned
   resume control and its new dispatch generation. It preserves the original
   Run, frozen objective and target roster; a retry signal alone cannot resume
   a paused coordinator.
   History import uses a per-account date-range popover. Settings retains
   browser choice and permissions, with a link to the pane. The run page proxies the agent conversation through
   `agent-proxy.ts` to the run's agent Durable Object. Member controls go
   through `controlRun` and `recordRunControlEvent`.

Independent support assessment delivers identical retained attachment bytes once
per MIME type and checksum in a request. Every observation keeps its evidence
reference, attachment descriptor and binding validation; repeated observations
refer to the already supplied original. The summed original-byte admission limit
remains unchanged. This changes model delivery only, never retained evidence.

Independent Product support assessment shares byte-identical serialized order
extractions within one request. Each purchased-line/source row retains its own
context and indices into the complete shared originals; retained records are not
changed. Distinct extractions are preserved, and an unshared context keeps its
existing shape. The support skill describes how to resolve these references.

## Run evidence uploads

`run-evidence.ts` allocates an immutable target-scoped storage manifest before
uploading. Its short-lived signed `uploadUrl` names Cubby's binary upload
endpoint. The endpoint checks the declared media type, byte count, checksum,
owning member, active target, and permanent Run retirement fence. It holds the
Run lock through the storage PUT, so retirement waits for an admitted upload;
the same URL cannot restore bytes after retirement. Failed uploads retain
their manifest for replay and cleanup. Existing native and web callers still
PUT the declared bytes and content type to the returned URL.

Older direct object-store upload grants remain a separate cutover concern:
switching the endpoint does not revoke an already-issued grant. Production
cleanup must account for outstanding legacy uploads before claiming disposal.

## Purchase validation

A member launches validation through the same typed research admission as a
fresh retry, restart or evidence continuation. Admission freezes one to fifty
explicit Purchases and their recorded context; an optional selected original
must be an owned, current accepted source association. Historical null-input
Runs keep their old records and create a fresh admitted Purchase-only roster.
A Vendor row remains part of the Purchase domain; a website, browser account
and order ID are not required.

Source previews use admission's canonical-original freshness check: stale
historical aliases are unavailable and never selected by default. An original
may prefer an owned, enabled Chrome account through the existing browsing-account
selection; another member's account is never advertised or admitted. This
optional transport is stored on the Run separately from the frozen Purchase and
source fingerprint, so cloud investigation remains available without a Mac.

Targets without a verified original remain `needs_evidence` while owned mail,
public web and explicit browser investigation remain available. A member's
unavailable-original decision is a hint on fresh cloud work, not verification
or a terminal skip. Manual uploads are target-bound durable manifests before
PUT and become readable only after their original bytes pass checksum and size
verification. A completed upload wakes an acknowledged coordinator with the
existing retry signal, leaving its dispatch generation and pending commands
intact.

Supported differences create generic Findings and a recorded target diff. The
resolver does not change Expense costs, Purchase totals, refunds, allocations,
source associations or inventory. A discrepancy remains review work. A member
may apply an issued correction only against the completed accepted resolution
receipt, its retained evidence bindings, the admitted Purchase and the current
review snapshot. The existing validation correction service owns conservation,
normal domain updates and price effects. Other import finding fixes retain their
existing Run-write provenance requirement. An existing Purchase cannot become
`unrelated` because a candidate original is wrong; report ambiguity or missing
source support instead, without retiring accepted purchase history.

## Research source retirement

Coordinator disposal acknowledges a cold object only after its public KV list,
application SQL rows, and public alarm state are empty. Cloudflare's protected
`_cf_METADATA` table holds alarm metadata and is never queried directly; inspect
alarms through `storage.getAlarm()`. Keep platform-table exclusions explicit so
an unfamiliar application table cannot hide retained source content.

An unrelated-mail decision persists an external cleanup receipt before retiring
every Run that read that source. The receipt retains the deletion manifest and
unfinished-work transfer identities across storage errors, reconnects, and queue
redelivery. Cleanup preserves accepted facts and independently associated source
records. Completed, cancelled, and member-deleted Runs receive no successor;
disposing their cached source content does not authorize restarting their work.

Historical references are found by exact JSON string-value membership inside
PostgreSQL, including root values, nested arrays/objects, and deleted Runs.
Keys and substrings are not references. Discovery returns only matching Run IDs
so source-locked cleanup does not transfer and recursively decode an entire
member's research history. Runs remain locked before their evidence is read
again and the deletion manifest is frozen.

Overlapping source receipts share the first persisted browser-disposal identity
and each retired Run's unfinished-work disposition, including an empty result.
They reuse an existing successor even after its cancellation or after the
predecessor's task descriptors are erased. Mail continuations exclude every
already-retired source/checksum, not only the source named by the current
receipt. A conflicting persisted disposition stops cleanup for diagnosis.
An older mail Run can retain pending descriptors for originals subsequently
owned by another frozen Run. If that canonical owner is retired by the same
validated receipt, cleanup leaves its disposition with that owner and transfers
only its unfinished tasks. Settled or blocked mail is not imported again.
Owners outside the receipt, changed frozen checksums and missing ownership
remain refusals.
If another completed receipt already erased that owner's frozen input, its
locked mailbox ledger's exact source/checksum, admitted task and completed
transfer disposition establish ownership. A missing task or an unproved erasure
still refuses cleanup.
Modern screenshot references remain authorized by their exact receipt manifest.
If an earlier receipt already completed this fenced Run's physical disposal,
later receipts can reuse that recorded result after disposable evidence rows
are erased. An arbitrary missing evidence UUID is never ownership proof, and
these binary references never authorize deleting an independently owned Image.
An unfinished successor preserves its causal `parentRunId`, records the retired
Run as `predecessorRunId`, and increments its attempt. Browser disposal waits for
each recorded Mac to persist cache removal and acknowledge its own device
identity. Historical deliveries without device identity remain explicitly
pending until the approved client-cache cutover establishes their removal.
The Mac fences late commands, joins cancelled work, and clears its actionable
observation and replay content. PNG/PDF staging lives under the complete
host/account cache identity and explicit Run/command UUID directories allocated
before capture writes. Command completion removes its whole staging directory,
including a partially rendered PDF. Cancellation after a suspended screenshot
prevents new local writes. Run disposal also removes interrupted staging files
without touching another Run or a chosen household photo.

Every cold load and socket reconnect retries Run capture erasure, then persists
identity-only retirement receipts before replaying acknowledgements. Failed
erasure or persistence prevents acknowledgement. Undecodable replay files stay
intact and expose the decoding diagnostic; they cannot silently become an empty
ledger. Older unscoped `CubbyBrowserEvidence` staging and legacy replay shapes
require an explicitly approved client-cache cutover. Their unknown ownership
cannot be invented from the new Run directories.

Objective successors carry only unfinished frozen Vendor, account-history,
charge-search, or receipt descriptors, with new self-owned task references. They do not refetch
the admission cursor, range, or charge snapshot, or copy the retired conversation.
Receipt originals use the shared ownership/hash transfer. An unknown historical
attempt count stays unknown; a known count increments while the causal parent
stays distinct from the predecessor. Successor dispatch uses the bound Worker
queue and retains its dispatch identity across failed handoffs.

Known-Vendor research enters `run.startTargeted` with `account_sync` and a Vendor
reference. A website, browsing account, and Mac are optional. Fresh launches and
successors share member/Vendor admission; an older predecessor cannot create
another active investigation while newer work owns that scope. Existing children
replay before mutable admission checks, including a stopped child.
Known-Vendor objectives prioritize investigation and coverage; they are not an
exclusive Vendor write boundary. A shared original may identify purchases from
several Vendors. Every accepted acquisition still needs independent semantic
identity and the current member-owned original's write authority.

Unfinished Purchase validation exposed to discarded context mail uses the same
disposed-source receipt authority to admit fresh Purchase tasks. Admission checks
the receipt's member, predecessor, purpose, and unfinished Purchase identities;
it refreshes current Purchase/source context rather than copying model text.
Selected original references and explicit per-Purchase evidence-unavailable
choices survive, and repeated cleanup reuses the same successor. Unknown attempt
counts stay unknown. Receipt operands remain private to the host.

Receipt listing and submission check both the member-owned hunt and the live
charge's financial-account owner. An unknown transaction date stays null in the
shared worklist and native receipt picker; manual photo selection remains
available, but nearby-photo search requires the known charge day. A stopped historical receipt Run with
no typed input can become a fresh receipt objective from its retained finalized
image and checksum, while the old Run, tasks and image remain intact. Resolved,
cancelled (including dispatch-aborted), active or retired legacy work cannot be
reopened through this path.
Repeated submission reuses the new Run; unknown predecessor attempts stay null.
Replacement evidence preserves the original discovery parent separately from
the immediately preceding receipt Run.

Public account/charge/receipt retries enter objective admission, preserving the
frozen cursor, range and charge snapshots and deriving fresh tasks. They carry
the actual discovery parent separately from the predecessor. A stopped legacy
receipt can enter that path directly from its retained finalized original;
neither reupload nor rewriting old Run input or targets is required. Settled or
held hunts are not carried. A prior successor, including a cancelled or removed
one, consumes the predecessor's admission. Interrupted or refused queue handoffs
reuse that successor's dispatch identity; stopped successors are not dispatched.
Public controls acquire account admission before their Run lock. Ordinary and
retirement-authorized objective successors share account admission followed by
sorted hunt locks before predecessor, task and original-image locks.
Historical backfills carry their exact saved date range with no inferred
cursor. A plain historical account walk did not retain its starting boundary;
retry refuses that unknown scope and requires a fresh account-sync launch.
Historical selected-charge Runs validate the entire saved Hunt roster and
financial ownership before excluding allocated, settled or independently held
work. Consistent retained claim results preserve their amount and date range;
merchant and transaction dates absent from those results stay unknown. Unvisited
Hunts receive their first frozen snapshot from current owned context at
conversion. Conflicting retained claims refuse conversion rather than selecting
an arbitrary result. Conversion and every later retry share unresolved charge
eligibility, so a failed converted child cannot drop still-pending Hunts. Old
Runs and operations remain unchanged.
Retirement receipt/member authority is checked before returning an existing
successor, even if its account has since been removed or assigned newer work.
Fresh retirement admission rechecks authority, the complete original task
roster, and current financial ownership. Valid settled or held work is excluded;
missing or mismatched ownership is refused. With no eligible work, cleanup
records no successor and leaves the hunt and its original evidence intact.
Typed cleanup checks that roster even when no unfinished task rows remain.
Different receipt bytes can create a successor through evidence submission;
cleanup reuses that same owned predecessor-child relation, including when the
replacement is admitted while cleanup waits on a hunt. It never recaptures or
overwrites the replacement's selected original.

## Where to look

Account history may display short numeric order numbers and opaque detail URLs.
Page derivation reads ordinary anchors and single literal `location` navigation
handlers without executing JavaScript. Clickable table rows use their first
visible cell as the link label. The order classifier associates a hash-number
label with an allowlisted `/orders/<target>` link and the date following it on
the same captured row; a detail URL is not itself a history-page hint. Dynamic
handlers need browser navigation rather than a guessed URL.

| Need                                             | File                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| Queue event and bridge message shapes            | `packages/schemas/src/purchase-import.ts`                                        |
| Run lifecycle, claims, and terminal states       | `run-service.ts` (search the function name from above)                           |
| What the researcher may call, and its inputs     | `packages/schemas/src/research-tools.ts`, `server/purchase-agent/environment.ts` |
| Gmail discovery and retained mail                | `gmail/` (`discovery.ts`, `sync.ts`, `ingest.ts`)                                |
| Statement-charge hunts                           | `hunts.ts`, `charge-runs.ts`, `charge-hunt-state.ts`                             |
| Enriching imported Products (post-import, sweep) | `enrichment-sweep.ts`, `browsing-account.ts`                                     |
| Manual research admission and browser selection  | `product-research-run.ts`, `browsing-account.ts`                                 |
| Agent model, prompts, and MCP tools              | `server/purchase-agent/run-agent.ts`, `cubby-mcp.ts`                             |
| Scripted/workerd harness for the agent           | `apps/web/tooling/purchase-agent-workerd-harness.ts`                             |
| Its workerd runtime and `purchase-agent` profile | `apps/web/tooling/workerd-runtime.ts`, `workerd-harness.ts`                      |
| Billed model evals                               | `*.live-eval.ts`, `tooling/ai/eval-support.ts`                                   |

## Hidden dependencies

- The researcher uses focused workflow Markdown from `.claude/skills/purchase-import/`
  and `product-enrichment/`, with purchase extraction and settlement rules
  selected in `server/purchase-agent/import-run-workflows.ts`. Photo inventory
  retains its own skill bundle and readable reference resources. Bundled
  resources are not all injected into each research turn. Editing the selected
  instructions changes production behavior.
- `signals.ts` bytes are matched by the coordinator prompt and the workerd
  scripted model; keep them stable.
- The photo inventory agent mounts its purpose's MCP tools from the same compiled catalog
  the MCP server lists to it (`server/mcp/agent-tool-catalog.ts`), without
  listing them; renaming a tool or action changes both.

## Retired vendor-search execution

Known-vendor and unmatched-transaction priorities are mailbox-discovery scopes;
adaptive scoped searches use `research_mail_search` within an admitted research
Run. There is no separate vendor-search Workflow or retry adapter. Historical
`mail_search` Runs retain their original input, progress, failure and source
associations and remain readable through the generic Run presentation. Their
control endpoint refuses execution before changing any stored state.

Scoped pagination remains task/query/account-bound and replayable. An interrupted
classification or dispatch reuses its frozen page without advancing mailbox-wide
coverage. Mechanical mailbox discovery retains its own exact checkpoints,
cancellation, dispatch-failure handling and ended-instance reconciliation.

### Original purchase sources lead Product research

`work_next` supplies accepted order lines, current ledger context, and the
existing `purchaseOrderUrl` projection. It resolves canonical owned retained mail
into an explicit `originalMail.messageRef`; an order association is not a mail
selector. Issued originals are exposed through the existing retention fence
before delivery. The mail reader still enforces ownership, current checksum,
classification and disposal rules. Missing originals remain null and are
recovered through owned mail search or authenticated order history, without
inventing a mapping or rewriting historical source associations.

The maintained Product skill prioritizes those sources and exact item URLs.
Broader search resolves unavailable sources or remaining facts. Pi keeps hosting
the adaptive conversation; shared tools keep retaining observations and enforcing
writes. No new workflow, transport, status model or table is introduced.

### Retained capture maintenance

`run.rederiveCapture` is an authenticated operator-maintenance operation. It reads
an owned retained browser command, verifies its task-bound original checksum,
and derives a new interpretation under that command's original allowed hosts.
A revision-keyed completed RunOperation retains the interpretation and its
changed capture fields and supported fact fields. The generic Run log reports
that receipt. The original capture replay, accepted facts, source bytes and
settled targets remain unchanged; research of new evidence uses a new Run.
Retired Runs and missing/pending originals refuse maintenance.

### Mac member attention

The existing Mac notifier handles sign-in, denied Screen Recording or browser
Automation, and disabled JavaScript from Apple Events. Its account/Run/reason
edges are persisted before delivery, so reconnect replay cannot repeat an
unchanged alert. Successful page reads re-arm observed permission reasons; a
successful Run clears sign-in attention. Resolving an edge invalidates pending
delivery even when the same reason is re-armed during notification authorization.
Claims occur synchronously with projected attention; retired controllers cannot
deliver, and resolution during posting retracts only the stale generation.
Unrelated accounts and permission reasons retain their edges. Permission notices retain
the raw command diagnostic and name the setting to change. A newly observed
permission pause raises that account's owned Cubby browser window, only while
the controller remains installed. Sign-in retains the coordinator's existing
owned-window behavior. No new browser transport or Run state is introduced.
