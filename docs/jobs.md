# Durable Jobs

The universal `Job` table owns execution state for background work: claims,
leases, generations, retries and waits. Domain rows keep their outcomes and
evidence. [ADR 0015](adr/0015-unified-durable-work-coordination.md) records
the decision; this page owns the runtime contract. Derived-data families are
in [entities](entities.md#background-derived-data); Worker and database
capacity in [infrastructure](infrastructure.md#postgresql-and-hyperdrive).

## Job entity and identity retention

Job is a read-only generic entity over the existing durable `Job` table. Web,
Apple and MCP use the entity kernel for list/detail reads. Its `JOB-` shortcode
has a ten-character body from the shared shortcode alphabet. Enqueue creates
its `Entity` identity and execution row atomically through the shared identity
writer; a repeat enqueue by key preserves both identities. Kind policy supplies
the lane and internal-kind flag. Subject Images supply thumbnails, and Run
references arrive with their labels in the row read.

The entity exposes execution state, lane, waiting-on text, subject, Run,
attempts, raw error, lease end and timestamps. Filters cover lane, waiting-on
reason, state, kind, Run, attention and internal kinds. Internal work is hidden
by default (`image.device.wake`, `queue.watchdog`, `jobs.retention`,
`ai-refresh.activate`, plus anything policy marks internal). Saved views are
In progress, Due, Waiting for Apple, Backing off and Needs attention. Retry now
uses `job.retryNow` over checked codes or the exact current entity filter.

Owning Run is the optional execution owner. Shared AI evaluations instead expose
all requesting Runs through their retained request membership, plus every typed
evaluation target. Product-pair evaluations expose both endpoints. Connected
records and graph traversal also expose typed entity subjects and the exact
Image processing record; a calendar origin is not an entity subject.

Job is the sole exception to permanent `Entity` identities: retention deletes
its identity in the same transaction as its pruned execution row. Retention also
reconciles a bounded batch of Job identities without a payload, including rows
orphaned by an old Worker's retention between committed backfill batches and
deployment. The pass is idempotent and never removes another entity kind.
Enqueue locks an existing Job through invalidation; retention skips locked
candidates, so it cannot prune a Job being invalidated or return a stale identity.
Queue work
churns at roughly 175,000 Jobs a week; retaining those identities forever would
make the identity index unbounded. A pruned `JOB-` code may be recycled and no
longer resolves; every other entity retains its identity and code forever.
Domain evidence, retained Jobs, failed work and invalidation ownership survive.

Migration `0036_job_entity_identity` adds and backfills codes and identities in
1,000-row committed batches, preserving every execution field and timestamp.
See the [production migration procedure](runbooks/production-migrations.md#job-entity-identity-backfill).

## Kinds and lanes

`apps/web/src/server/generic/jobs/kind-policy.ts` is the one registry of
per-kind policy. A kind absent there runs on the server drain and fails after
its row's `maxAttempts`. Each kind names its lane, the executor that runs it:

| Lane           | Kinds                          | Executor                         |
| -------------- | ------------------------------ | -------------------------------- |
| `apple_device` | `image.device`                 | an Apple device's pull           |
| `frontier_ai`  | `image.cloud`, `ai.evaluation` | the server drain, paid providers |
| `external`     | `purchase.dispatch`            | a coordinator outside the drain  |
| `server`       | every other kind               | the server drain                 |

`drained: false` parks a kind: the drain never claims it, so device work no
longer churns through server claims. Enqueueing device work rings connected
companions after commit, and a companion connecting to the doorbell is rung at
once; there is no polling interval. Work that comes due later (a failure
backoff, a deferral, a lapsed lease, a delayed release) rings through the
`image.device.wake` Job: each of those events arms it (`armDeviceWake`, a
restarting invalidation of its own Job, so an arm during a wake page is never
lost), and its page rings when parked work is claimable, then sleeps until
the next parked availability or lease expiry. A doorbell RPC failure fails
the wake page, so its retry rings again; reaching no open socket is not a
failure. A release with no delay also rings at once (best effort).

## Waiting on

`generic/jobs/repo/waiting-on.ts` is the single derivation of what a live Job
waits on; every client (web, Apple, CLI, MCP) and every rollup reads it.
Reads rank only the queues needed by the displayed statuses: device work does
not rank the server drain, and leased or backing-off work needs no queue rank.
`jobWaitingOn` in `packages/schemas/src/job.ts` is the wire vocabulary:

- `due`: claimable now; `aheadCount` in the drain's own selection order (the
  fair service order per class, interleaved per batch with backfill's reserve:
  `drainSelectionIndex`) and `etaSeconds` from claims over the last 30
  minutes. Only the next batch is exact: later batches re-rank kinds by their
  last service, so beyond `JOB_DRAIN.batch` the position is a projection and
  `aheadIsEstimate` is true (shown as "behind about N").
- `waiting_device`: parked device work; position in device claim order
  (`deviceSelectionIndex`, with backfill's turn), exact apart from a
  device's preference for work another device last ran.
- `waiting_funding`: an `ai_funding_window` wait until the window resets.
- `leased`: an executor holds it, named with its device installation id
  (`executorDeviceId`, null for cloud) and `leasedAt` (the claim time);
  `expired` once the lease lapsed unreclaimed.
- `backing_off`: a failure backoff or provider wait (`cause`) until a time.
- `blocked`: waiting on other work, such as a device preparing AVIF input.
- `paused`: stopped by a member or its Run.
- `update_required`: reserved for an Apple device that must update; the
  Apple client reports it. The server derives `Device.updateRequired` from the
  stored `appVersion` against `APPLE_CLIENT_MINIMUM_VERSION` instead.

Terminal Jobs wait on nothing. `jobWaitingOnReasonSql` mirrors the derivation
for aggregates; a regression keeps the two in agreement. Text surfaces render
one line through `describeJobWaitingOn` (and `describeJobRollup` for counts),
so a lapsed lease reads "Lease on … expired; waiting to be reclaimed", never
"In progress".

Declared entity fields carry the same facts to web, Apple and MCP:

- Run: `waitingOn` (the rollup line), `stalled`, `successorRunId` ("Retried
  as", the newest Run whose `predecessorRunId` names it; `predecessorRunId`
  reads "Retry of"), and `displayStatus` for the header. A `needs_review` or
  `failed` Run with a successor reads `retried` (its open work moved; its own
  findings stay on its sections), and an `execution_limit` stop reads
  `waiting_for_funding`. The stored `status` stays the filter.
- Image job: `waitingOn` for open rows.
- Device: `updateRequired`, `inactive` (not seen for 7 days or never) and
  `appleIntelligenceAvailable` (the hello's actual-image description
  availability, null until a hello reports it). Leases per device come from
  `job.queue` (`leases`), keeping the device list's core read to its page
  queries.

## Priority and fairness

`dueJobs` first selects `JOB_DRAIN.batch` fair seed Jobs. A selected batch
handler then fills its page from the same kind and ownership class to its
configured width, without consuming another kind's seed. The wake's remaining
Job budget bounds the expanded selection:

1. Jobs whose `runId` is a running, member-visible Run lead (routine Runs such
   as connection discovery do not).
2. Backfill (everything else) keeps `JOB_BACKFILL_SHARE` of every batch.
3. Within each class, a weighted round-robin across kinds: a kind's share of
   a round is `1 + floor(log10(backlog))`, at most `JOB_MAX_KIND_WEIGHT`, so a
   100k flood gets more slots but never starves another kind. Within a round
   the least recently claimed kind goes first; within a kind, priority, then
   age.

Selection reads one database snapshot for fair seeds, reserved pages and batch
widening. Timed Jobs and pending-capture wakes use separate scans, so terminal
history is not searched to find pending captures. Run classification joins the
active Runs once.
Evaluation lookups parse canonical Job keys and join the evaluation UUID primary
key, rather than scanning evaluation history through a concatenated text key.
Noncanonical keys retain their unmatched behavior and never fail a UUID cast.
Backlog counts still include all due Jobs after exclusions and
compute the logarithmic weight once per kind. Each kind and ownership/exemption
class contributes a bounded priority prefix before window ranking; an exempt routine Run cannot hide
ordinary siblings needed to widen another selected page. The latest claim comes
from the existing `(kind, lastClaimedAt)` index, including completed Jobs so that
finishing a page never erases its service history. Queue positions reuse the same
due snapshot and admitted selection; only their later-round projection ranks the
full due backlog. Claim-time admission remains authoritative across concurrent
drains.

Job source writes also respect the derived drain's member-first ordering:
root transactions in Job execution (including shared evaluation batches) mark
derived inputs at priority 1, while member transactions use 0. Savepoints
inherit the outer transaction's priority. This uses the existing dirty-mark
priority and does not add another queue or change Job selection weights.
Each root Job transaction adds one setup statement; savepoints and ordinary
member transactions add none. Publication query budgets include that fixed
cost while retaining their separate transaction-size bounds.

`JOB_KIND_POLICY.maxInFlight` optionally caps background claims across all
drains. Selection admits only the remaining capacity; claim-time admission
uses a nonblocking transaction advisory lock per kind and rechecks live leases
before committing a claim. Only `running` Jobs with `leaseExpiresAt > now`
count. Expired leases free capacity and remain reclaimable through the ordinary
due/claim path; completion and release also free it. `run.execute` and work
whose `runId` names any active Run bypass the cap and its accounting, including
routine Runs that do not receive member-visible priority. Shared evaluations
with no `runId` remain subject to background admission; live member demand
can still give them member-visible selection priority.

Every drained kind, including unregistered kinds, inherits strict background
shares: `maxConcurrentPages: 1` per drain and `maxInFlightPages: 2` across the
four queue consumers (half the configured consumer count). A kind never
borrows the spare capacity. A blocked image or maintenance page therefore
cannot occupy every lane or every consumer. Claim-time page admission uses
the same per-kind advisory lock and live-lease check as record admission.
A batch shares one page lease token, counted once while any member has a live
lease; each Job retains its own expiry, generation, cursor, and publication
fence against its Job ID. Completion/release of the final live member frees
the page. Expired tokens count nothing. Older individually tokened claims
count conservatively as separate pages until they settle or expire.

`ai.evaluation` allows **two live background evaluations globally**, matching
the inherited two-page share across queue consumers. A finite AI page enters
the kind cap once, then its independent target leases keep the cap occupied
until the last live target settles. Single claims share the same admission
lock and lease count. Blocked evaluations therefore never occupy more than two
of the four consumers or more than one of a Worker's three lanes, leaving room
for other kinds, including due embedding batches and image work. The cap was
one while a single Run's evaluations serialized on its row lock; with that
backlog gone, one evaluation at a time left due work waiting over 20 minutes. No separate
scheduler or refresh-family behavior changes. Queue positions are exact for the admitted
selection; work deferred by a cap is projected beyond that selection as an
estimate.

`embedding.refresh` fills **100 Jobs per page**, even with other kinds due.
Its policy reserves one background page slot and caps it at one page per
drain (`reservedConcurrentPages` / `maxConcurrentPages`); Run-owned work keeps
priority within the remaining lanes and bypasses per-kind page caps. A due
embedding page enters even a crowded seed selection and takes its reserved
execution lane before Run pages start; the other lanes remain Run-first.
An active Run-owned embedding page already occupies that reservation; it does
not grant another background page priority over the remaining Run work.
The fair seed selection still gives other
kinds their turns. Batch width counts records, not sockets: claims and
publications remain serial inside that one lane, keeping the three-page,
five-socket Worker budget. Small remaining backlogs, the wake's remaining Job
budget, competing claims, and provider token limits can produce a shorter page.
The 25-seed window does not cap a batch's claim list at 25.

The lease remains five minutes per Job, renewed every 30 seconds throughout
batch claiming, preparation and checkpoint publication. The 20-second drain
budget limits starting more work; it is not the lease duration. An in-flight
provider call can cross that budget and still checkpoint, while unstarted
claims are released. A blocked or failed sibling renewal does not prevent
healthy siblings from renewing.

The drain runs up to `JOB_DRAIN.concurrency` pages at once, and the
queue consumer (`packages/shared/src/background-queue-consumer.json`) runs
several drains. Free lanes refill fair selections while sibling pages are
still running, so a blocked page cannot hold the next selection behind a
batch-wide wait. Selected groups are reserved within the invocation until
execution finishes, including the unclaimed members of a batch. Page and time
budgets still bound new starts. A skipped claim stays excluded for the entire
invocation, so locked expired rows cannot repeatedly consume its budget ahead
of unlocked work; the next invocation may retry them. Completed Jobs are not
excluded, so immediately runnable successive pages still progress. Every Job
holds its own row lock and lease. AI evaluation Jobs
carry no `runId` because shared evaluations serve several Runs. Their live
owner/requester Runs supply member-visible priority; routine refresh remains
backfill. Within the AI kind, least recently served features take turns. Run views still attribute them: a Run's demand (`runDemandPairs`)
is its own Jobs plus the evaluation Jobs it owns or still requests (an
uncancelled `AiEvaluationRequest`), once each, for rollups, `job.queue` with a
Run, Retry now and explain.

Device pulls apply the same two classes to each command in a batch
(`generic/jobs/repo/device-admission.ts`): an active, member-visible Run's
parked work leads, and after `DEVICE_OWNED_STREAK` (`1 / JOB_BACKFILL_SHARE -
1`) run-owned device services in a row, the next command serves backfill. The
owed class is chosen first; a device's preference for work another device
last ran only orders candidates within it. A service is a device hand-off
that commits (an assigned attempt of `image.device` work; each reclaim
counts), classified at assignment by selection's own `jobRunOwned`: serving
an ended Run's work is backfill and resets the turn, and a Run ending later
never reclassifies services already counted. The streak lives in the
`image.device` row of `JobLaneAdmission`. A device pull
(`claimCompanionImageCommands`) claims, prepares, assigns and reserves output
in one transaction that locks that row before choosing a class, so
concurrent batches take their turns one at a time. Each committed hand-off
updates the streak before selecting the next command, so a wide batch keeps
backfill's reserved share rather than spending only one fairness turn. A hand-off the server
cannot make (participation turned off, output not reserved, preparation
failed) is released in the same transaction and counts nothing.

## Durable invalidation

A source capture appends its own UUID row to `JobInvalidationCapture` in the
save's transaction (`recordJobInvalidation`; the generated derived mark
function captures `derived:drain` once per writing transaction, ADR 0021). It never updates another capture, a long-lived
Job's execution row or the stable `JobInvalidation` policy. Genuine concurrent
source and image publications therefore share no mutable capture counter.
A rolled-back save leaves no capture. First-key policy, Job and capture
initialization commit atomically; ordinary captures never probe the Job. A
read-committed writer that loses concurrent first-key insertion reads the
committed policy in a fresh statement and appends its own capture. Serializable
initialization retains the owning transaction's existing conflict retry.

A Job with an unobserved capture is due, even when completed. A fresh claim
locks its Job and acknowledges exactly the pending captures visible in that
transaction, together with its new generation, empty cursor/result and fresh
budget. There is no maximum UUID, timestamp or allocation-order frontier:
an earlier-started capture that commits later stays pending. A refused or
rolled-back claim acknowledges nothing. `restartsPass: false` (the derived
drain) lets a page in progress finish and leaves newer captures pending, so the
finished Job is due again. Catch-up repeats a quiet drain each minute
(`scheduleDerivedJobs`) so backed-off marks resume. Restarting on each capture
kept broad passes from ever finishing under ordinary household writes (search
reached generation ~29k with new records unindexed); `image.device.wake` still
restarts.
The derived drain and reconcile never exhaust: a failing page backs off (1 min doubling to
15 min) and resumes. Never-exhausted kinds (`NEVER_EXHAUSTED_JOB_KINDS`) have
no terminal failure at all: the `Job_never_exhausted_failure` trigger (0033)
stores any `failed` write of one, such as an older build's final attempt, as
`retry_wait` with its error and attempts, at least a minute out; a guard test
keeps its kind list equal to the policy. Paused and cancelled remain member
stops. While parked device work exists, the watchdog creates a missing device
wake or requeues a completed one through `repeatJob` (`repeatDeviceWake`: an
insert that ignores conflicts and an atomic requeue of `completed` only, with
no capture), so device work an older build backed off without a wake still
rings; a waiting, backing-off or running wake keeps its schedule, retry
deadline, attempts and error. Publication of a restarting kind checks pending captures and supersedes
a page whose pass began before that input, as a generation change does. For
restarting kinds, a capture committing during publication or while a worker
dies is never lost: the new capture remains unobserved.
Failure does not end a restarting family either: execution checks pending captures
before its terminal write, so a capture can commit in between, and a failed
Job with pending restarting input is due again with a fresh pass and recovery
window. Paused and cancelled Jobs are member stops and never wake.

Health dates a woken Job from its first unobserved capture, so repeated
captures keep the original pending start. Catch-up (`repeatJob`) requeues only
a completed Job no capture has woken; a woken one is already due, so its date
stands. Waiting work that has not started its pass is due since the earlier
of its first unseen capture and availability. An in-progress non-restarting
pass is dated by availability; its follow-up pass is dated by the later of
capture and completion. Retention deletes only acknowledged captures: the
admitted Job retains recovery ownership if its worker disappears.

Retained completed Jobs far outnumber live work, so reads over many Jobs stay
index-backed. The shared due predicate (drain, positions, queue health, device
backlog) tests pending captures as key membership in the few distinct pending
keys; a BitmapOr then reaches woken Jobs through `Job_key_unique` and live ones
through `Job_due_idx`. A correlated capture EXISTS under OR tested every
retained row and took queue health 20–180 s in production. Recent-claim
windows (throughput, health) use `Job_claimed_idx`; the drain's last service
per kind probes `Job_kind_claimed_idx` once per backlog kind.

Migration 0034 locks Job, invalidation policy and captures before conversion.
It preserves each old capture and maps its observed state from the predecessor
Job revision. A pending marker without retained capture history gains a
capture at its old pending timestamp. Execution state, tokens, cursors,
availability, attempts, diagnostics and member stops stay unchanged. The
migration refuses orphan policy rather than silently dropping its work; old
revision writers fail atomically after this preserving direct cutover.

## Retries

A failed page of an exhausting kind waits `1 s · 2^attempts` (at most 60 s)
and fails after `maxAttempts`; each claim counts. A never-exhausted kind
(`exhaust: false`: image processing, the watchdog, retention) counts only
reported failures: a claim, a release, or reclaiming a vanished executor's
expired lease is not an attempt. It backs off from `baseMs` doubling to
`maxMs` (24 h for images) forever. `releaseJobClaim` hands a claim back
without counting (refunding an exhausting kind's up-front claim attempt); typed waits (`JobDeferredError`, funding) never count.

Retry now (`job.retryNow`, `retryJobsNow`) makes a filtered set due at once:
backoff and provider waits clear, prior errors stay, failed and cancelled Jobs
reopen with a fresh budget and generation, and running or member-paused Jobs
are left alone. A Run cancel is one set-based statement (`cancelJobsWhere`);
never-exhausted work belongs to its subject and survives a Run cancel.

`run.funding-resume` is keyed by funding window, not Run: its one handler
resumes every funding-paused Run. A funding-paused import stays `paused_auth`
rather than stopping for review; a legacy review stop with
`failureCode = execution_limit` resumes and continues with the window unless
a retry or restart successor names it as `predecessorRunId`: its open work moved
to the successor, so neither the window nor direct resume redispatches it. Run
control refusals are `RUN_CONTROL_REFUSED` (409), never 500.

## Image processing

Image processing is never abandoned. `ImageProcessingJob.state` stores only
the outcome: `pending` while open, `ready`, or `skipped` for a moot ending
(image deleted, upload replaced, processor superseded, type excluded: device
work on a source type no device command carries, such as a GIF). Only
the server decides a moot ending: an executor's `skipped` (`no_subject`,
`not_suitable`, `unsupported_format`) is recorded as a retryable failure that
keeps its reason code, backs off and asks for attention like any failure. A
stored `failed` is a legacy state of a superseded processor. The displayed
state derives from the Job (`image-job-state.ts`): `leased` for a live lease,
`waiting_for_device` for parked device work, `pending`, and `failed` ("Needs
attention (retrying)") once a job failed `JOB_NEEDS_ATTENTION_ATTEMPTS` times in a row
or its execution stopped; it keeps retrying. An executor's `retryable: false`
(say `deadline_exceeded`) retries later with its cause recorded; a missing
subject-lift derivative is rebuilt. A new processor revision is new work, and
a newer Apple build's first pull makes backing-off device work due.

`imageProcessingLane` fixes each job's lane: subject lifts, Apple descriptions
and AVIF cloud descriptions (which need device JPEG preparation) run on
devices; other cloud calls on the server. Device pulls claim parked work
directly and prefer work whose last attempt ran on another device.

Migration 0029 converted the pre-lane `image.processing` kind under a lock on
`Job`, then added `Job_kind_retired_check`, which refuses that kind. A
pre-cutover Worker's write of it waits for the migration and then fails, so
it is never accepted as work no handler serves; a rejected scheduling is
recreated by the image backfill. An execution an old Worker failed (claimed
`image.cloud` without a handler) needs no repair: image kinds never exhaust,
so a failed row is due again once available, with its attempts and backoff. The check retains no work and can be dropped once no
pre-cutover Worker can run; nothing reads it.

Device wire contract:

- `imageProcessing.pull` leases for `leaseSeconds` (default 60, 20–300) and
  accepts optional `maxCommands` (1–16, default 1). `commands` contains up to
  that many commands in hand-off order; the retained `command` field is its
  first item or null. Older clients keep receiving one command without an
  update or minimum-version change. A batch uses one transaction and one
  admission lock. A bounded candidate page per class avoids rescanning the full
  queue for every slot; each hand-off rechecks due times, leases and Run class
  within that page, preserving per-command capabilities, device preference,
  attempts, leases and presigned URLs. A prepared Job cannot re-enter the batch
  even if its initial lease expires during later preparation. Immediately before
  hand-off, still-owned leases are re-armed together and every returned command
  receives the fresh deadline. An empty array/null command means no
  hand-off: refused claims are released first. A preparation failure releases
  and backs off that claim. An already prepared prefix is returned; if there
  is none, the pull throws after the release commits. Neither valid commands
  nor the failed candidate can become invisible behind a batch error.
- `imageProcessing.renew` `{jobId, attemptId, deviceId}` extends the lease by
  60 s while the attempt still owns it, including an expired lease no newer
  claim replaced. It returns `{ok: true, leaseExpiresAt}` (the new command
  deadline) or `{ok: false, reason: "lease_lost" | "job_obsolete"}`; the
  device stops either way. Devices renew every 15 s.
- `imageProcessing.release` is never an attempt.
- `imageProcessing.complete` after expiry is adopted while the token is
  unchanged; after a newer claim it returns `{adopted: false}` and a late
  failure is kept in the old attempt's history.

A typed provider wait or an exhausted AI budget is never an attempt on any
cloud call, including the description of a device-normalized AVIF
(`deferCloudAttemptForTypedWait`): the claim is released until the wait ends.

A photo-inventory Run's description gate accepts the Apple or the cloud
description; `cloudDescriptionMissing` and `withoutCloudDescriptionCount`
note photos grouped while their cloud description waits (for funding, say).
A description that settled without one (`failed` or `skipped`) holds the
Run for the member, who can continue without those photos; the coordinator
never starts on a photo it has no description for.

Each image job reads `leaseDeviceId` (the `DEV-` code whose attempt holds
the lease, live or expired) and `leaseExpiresAt`. Its saved views are
`waiting-for-apple` and `processing` (live leases).

## Diagnostics and repair

- `job.queue`: live Jobs counted by lane and waiting-on reason, the set's
  leased image work per executor (`leases`: live and expired), and a page of
  matching Jobs with their `waitingOn`.
- `job.runRollups` and `job.list` (`rollup`): a Run's live Jobs by reason
  (`leased` counts live leases; lapsed ones are `expiredLeases`, summarized as
  "N expired leases awaiting reclaim"), its own funding wait, and `stalled`
  when nothing was claimed or finished for `RUN_STALL_MS` and no live lease is
  in flight. `job.list {runId}` groups the Run's demand, including AI
  evaluation Jobs it requests.
- `job.explain {id}`: the waiting-on chain for a `RUN-`, `IPR-` or `EML-` code
  or a Job id, on MCP (`maintenance`) and `cubby call`.
- `job.health`: `{snapshot}`, the queue watchdog's latest measurement, null
  before its first page.
- `job.deviceBacklog`: due Apple-device work, the Runs it holds up, devices
  that started an attempt in the last ten minutes (`Device.lastSeenAt` moves
  only on hello), device attempt starts per minute (reclaims included) and the
  ETA at that pace.

Web Activity presents the unhealthy-only health notice, device backlog banner,
compact lane/reason counts, Runs needing attention, then Jobs.
Navigable counts use the Job entity population, hiding internal work with the
table; queue health continues to measure internal kinds. Every supplied retry
restriction intersects, including mixed entity filters, row IDs and Run scope.
Count chips scope the Job table; web records that scope in Activity's URL.
Runs use the generic `attention` saved view: member-visible stopped Runs that
have no successor, plus stalled Runs, ordered stalled first then newest.
The embed shows ten rows and links to all matching Runs. AI cost is the Run's
recorded charged usage. Jobs use the generic In progress view, including image
subject thumbnails, and a chevron expands Explain, that Job's Worker logs and
Retry now underneath its row. Closed web rows remain 32 px. There is one
shared table renderer; the separate image-processing roster and hand-written
queue rows, pickers and pager are removed. Apple Activity hands the household
queue off to `/work-queue`
([native Activity](../apps/apple/README.md#activity)).
The web audit-log changes feed follows the queue.

The `queue.watchdog` Job re-arms every five minutes from the minute cron. It
first repairs image execution in bounded batches (retires moot work, reopens
legacy leased rows, gives open rows without a live execution one; failed
image executions count as live), then measures
per-kind due count, oldest due age, claims per minute, due growth, expired
leases and image/Job disagreement against `QUEUE_ALERT_THRESHOLDS`.
`no_claims` fires when a drained kind with due work had no claims in the
window, or when a Job stayed due through the whole window although the
kind's claims could have served every due Job (claims of one family do not
cover another). New
alerts log at error level with raw numbers; Activity reads them through
`job.health`. There is no household push channel for them: push
registrations exist only per photo Run.

The `jobs.retention` Job prunes completed and cancelled Jobs older than
`JOB_RETENTION_MS`, and observed capture times, in bounded batches. Failed Jobs, embedding Jobs (their
cleanup reads finished rows), and all domain evidence (image attempts, AI
evaluations, Run history, audit) stay.

A kind's `maxQueued` is a watchdog bound, not an admission gate: the watchdog
raises `over_capacity` past it, and producers pace themselves (see Producers).

## Producers

Queue messages are best-effort wake-ups for intent already committed in
PostgreSQL. The shared `wakeJobs` sender uses the fetch request's `waitUntil`
lifetime, so a slow queue send does not delay a committed mutation receipt.
Without a request context (including queue and cron invocations), the caller
still awaits the send. Queue failures are logged and cron recovers committed
work; transaction rollback schedules no wake. Producers use this same sender
rather than implementing their own request-lifetime branch.

A producer must not enqueue faster than the drain can serve. One unbounded
connection-discovery pass once enqueued an evaluation for every household
record (~55k), which starved every other kind for days.

- Routine connection discovery (`discovery.connections`) holds its cursor while
  `CONNECTION_DISCOVERY_PENDING_CAP` connection evaluations wait (`rate_limit`),
  walks the newest records first, and never appends to a stopped Run. A changed
  record updates its queued slot in place, retaining its Job. Cancelled work whose Run
  failed with `failureCode = "superseded"` (a cleared backlog, not a member's
  decision) is re-admitted at that pace; a member's cancel stays final.
- Publication correction work is one `assessment.correction` Job per
  publication commit (`targetAssessmentIds`), not one per assessment; sources are
  still resolved after commit under serializable isolation.
- `run.funding-resume` is one Job per funding window; its handler resumes every
  paused Run.

Each AI evaluation slot identifies feature, entity, record, field and (for a
Product pair) the other Product. A generated text key uses UTF-8 length prefixes;
input and option fingerprints remain execution evidence, outside the slot key.
A partial unique index permits one `queued` or `retry_wait` row per slot.
The pending share-key lookup is nonunique: input can revert to a running
attempt while a queued successor already exists in the slot.
Changed input updates that row's snapshot, target, provenance and work key in
place and clears any result, receipt or error captured for its older input.
A running or result-ready row keeps its captured evidence; one queued
successor may wait beside it. A failed running attempt becomes obsolete when a
queued successor already occupies its slot; it cannot re-enter `retry_wait` beside
that successor. Completed current input is not queued again for `ai_refresh`. Member-initiated
sweep, reclassification and retry requests get a fresh evaluation; running
work and pending slots can still be shared.
Reverting after another input was evaluated creates a new row and reuses the
AI response cache. Declined input (`blocked`, `obsolete`, or cancelled as
superseded) receives at most three automatic attempts; member-cancelled Runs
veto automatic readmission. Attempt suffixes keep work keys unique without
receipt chains. Explicit member retries retain their `retryEvaluationId` receipt.

### Embedding execution

Search publication admits embedding demand as one cohort: it locks existing
Jobs in key order, retires superseded hashes together and checks selected
artifacts in a batch. Unchanged current Jobs retain their identity and state
without per-record savepoints or enqueue lookups.
Indexed `subjectKind`/`subjectId` locate a source's Jobs for cohort locking and
retirement; JSON supplies only the content hash and embedding configuration.
Admission reads only identity and state, not retained text and result payloads.
New work still uses canonical Job admission; a completed upload no longer selected gets a fresh
physical identity when its text returns.

`embedding.refresh` uses the shared drain's kind-level batch handler. When a
normal fair selection includes embedding work, the drain reselects up to 64
Jobs with the same run-first, backfill-reserve and weighted kind ordering.
Run-owned and backfill embedding Jobs form separate batches. Each batch occupies
one of the existing three execution lanes; claims, lease renewals and publication stay serial within that lane;
freshness and visibility use bounded shared lookups, so widening embeddings
does not multiply database sockets or change other kinds' concurrency.

Each completed provider/upload chunk checkpoints its own Job receipts before
another provider call starts. The handler checks the shared 20-second drain
deadline between chunks; an in-flight chunk and its publication may finish past
that deadline, but no later chunk starts. Unstarted claims are released, refunding
the up-front claim attempt for exhausting kinds. The next wake reselects fairly,
so newly arrived Run-owned work can lead instead of waiting for every long input
in the original batch.

Serial claiming stops once it has used `JOB_BATCH_CLAIM_SHARE` (40%) of the
page's remaining drain budget; the claimed prefix executes and unclaimed members
stay due for the next wake. On a saturated database a full-width claim loop
otherwise spent the whole budget and released every claim unexecuted.

One heartbeat renews only the batch's pending claims, serially on one database
socket. Each renewal catches its own failure and uses `FOR UPDATE SKIP LOCKED`
to avoid waiting on another transaction's Job-row lock. A refused or failed
renewal leaves that Job's existing deadline intact; healthy siblings still renew.
An expired claim cannot renew or publish after reclamation, and completed
checkpoints leave the heartbeat set immediately.

Fresh submissions with the same stored provider/model/dimensions share one
embedding call and Vectorize upload. Requests contain at most 64 texts, below
OpenAI's 2,048-input limit, and at most 300,000 UTF-8 bytes, a conservative bound
on its 300,000-token request limit. Inputs over 8,192 bytes run alone, preserving
provider validation of the 8,192-token input limit without failing neighbors.
[OpenAI owns these provider limits](https://developers.openai.com/api/reference/resources/embeddings/methods/create).
A configuration mismatch settles as obsolete and re-admits current work during
that Job's fenced publication. A request pins the validated current configuration,
keeping content addressing and selected-vector provenance consistent across changes.

Every Job retains its own claim, generation, retry budget, physical vector ID,
upload hash and visibility receipt. Stale sources settle alone; a failed provider
or upload chunk retries only its member Jobs under the existing policy. Visibility
checks and final source/input checks still run per Job, and publication rejects
revoked claims. A shared call has no single Job publication owner; cache contention
defers it as background work instead of polling. `AiUsage` keeps one row per
provider call (plus existing application-cache-hit rows), attributes a shared
call to the daily background Run without choosing an arbitrary entity, and records
the provider's total tokens once. Embeddings remain outside frontier funding caps.

## AI evaluation pages

`ai.evaluation` keeps its existing `{evaluationId}` Job input and per-target
slot, input hash, history, token and generation. Product and canonical
`product_pair` refresh work run as transient pages of up to 100 compatible
slots: one feature, preparation shape, execution kind and priority class.
`claimJobPage` locks eligible Jobs with `FOR UPDATE SKIP LOCKED`, assigns
independent tokens, then `claimAiEvaluationPage` rechecks live authorization,
activation and pending/result-ready state before adopting the claims. Claim
reads Run authority without a lock and skips cancellation's item locks.
Queued obsolete generations retire in sets before inference; paused authority
parks its Jobs without spending attempts. No model work holds a claim
transaction open. Page and single claims use the same `job-kind:<kind>`
nonblocking admission lock and fresh live-lease count when `maxInFlight` is
configured. With a cap of one, a page enters once and its per-target leases
keep the kind occupied until the last live target settles. Active Run
exemptions follow the shared kind policy. Heartbeats renew the exact token/generation set in one
statement; replaced tokens are reported separately and cannot publish.

Feature fairness uses bounded prefixes per feature and exemption class, then
a bounded prefix per kind before window ranking. It does not rank the entire
due backlog. Queue diagnostics retain the existing projected-position query;
the admitted selection carries feature anchors through the same snapshot.

The drain admits at most one page per feature/class turn in a fair batch,
removes duplicate anchors, and then reselects. Other features and Job kinds
keep their turns and backfill retains its reserve. Queue and Run counts still
count target Jobs; AI ahead positions are estimates because one page can
capture many targets before the next selection. Ordinary ahead positions count
page services; target counts remain unchanged.

`EvaluationPageAdapter` in `ai/repo/evaluation-page.ts` owns finite feature
preparation, decision evaluation and publication results. Every target carries
its own evidence digest. Each preparation/provider continuation retains its
own Job/workflow execution context. The executor interns one usage context
per compatible Run/feature/operation/force/funding group; Product pages use
`product-identity` with default force/funding policy. The shared context carries
no target Job/entity id. Distinct Runs remain separate usage groups.
`settleDecisionWorkItems` supplies finite waves; `DecisionRequestBatch` packs
up to 64 questions/32,000 text bytes, with four request chunks in flight.
Routing, response-cache keys and per-question avoided usage stay unchanged.
An oversized question fails visibly. Page evidence is limited to 4 MiB; an
unadmitted suffix stays due rather than completing its enumeration receipt.

Publication commits at most 25 outcomes per SERIALIZABLE transaction, using
the existing bounded snapshot-write retries. Locks follow Run, slot, item,
then Job order, compatible with cancellation and admission. The explicit
claim-set guard authorizes each target without borrowing a sibling's AsyncLocal
context. The feature adapter revalidates each evidence digest and member
decision before business writes. Evaluation state, uncancelled requester
receipts and Jobs settle in sets in the same commit. Explicit
`retryEvaluationId` receipts survive. One final activation/dependency fence
and one set-based before-commit Job check cover the chunk; requester/owner
coordinators wake through one deduplicated update and after-commit signal.

Preparation/decision failures settle individually. A failed publication chunk
splits only after its transaction rolls back; committed siblings never replay.
Capacity/funding waits release affected claims without spending a failure
attempt. Failure and stale-claim coordinator wakes run after commit, so they
never reverse cancellation's Run/item/Job lock order. A failed old attempt
cannot re-enter retry-wait beside its queued successor. Cancelled or replaced claims never gain publication authority from
a fresh sibling. Source-to-pair enrollment finishes before the source receipt;
Run completion still includes its requested pair work. Refresh coordinators
read state counts, error summaries and bounded pending identities; they never
reload frozen inference payloads just to update progress.

Product discovery reads snapshots for the scan page and schedules one roster
transaction, reusing the activation's shared refresh owner. Slot admission,
evaluation/request insertion and fresh Job/Entity identity insertion use set
writes. The Product adapter uses `prepareProductIdentityPage` and
`publishProductIdentityChunk` for shared preparation and publication. Source
edges enroll in guarded chunks of at most 25 sources, 25 business
publications and 100 enrollment edges before enumeration receipts, and
canonical pairs share decision waves. Standalone catalog evaluation reuses the
candidate read's source eligibility instead of repeating its snapshot; pair
evaluation and publication retain their current-input fences. Semantic coverage
uses the shared direct/fanout dirty-mark probe once per page. [#3320](https://github.com/nickysemenza/cubby/issues/3320)
owns full synthetic throughput acceptance.
Full re-check scheduling remains gated on that acceptance; no production
throughput improvement is established by the page lifecycle alone.

## Apple version gate

Device work stops when the server refuses an older build's writes (HTTP 426):
the worker stops pulling and shows "Update required to process images". Raise
the minimum only for unsafe writes; see
[breaking changes](agents/domain-rules.md#breaking-changes).
