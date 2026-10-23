# ADR 0015: Unified durable execution and broad refresh

Status: Accepted.

## Context

Several independent schedulers owned leases, retries and recovery for the same
work. A saved mutation could lose its follow-up work between database commit and
queue delivery. Dependency frontiers, revision clocks and retirement scans also
made a small household's derived data harder to reason about than a bounded
corpus refresh.

## Decision

Postgres `Job` is the sole execution owner for background work. An authoritative
save and its Job intent commit in the same transaction. Queue messages, app-open
catch-up and cron only wake the same due-Job drain. Lost
or duplicate wakes affect latency; they do not lose or duplicate intent. The
queue carries a strict version-3 wake envelope with no Job identifier. Every
delivery attempts the drain even when unreadable, and always acknowledges.
Transport owns no retry budget. Admission stores the JSON wire shape,
omitting undefined optional properties.

A claim has one generation, token, expiration and finite attempt budget. Claims
are renewed during provider preparation. Native pulls use their requested
bounded duration on that same Job lease. Successful bounded pages commit their
output and cursor together and reset the consecutive failure budget. The drain
continues immediately runnable pages and sends another wake if its budget runs out. Publication locks the Job and checks
its current generation, token, running state and live lease. A stopped,
superseded or pre-cutover worker cannot publish using its former domain token.
Loss of Job ownership is an invocation interruption, including through wrapped
causes; per-item isolation must propagate it instead of retrying individual effects.
Expensive preparation, paid calls and remote mutations happen outside that
transaction; the publication callback performs database work only. Specific
captured authoritative inputs are rechecked before prepared results publish.
The Job remains running until these before-commit checks finish; output and its
completed Job then commit together. Location analysis and image metadata hold
their source rows and reject results if the source changed during preparation.
Embedding selection locks its source and identity through commit so it cannot
insert a selected vector after deletion has already cleaned that source.

Transient errors use bounded Job backoff and preserve credential-scrubbed raw
diagnostics. A cooperative deferral preserves its checkpoint and does
not spend the failure budget. Job `waitReason` is one of `provider_capacity`,
`ai_funding_window`, `device` or `rate_limit`, paired with `waitUntil`. Claim,
ordinary publication and failure clear wait metadata. Retry backoff retains
consecutive failure attempts and the raw error. Single-item Jobs store nullable
`subjectKind` / `subjectId` so owning records can show their execution. Manual pause, cancellation and exhausted failure
remain stopped until explicit member action. Ordinary invalidation and alarms
never revive them. Provider/cache code imports control errors and execution
context from pure `generic/jobs/errors.ts` and `context.ts` leaves; it must not
import database runtime merely to read execution context.

Broad family saves record Job intent without sending a wake for each save; the
minute cron or another due-Job drain picks it up.
Each drain selects fair batches in one SQL window query, interleaving kinds
least recently claimed first by each Job's `lastClaimedAt`; enqueues and
invalidations are not service. Priority
ranks only within each kind; manual `run.execute` Jobs have raised priority.
Queue position counts due Jobs ranked ahead in the same kind. Each drain
reselects batches of at most 25 due Jobs, with a default cap of
256 pages and a 20-second budget between pages. One in-flight provider page may
outlast that budget. Remaining immediately due work requests another wake; cron
uses the same drain if that wake is lost. A large corpus, provider capacity or
continuous edits can exceed the healthy roughly two-minute staleness target.
Every authoritative invalidation restarts the broad cursor, so convergence is
promised after edits quiet, not during an endless stream of writes.

## Workload contracts

Broad `refresh.family` Jobs use the keys `refresh:search`, `refresh:recipes`,
`refresh:conversions`, `refresh:embeddings` and `refresh:orphans`. They page through
current authoritative sources and directly clean orphaned projections. Search,
conversion and embedding scheduling pages contain at most 25 sources. Recipe
preparation processes one owner and its authoritative closure per page. That
closure can be large. No dependency traversal, capture inbox, input epoch,
publication ledger, observed-input snapshot or assessment retirement scanner
owns scheduling. Periodically scheduling completed families covers exceptional drift.
Ordinary reads serve stored projections and never repair them.

Pending review evidence is filtered against current family-specific inputs and
revalidated at apply. Field, connection, Product and statement evidence retain
their own checks of current inputs when reading and applying. Broad refresh neither guesses
corrections nor changes member decisions, financial facts or import claims.

`run.execute` owns execution for supported background Run purposes. Run and
RunStep retain grouping, provenance, frozen populations, progress, checkpoints,
receipts and typed domain outcomes. They own no independent lease, retry budget,
Workflow instance or automatic recovery counter. Automatic discovery pages
continue through their Job, waiting between complete passes. Historical
`derived_refresh` Runs remain history after replacement by broad families.

`ai.evaluation` owns the shared evaluation claim. Domain evidence, successful
results, publication receipts, requester attribution and historical evaluation
IDs remain intact. A `result_ready` evaluation resumes from its paid result.
Failure diagnostics require the same live Job token even when a funding
stop has paused the requester; publishing a result still rechecks requester
authority.
Cancelling one requester does not cancel another live requester's work. Manual
work retains its own authority; automatic work still requires the enabled
policy. Unknown irreversible outcomes require reconciliation, never guessed
replay.

Image processing uses the same Job lease for cloud dispatch and native pull.
Attempt IDs retain the Job token for completion adoption. Processing attempts,
executor attribution, output reservations and receipts remain domain history.
A late device or pre-deployment completion cannot adopt an output after its
Job ownership expires. Waiting for a device reschedules the same Job rather
than creating a second scheduler.

`embedding.refresh` uses immutable `Job.id` as the remote physical vector ID.
Its committed upload hash and mutation receipt survive visibility polling and
restart, avoiding repeated upload after retained success. `embedding.cleanup`
deletes only an unselected, stopped physical artifact and retains its remote
delete receipt. Explicit retry of stopped embedding execution allocates a fresh
physical Job ID and retires the old key. A delayed cleanup can therefore never
delete the replacement upload. Failed and retired artifacts retain diagnostics
in terminal Jobs without automatic resurrection.

Explicit search repair schedules the same search, embedding and orphan Jobs and
streams their actual persisted counters. Disconnecting the stream leaves the
Jobs durable. Interactive reads, previews, draft decisions and synchronous
operation composition retain their request runtime.

`purchase.dispatch` is admitted atomically with the import Run or its resumed
generation. Stable operation identities make retries safe. The Job completes
when the coordinator accepts; SDK lifecycle alarms and settlement remain
coordinator-owned. A started coordinator is never resubmitted by a start Job.
Exhausted dispatch Jobs project raw terminal diagnostics onto the current
unstarted Run generation. Old dispatch accounting is retained in Run audit
history before its column is removed.

Funding pauses persist a deferred `run.funding-resume` Job at the funding window
end. The handler resumes the domain, including dispatch regeneration for
funding-paused imports. Explicit budget increases still resume immediately;
manual pauses remain stopped. No funding or generic recovery alarm is retained
in the gateway DO.

Minute cron admits `ai-refresh.activate` once per observed deployment occurrence,
fenced to the gateway DO's current version and the transactionally recorded
occurrence. A → B → A rollback creates a new occurrence while preserving policy
generations. Per-fetch observation and deployment epoch alarms are removed;
member automatic-rule switches stay independent. Deployment observations and
Mail import settings use separate AppSettings records.

## Consequences

The cutover preserves household data, redirects, foreign keys, domain facts,
paid results, approvals, observations, receipts and historical provenance.
Active legacy execution maps to Job input and checkpoints before old fields are
dropped; terminal diagnostics remain in Job error/result metadata. Old attempts
must be rejected by the new Job token check. Obsolete Workflow classes/bindings, image cloud
queue, recovery adapters and layered refresh tables are deleted with their
replacement paths. Transport queues remain only for background wakes and telemetry. The purchase
queue, its consumer and its independent retry loop are removed. Job execution
logs emit a single structured JSON object so Workers Logs indexes the execution
identity, attempt and typed wait fields.
