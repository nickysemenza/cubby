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

Execution allowance is separate from causal lineage. A member's explicit
approval is an immutable, completed background Run; completed RunOperation
receipts retain every conservative paid reservation and distinct candidate or
Product claim. Descendants and retries copy the host-issued
`executionAuthorization` reference while preserving their real parent and
predecessor. The latest approval for each member, mailbox and scope kind cannot
fall back to an older allowance after revocation or invalidation. A blocked
pilot, backfill or continuous scope does not block another scope or mailbox.
Approval roots have no coordinator or leased jobs.

Paid decision inference reserves the exact catalog model's full billing bound
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
Production research chat requires the connected ChatGPT subscription;
disconnect or selected-plan failure cannot switch to paid chat inference.

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
The source checksum, mailbox exclusion, member ownership and exact predecessor
are checked again under source locks before the predecessor Run lock. Another
Run's source cannot transfer implicitly. One canonical successor is replayed
across controls, preserving its frozen scope and cancelled or removed state.
New attempts preserve the real causal parent and leave unknown historical
attempt numbers null. Admission and dispatch are separate: queue publication
waits for the outermost transaction to commit and is discarded on rollback.
Frozen mail scope is a list of original UUID/checksum pairs. Each original owns
its mailbox provenance; one Run may investigate retained sources from several
owned mailboxes without confusing repeated provider message IDs. Fresh searches
can choose any connected owned mailbox. Pagination remains bound to the issued
Run, work, query and account; retained context never steals another Run's source.
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
an operation's successful response.
Photo inventory keeps its explicitly selected shared owner and live initiating
member; that permission never grants research another member's source scope.

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
   Work iteration and completion accounting belong to the host. Unresolved
   targets remain visible; a settled conversation does not imply verification.
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
Overlapping source receipts share the first persisted browser-disposal identity
and each retired Run's unfinished-work disposition, including an empty result.
They reuse an existing successor even after its cancellation or after the
predecessor's task descriptors are erased. Mail continuations exclude every
already-retired source/checksum, not only the source named by the current
receipt. A conflicting persisted disposition stops cleanup for diagnosis.
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
| Gmail discovery and retained mail                | `gmail/` (`discovery.ts`, `sync.ts`, `ingest.ts`, `search-job.ts`)               |
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
