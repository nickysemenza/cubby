# Kernel work

The kernel owns durable work under one claim protocol ([ADR 0029](adr/0029-evidence-facts-and-reconcilers.md)). Domain rows retain evidence, outcomes and member decisions. Run and RunStep retain workflow history, checkpoints and cost evidence.

## Scopes, Asks and Passes

A dirty scope reconciles a record from its declared inputs. An Ask owns a
producer request and its retained Answer. A Pass owns resumable work whose
checkpoint does not belong to one record's reconciler. All three use a claim
token and deadline, renewal, attempts, backoff, wait cause and cancellation.
Publication requires the current live claim. A Pass claim lasts 90 seconds;
Run execution renews every 30 seconds; the kernel arranges a recovery wake at
each claim deadline. Expired claims admit another worker. A funding or provider wait
keeps its deadline and cause without spending a failure attempt.
Database connection loss, including an unusable client after a drop, backs off
without spending a failure attempt. Shared connection, capacity and control
failures retain their batch; target or unclassified faults may split a batch
to isolate the affected record.
A sent Ask whose producer call failed is `unknown` unless the call proves it sent
nothing: an admission hook refused it before the request, or the provider
answered with a classified funding or configuration stop. That Ask returns to
`queued` with its wait cause and no spent attempt, and a funding reset releases
it. A producer that finds its input stale also returns the Ask to `queued`
without spending an attempt and reruns its waiting scopes, which drop it when
their inputs moved on. An Answer's `costMicros` is the charged cost of the usage rows its produce
call wrote, or null when one is unknown.

An Ask or Pass declaration may name a `claimLimit` partition and slot count.
The household shares those slots across both tables, including inline
`withAsk` calls. Admission serializes under a short database lock, counts only
live uncancelled claims, and releases the lock before doing network work. A
full partition parks work for 15 seconds with `provider_capacity`; it spends
no attempt. Renewals keep a slot; completion, cancellation or expiry frees it.
All declarations using one partition must use the same slot count.

An ordinary `startPass` advances a wake sequence. A holder publishing an older
page cannot overwrite a newer cursor, completion or wait. Dispatch event
admission and funding resets can use the same sequence. A start of an active
`purchase.discovery` with attempts left records one pending restart without advancing that sequence.
The fresh census is due at the later of completion or 15 minutes after the
current census started. A start after completion follows the same floor, and
starts before the queued census begins share that census. An active
`purchase.mailbox-discovery` records one pending rerun, due at completion.

`workflows/kernel-passes.ts` registers the platform passes:

| Pass                         | Key         | Checkpoint and outcome owner                                                                                                                                                                                                                                              |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.execute`                | Run id      | Step-ledger, AI-work and mailbox-discovery Runs; the cursor names the generation and frozen provider page; `RunStep` and Run progress keep committed outcomes                                                                                                             |
| `purchase.dispatch`          | Run id      | Queued agent events and hosted model Asks; the Durable Object keeps its Pi transcript and alarms                                                                                                                                                                          |
| `derived.snapshot`           | `default`   | One ordered snapshot cursor: target, last UUID, page attempts and aggregate progress                                                                                                                                                                                      |
| `runs.reconcile`             | `default`   | Projects exhausted Run Passes and stopped dispatch execution onto Run status; checks active Runs every 15 minutes and idle work hourly                                                                                                                                    |
| `purchase.discovery`         | `default`   | Email UUID pages for sender learning and retained mail, Shipment UUID pages for late linking. A budget stop checkpoints completed and skipped admission work. Skipped Emails appear in the page’s Pass error, are reported to Sentry, and are retried by the next census. |
| `purchase.mailbox-discovery` | `default`   | Gmail mailbox admission, independent of the retained census cursor. Bounds Run reconciliation, sender proof for configured Vendor addresses, planning, and per-mailbox admission transactions.                                                                            |
| `retention`                  | `default`   | Bounded pruning of execution rows, with immediate image-event pages until the cursor wraps                                                                                                                                                                                |
| `fields.reconcile`           | Request key | Admit a requested fields scope and attribute its model Asks to the requesting Run                                                                                                                                                                                         |
| `location.inventory`         | Location id | Requested inventory-evidence publication; each model turn is an Ask                                                                                                                                                                                                       |
| `email.purchase-discovery`   | `default`   | Retained Email purchase-link suggestions, up to 50 Email UUIDs per page. Email preparation timeouts are logged and checkpointed past.                                                                                                                                     |
| `calendar.invalidate`        | origin      | Retries an idempotent dirty mark after the post-commit fast path failed                                                                                                                                                                                                   |

Retained admission caps statements at 3 seconds after the household gate.
The gate arms the 20-second transaction limit before waiting up to 2 seconds.
It stops starting transactions with 30 seconds left on the
90-second claim, giving roughly 60 seconds to start work on a page. A budget
stop settles the partial page successfully and the next claim resumes at the
saved mailbox, admission stage and sources. The next clean page clears the
Pass error.

The kernel also registers its version sweep. The hourly cron run starts it when scopes sit on older rules; queue deliveries do not check. Model, embedding and image calls are Asks. External image/device producers use `queueAsk`, `claimExternalAsk`, `renewExternalAsk`, `releaseExternalAsk`, `cancelExternalAsk` and `settleExternalAsk`; accepted results become retained Answers. Inline model calls use `withAsk` with their Run and Pass requester. Hosted agent Asks retain each turn's answer while the coordinator owns its transcript and tools.

## Waits and limits

Funding waits are `funding` waits on Asks and Passes. Resetting funding makes waits due in database time and increments their wake versions in one statement, so a holder cannot publish an older wait over the reset. Provider capacity, rate limits, in-flight producers and device waits keep their causes and deadlines. A member pause or cancellation revokes the execution claim; retaining paid Answers does not authorize another model call.

Recovering a Run that conflicts with another active Run waits 30 seconds with
`provider_capacity` before rechecking admission. The wait spends no attempt.

A Run page that needs an Ask of unknown outcome pauses the Run with `ask_outcome` and checkpoints the Pass without a deadline or an attempt spend. The Run's machinery shows the Ask's retry and abandon decisions. A Run that had already failed on the Ask shows the same decisions; settling the Ask there leaves that Run failed until a member retries the Run. A member retry accepts a possible repeat charge. Settlement, including a late Answer, wakes the Pass to replay the retained page. A discovery pause frees its mailbox slot and announces the vacancy after commit. A parked automatic discovery page keeps ownership of its query cursor or the mailbox history cursor. Other automatic discovery scopes can use the vacancy. The woken discovery Pass goes through mailbox admission before it resumes. Abandoning mailbox triage leaves an uncertain verdict for relevance or the member to decide. Abandoning relevance preserves the uncertain verdict. Both allow the page to advance coverage.

A mailbox-discovery Run that finds no free mailbox slot pauses as `mail_discovery_queued` and its Pass waits five minutes. Announcing a vacancy makes due the live waiting Passes it admits, in queue order, and increments their wake versions; the waiting Run's admission wait is the authority, so a stale funding marker on its Pass does not hold the wake back. A yield or an authorization pause announces under the mailbox admission lock in the transaction that frees the slot. Completion, member cancellation and an exhausted Pass hold the household write gate, which must be a transaction's first lock, so each announces after commit in a transaction of its own: admission lock, waiters, their Passes, never the gate. A funding pause announces the same way once its pause commits. A failed announcement is reported, never thrown into the transition. Waiters check and park under the same lock and read committed status, so either a waiter sees the vacancy or the announcement sees its wait. The five-minute deadline recovers what is never announced: a failure or crash between a commit and its announcement, a funding-paused worker that stops before announcing, a waiting Run whose Pass spends its final attempt, and a queued owner leaving the queue without a status write. Database lock or capacity errors retry after 15 seconds.

`purchase.dispatch` uses the `household.agent-turns` ClaimLimit partition with six slots. Its live Pass holds one slot across a coordinator turn, its tools and its hosted model Asks. A hosted Ask borrows that live Pass's slot; independent Asks acquire their own slot in the same partition. At most six live turns run household-wide. The mail agent's Durable Object retains its alarms.

## Wakes and progress

Queue permits contain no work identity: the consumer invokes the kernel runner directly, then offers the next durable deadline, including the next result-alert claim or retry. A permit is sent only for claimable work: work a runner claim would select now or at a known time. The next deadline is read with the claim statements' own predicates, so exhausted, hosted, externally executed, unregistered, cancelled and finished rows never schedule a successor. At most one future permit is pending: the `KernelWake` row holds its time, an offer sends only when it moves that time earlier or finds it empty or past, and a delivery clears the row when it carries the pending time ([ADR 0029 §7](adr/0029-evidence-facts-and-reconcilers.md#7-three-work-forms-one-claim)). Immediate commit wakes and device ring wakes are always sent, and only by the writer that created or brought forward claimable work: a write that dirtied a scope, an Answer or Ask settlement that dirtied a scope or made a waiting Pass due, a member's `reconcileNow` or Drift approval however it ends, a queued Ask the runner produces, a prepared rendition that brings device-waiting image work forward, `startPass`, a member retry, a funding release that freed work or failed part-way, and a Run retry or relaunch that revives Asks. A writer outside one transaction registers the wake right after its first durable write, so a later failure cannot skip it. An ordinary source write that creates no kernel work sends nothing, and a start of a spent Pass sends nothing unless it revives the Pass. An expired Pass claim spends one attempt. A replacement starts after the same backoff as a failed attempt, measured from lease expiry. A Pass page counts consecutive transient failures separately from attempts. It starts with the normal attempt delay, doubles on each retry up to one hour, and spends an attempt every five transient failures. When attempts run out, Work shows the page as Stuck with its last error. Funding, provider capacity and other waits keep their own deadlines. A successful page resets its attempt budget and transient streak. Every wake for a deadline is classified and sent only after the writer's transaction commits. Claim admission outside a delivery, a timed `startPass`, a Run's funding pause and a Pass page that publishes a future wait offer their own deadlines; inside a delivery, redelivery of the unacknowledged permit covers a crash. A backoff settled by an in-line producer call outside a delivery sends none: like offers refused while a permit was pending, it waits for the next pending wake's delivery or the hourly cron. A delivery whose runner stopped on its budget with work due continues immediately; one that drained while a row became free without a writer retries after 15 seconds. The hourly cron starts the scheduled Passes, invokes the runner and sends a backstop permit. Lost or duplicate permits do not lose or duplicate persisted work.

Starting or retrying a Run with attempts left preserves its active transient
backoff. Work offers a retry after the Pass spends its attempts. The hourly
snapshot start revives an exhausted snapshot and preserves active transient
backoff while attempts remain. An explicit rebuild clears snapshot backoff
and makes the retained page due now.

The hourly cron revives spent `runs.reconcile` and `retention` Passes.
It starts `purchase.discovery` and `email.purchase-discovery` without revival.
Spent discovery Passes stay Stuck in Work until a member retries them.
A Work retry of `purchase.discovery` resumes the retained census at its saved
cursor and requests Gmail mailbox planning in the same transaction. A Work
retry of `email.purchase-discovery` resumes only its Email suggestion scan.
A `maintenance.purchase-discovery` task requests mailbox planning only if its
census start leaves the census with attempts remaining. A member can also
request mailbox discovery directly. Each purchase census page requests Run
recovery, as does daily maintenance.

`machinery` reads a record's scopes, gaps, inputs and Passes. `runWork` reads a Run's scopes, requesting Asks and Passes with stages and costs; Run waiting summaries read those claims. A Pass that reports a page duration keeps the latest twelve samples for pace and ETA. Recording a sample requires only the Pass claim fence. `needsYou` reports records requiring member input and serves the Work page, Home, navigation and MCP. The browser combines kernel gaps with distinct records from the member's human Work queue. Kernel rows come first, with their actions and ordering preserved. One kernel statement returns the requested page and exact combined count. The browser's filtered `/work-queue` list evaluates its sources live.

The derived snapshot Pass walks views and typed snapshots in one scheduled bulk cycle. Source writes stay quick; reads may lag by up to an hour. The cursor lives in Pass; current snapshot state is the derived progress read.

Retention repairs incomplete image execution and prunes completed Passes after eight days and cancelled Passes after fourteen. It pages through image events older than 30 days in timestamp and ID order. Each page rechecks eligibility under the publication fence and commits the deletion with the cursor. The cursor advances past protected events and wraps at the cutoff, then waits an hour. Unfinished work, Answers, the latest receipt for each image attempt, bound evidence, source evidence, decisions, Run and RunStep stay. Calendar invalidation keeps its post-commit Durable Object fast path; only a failed mark starts the origin-keyed fallback Pass.

See [background derived data](entities.md#background-derived-data) for snapshot families and [database capacity](infrastructure.md#postgresql-and-hyperdrive) for connection limits.

## Background result alerts

Opted-in household members receive Apple push alerts for committed unattended
Task, Purchase, Expense and Shipment creations. Entity declarations own eligibility,
amount fields and related-result grouping; an Expense belonging to a Purchase
appears as that Purchase. Supporting records, updates, duplicate matches, direct
manual creation, foreground imports, interactive agent sessions and unapplied
proposals do not notify. Run-attributed creation receipts prove unattended origin
through their scheduled or discovery ancestry. Manually launching a workflow
whose Run declaration is scheduled also qualifies its background results. Manual
interactive work, foreground and backfill ancestors remain excluded. Kernel apply
receipts alone do not prove origin.

A creation receipt admits each enabled device's delivery in the same transaction.
Delivery identity is the device and created record, independent of retries or Run
successors. A fixed two-minute window starts with the oldest pending result;
later arrivals cannot extend it. Claimed batch membership and its collapse key
survive retries. Network requests run outside database transactions. The existing
background queue carries deadline wakes and the hourly backstop recovers missed
wakes. APNs acceptance records provider acceptance, not device display; ambiguous
retries can repeat a displayed alert.

Alerts contain titles, details and amounts where available. An existing cover may
supply a bounded thumbnail; image failure leaves complete text. Single-result taps
wait for restored sign-in and open the live entity; missing targets and digests open Changes by Cubby. Neither
image research nor enrichment delays an alert.

Device notification registrations are private credentials bound to the current
member, authenticated app session, app identity and APNs environment. Notification
Settings opts this device into background results independently of photo-import
preferences and Live Activities. Token rotation preserves pending results for the
same member and fences late delivery responses; opt-out, logout and owner changes
make old registrations ineligible. Retiring a Device removes its delivery state.
The web Device Notifications section sends a test through the same transport and
reports APNs acceptance or the provider failure.
