# ADR 0015: Unified durable execution and broad refresh

Status: Superseded by [ADR 0025](0025-radical-simplification-of-background-work.md).
Accepted 2026-10-13.

## Decision

Postgres `Job` became the sole execution owner for background work: an
authoritative save and its Job intent committed in one transaction, queue
messages, app-open catch-up and cron only woke the same due-Job drain, and a
Job carried one lease with a finite attempt budget. Broad `refresh.family` Jobs
paged through authoritative sources instead of dependency frontiers.
[ADR 0029](0029-evidence-facts-and-reconcilers.md) replaces Job coordination
with kernel scopes, Asks and Passes. The current contract lives in
[Kernel work](../jobs.md), including [wakes](../jobs.md#wakes-and-progress)
and [claims and retries](../jobs.md#scopes-asks-and-passes).

The full text is in git history.
