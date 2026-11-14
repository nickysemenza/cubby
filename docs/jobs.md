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

`startPass` increments a wake sequence. A holder publishing an older page
cannot overwrite a newer cursor, completion or wait: the newer wake remains
due. Dispatch event admission and funding resets can use the same sequence.

`workflows/kernel-passes.ts` registers the platform passes:

| Pass                       | Key         | Checkpoint and outcome owner                                                                                                                                  |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.execute`              | Run id      | Step-ledger, AI-work and mailbox-discovery Runs; the cursor names the generation and frozen provider page; `RunStep` and Run progress keep committed outcomes |
| `purchase.dispatch`        | Run id      | Queued agent events and hosted model Asks; the Durable Object keeps its Pi transcript and alarms                                                              |
| `derived.snapshot`         | `default`   | One ordered snapshot cursor: target, last UUID, page attempts and aggregate progress                                                                          |
| `runs.reconcile`           | `default`   | Projects exhausted Run Passes and stopped dispatch execution onto Run status; checks active Runs every 15 minutes and idle work hourly                        |
| `purchase.discovery`       | `default`   | Sender-attribution learning, retained-Email admission and mailbox-discovery admission; `senderAfter` stays in the cursor                                      |
| `retention`                | `default`   | Bounded pruning of execution rows, hourly or immediately while a full page remains                                                                            |
| `fields.reconcile`         | Request key | Admit a requested fields scope and attribute its model Asks to the requesting Run                                                                             |
| `location.inventory`       | Location id | Requested inventory-evidence publication; each model turn is an Ask                                                                                           |
| `email.purchase-discovery` | `default`   | Retained Email evidence linked to purchase records, 50 UUIDs per page, restarting hourly                                                                      |
| `calendar.invalidate`      | origin      | Retries an idempotent dirty mark after the post-commit fast path failed                                                                                       |

The kernel also registers its version sweep. Model, embedding and image calls are Asks. External image/device producers use `queueAsk`, `claimExternalAsk`, `renewExternalAsk`, `releaseExternalAsk`, `cancelExternalAsk` and `settleExternalAsk`; accepted results become retained Answers. Inline model calls use `withAsk` with their Run and Pass requester. Hosted agent Asks retain each turn's answer while the coordinator owns its transcript and tools.

## Waits and limits

Funding waits are `funding` waits on Asks and Passes. Resetting funding makes waits due in database time and increments their wake versions in one statement, so a holder cannot publish an older wait over the reset. Provider capacity, rate limits, in-flight producers and device waits keep their causes and deadlines. A member pause or cancellation revokes the execution claim; retaining paid Answers does not authorize another model call.

`purchase.dispatch` uses the `household.agent-turns` ClaimLimit partition with six slots. Its live Pass holds one slot across a coordinator turn, its tools and its hosted model Asks. A hosted Ask borrows that live Pass's slot; independent Asks acquire their own slot in the same partition. At most six live turns run household-wide. The mail agent's Durable Object retains its alarms.

## Wakes and progress

Queue permits contain no work identity: the consumer invokes the kernel runner directly and schedules the next durable deadline. Claim admission arranges a recovery wake at the deadline. The hourly cron starts scheduled Passes, invokes the runner and sends a backstop permit. Lost or duplicate permits do not lose or duplicate persisted work.

`machinery` reads a record's scopes, gaps, inputs and Passes. `runWork` reads a Run's scopes, requesting Asks and Passes with stages and costs; Run waiting summaries read those claims. Pass rows keep bounded page-duration samples for pace and ETA. `needsYou` reports records requiring member input and serves the Work page, Home, navigation and MCP. The browser's filtered `/work-queue` list evaluates its sources live.

The derived snapshot Pass walks views and typed snapshots in one scheduled bulk cycle. Source writes stay quick; reads may lag by up to an hour. The cursor lives in Pass; current snapshot state is the derived progress read.

Retention repairs incomplete image execution and prunes completed Passes after eight days and cancelled Passes after fourteen. Unfinished work, Answers, source evidence, decisions, Run and RunStep stay. Calendar invalidation keeps its post-commit Durable Object fast path; only a failed mark starts the origin-keyed fallback Pass.

See [background derived data](entities.md#background-derived-data) for snapshot families and [database capacity](infrastructure.md#postgresql-and-hyperdrive) for connection limits.
