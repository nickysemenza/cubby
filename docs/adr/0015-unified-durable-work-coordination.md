# ADR 0015: Shared durable execution for member-requested AI work

Status: Accepted.

## Context

Manual Email Reclassify and Suggestion Sweep record Runs but execute within
requests, so a request timeout or disconnect can strand authorized work.
Automatic AI refresh already has durable target claims, retry state and atomic
publication receipts. Reusing that machinery and the Run lifecycle gives manual
work automatic continuation and recovery with a bounded migration. Remaining
work lives in [the work list](../todos.md).

## Decision

This change moves Reclassify and Suggestion Sweep onto shared
durable execution, including the infrastructure improvements those callers need.
**Cloudflare Workflows is only for background work.** Interactive reads, searches
and previews retain the existing request runtime and synchronous results.

For background execution, the engine owns durable intent, scheduling, admission,
attempt fencing, cancellation, retry and recovery. Cloudflare Workflows drives
background execution; Postgres retains work state and publication receipts.
Generalize the existing AI evaluation ledger and Run lifecycle rather than adding
competing ledgers. Reuse atomic replay/publication patterns where useful; merging
the purchase operation ledger is not required for this change.
Workload declarations retain eligibility, mailbox authority, model choice and
publication rules. Automatic prompt refresh retains its narrower eligibility
and its own admission policy; its activation cannot gate manual work.

UPC image and mechanical backfills are follow-on migrations. Existing agent,
device, queue and telemetry execution owners remain in place. Extend common
contracts to them when doing so deletes meaningful duplication or fixes a
demonstrated recovery gap. A universal scheduler is not required for authorized
work to become automatic and self-healing.

Identical pending requests share execution when target, model, policy and
evidence agree, while each requesting Run retains its own receipt. Request
receipts are history references that retain their Run identity through archival
and deletion, rather than navigable entity relationships. Cancelling
one request leaves work requested by another intact; a later deliberate rerun
creates fresh execution. Member work has priority with background fairness.
Suggestion Sweep fixes roster membership at launch and rechecks current values
before execution and publication.

Reclassify returns Run references promptly. It follows current Email evidence
with bounded restarts and automatic later continuation, preserves member
resolutions and history, and never admits import. Historical deferred and
missing outcomes are reconciled, then eligible unknown work permits bounded
reinference under usable current authority, with no arbitrary historical age
cutoff. Cancelled, already fulfilled and known permanently failed work is not
automatically revived. Recovery retains a bound approval while it remains usable
under current authorization rules, otherwise rebinds to the newest applicable
approval. A transport budget refusal persists `paused_auth` before throwing, so
interruption before driver error handling cannot strand the Run.
Authority replacement is audited; authorization and spending
constraints continue to apply. Transient failures
have bounded retries; terminal failures stay visible. Deliberate cancellation
and member decisions remain binding.

Recovery creates linked continuation Runs while preserving
completed historical Runs and their receipts. Publication and its receipt commit
together behind an attempt and evidence fence. Wakes follow durable events and
due-time alarms, with nightly reconciliation as a backstop; no frequent database
polling cron is introduced. Durable dispatch must survive a crash between saving
intent and delivering its wake.

One layer owns retry of each effect; outer transports re-admit or reconcile
recorded outcomes rather than independently replaying writes. Ambiguous
non-idempotent writes require reconciliation, not guessed replay. Permission for
bounded reinference of unknown AI outcomes does not authorize replay of unknown
financial or import writes. Cancellation preserves committed outcomes and their
required effects. Durable progress uses the existing Run read/subscription
surface, while request execution retains its response and streaming contracts.

Retain replay evidence and member-visible outcomes, including cancelled and
obsolete history. Temporary leases, tokens and wake bookkeeping can be pruned
after settlement without deleting their retained evidence.

## Consequences

Breaking contracts are allowed, but household data, approvals, observations,
receipts and completed work must be transformed and retained. Each migrated
workload deletes its replaced execution path in the same change. Broad runtime
replacement would add replay, device-availability and observability migration
risks without evidence that it improves the requested behavior; follow-on scope
is selected from concrete failures and duplication.
