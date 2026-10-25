# Durable Jobs

The universal `Job` table owns execution state for background work: claims,
leases, generations, retries and waits. Domain rows keep their outcomes and
evidence. [ADR 0015](adr/0015-unified-durable-work-coordination.md) records
the decision; this page owns the runtime contract. Derived-data families are
in [entities](entities.md#background-derived-data); Worker and database
capacity in [infrastructure](infrastructure.md#postgresql-and-hyperdrive).

## Durable invalidation

A source capture never writes a long-lived Job's execution row. It bumps the
Job's `JobInvalidation` revision in the save's transaction
(`recordJobInvalidation`; refresh families through `invalidateRefreshFamily`).
Claims, renewals and publication never write that row, so execution on
another connection cannot abort a capture's serializable transaction, and a
rolled-back save leaves no invalidation.

The Job observes the revision itself. A Job whose `observedRevision` trails
the marker is due, even when completed. The claim that observes it starts a
fresh pass: a new generation, no cursor or result, a fresh attempt budget, and
the revision recorded as observed. `restartsPass: false` (the quality family)
lets a pass in progress keep its cursor, and the finishing page absorbs
captures made meanwhile; its scheduled repeat reruns it. Rerunning on them
would never settle, because the pass's own Run records invalidate quality. Publication of a restarting kind rereads the marker and supersedes
a page whose pass began before a capture, as a generation change does. For
restarting kinds, a capture committing during publication or while a worker
dies is never lost: the finished or reclaimed Job still trails the marker.
