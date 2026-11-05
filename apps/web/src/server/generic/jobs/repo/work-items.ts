/**
 * Work items: the per-item half of a drain (docs/jobs.md#coarse-jobs-and-work-items). Items hold
 * retry state only; the drain Job's lease fences every item it claimed, and
 * a ticket fences each item against re-marking during its page. This is the
 * producer and adapter interface; claiming and settlement belong to
 * `defineDrain` (`work-claims.ts`).
 */
import type { WorkWaitCause } from "@cubby/schemas/job";
import { and, asc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";

import { uuidArrayParam } from "~/server/db/helpers/query";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { workItem } from "~/server/db/retained-tables";

import { wakeJob } from "./producer";

export type WorkItem = {
  target: string;
  ref: string;
  ticket: number;
  priority: number;
  attempts: number;
  reason?: string | null;
  fanoutAfter?: string | null;
};

/** The drain Job a family of items belongs to. */
export type Drain = { readonly key: string; readonly kind: string };

const itemColumns = {
  target: workItem.target,
  ref: workItem.ref,
  ticket: workItem.ticket,
  priority: workItem.priority,
  attempts: workItem.attempts,
  reason: workItem.reason,
  fanoutAfter: workItem.fanoutAfter,
};

/** Bounded ready-work observations; no locks or scheduling changes. */
export async function observeReadyWork(
  db: RepositoryQueryInput,
  {
    drain,
    limit,
    eligible,
  }: {
    drain: string;
    limit: number;
    eligible?: (target: SQL) => SQL;
  },
): Promise<WorkItem[]> {
  return repositoryQueries(db)
    .select(itemColumns)
    .from(workItem)
    .where(
      and(
        eq(workItem.drain, drain),
        lte(workItem.readyAt, sql`now()`),
        eligible?.(sql`${workItem.target}`),
      ),
    )
    .orderBy(
      asc(workItem.priority),
      asc(workItem.readyAt),
      asc(workItem.ticket),
    )
    .limit(limit);
}

/** Exact pending generations, including retry deadlines; this does not claim or reschedule them. */
export async function observePendingWork(
  db: RepositoryQueryInput,
  {
    drain,
    eligible,
    scope,
  }: {
    drain: string;
    eligible: (target: SQL, ref: SQL) => SQL;
    scope?: { target: string; refs: readonly string[] };
  },
): Promise<WorkItem[]> {
  return repositoryQueries(db)
    .select(itemColumns)
    .from(workItem)
    .where(
      and(
        eq(workItem.drain, drain),
        eligible(sql`${workItem.target}`, sql`${workItem.ref}`),
        scope
          ? sql`(${workItem.target} <> ${scope.target} OR ${workItem.ref} = ANY(${uuidArrayParam(scope.refs)}))`
          : undefined,
      ),
    )
    .orderBy(workItem.target, workItem.ref);
}

/** Exactly these tickets: a re-marked item no longer matches. */
// Drizzle has no tuple IN; a jsonb record set keeps one parameter per call.
export const workTickets = (items: readonly WorkItem[]) => sql`(
  ${workItem.target}, ${workItem.ref}, ${workItem.ticket}) IN (
  SELECT m.target, m.ref, m.ticket FROM jsonb_to_recordset(${JSON.stringify(
    items.map(({ target, ref, ticket }) => ({ target, ref, ticket })),
  )}::jsonb) AS m(target text, ref uuid, ticket bigint))`;

/** Advance only held source tickets after their dependent marks commit with this transaction. */
export async function advanceWorkFanouts(
  db: RepositoryQueryInput,
  progress: readonly { item: WorkItem; after: string }[],
) {
  if (!progress.length) return;
  const rows = progress.map(({ item, after }) => ({
    target: item.target,
    ref: item.ref,
    ticket: item.ticket,
    after,
  }));
  await repositoryQueries(db)
    .update(workItem)
    .set({ fanoutAfter: sql`p.after`, readyAt: sql`now()` })
    .from(
      sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS p(target text, ref uuid, ticket bigint, after uuid)`,
    )
    .where(
      and(
        eq(workItem.target, sql`p.target`),
        eq(workItem.ref, sql`p.ref`),
        eq(workItem.ticket, sql`p.ticket`),
      ),
    );
}

/**
 * A re-mark takes a fresh ticket, the more urgent priority and a fresh
 * attempt budget, so a page already holding the item cannot clear the newer
 * work.
 */
const remark = {
  target: [workItem.target, workItem.ref],
  set: {
    drain: sql`excluded.drain`,
    reason: sql`excluded.reason`,
    ticket: sql`nextval('"WorkTicket"')`,
    priority: sql`least(${workItem.priority}, excluded.priority)`,
    readyAt: sql`excluded."readyAt"`,
    attempts: 0,
    lastError: null,
    waitCause: null,
    waitStartedAt: null,
    fanoutAfter: null,
  },
};

/** Mark items in the source transaction and wake their drain. */
export async function markWork(
  db: RepositoryQueryInput,
  drain: Drain,
  items: readonly {
    target: string;
    ref: string;
    priority?: number;
    reason?: string | null;
  }[],
  { readyAt }: { readyAt?: Date } = {},
) {
  if (!items.length) return;
  const merged = new Map<
    string,
    {
      target: string;
      ref: string;
      priority: number;
      reason: string | null;
      reasonPriority: number;
    }
  >();
  for (const {
    target,
    ref,
    priority = 0,
    reason = "Refresh requested",
  } of items) {
    const key = `${target}\0${ref}`;
    const previous = merged.get(key);
    const keepReason =
      previous?.reason != null &&
      (reason == null ||
        previous.reasonPriority < priority ||
        (previous.reasonPriority === priority && previous.reason < reason));
    merged.set(key, {
      target,
      ref,
      priority: Math.min(priority, previous?.priority ?? priority),
      reason: keepReason ? previous.reason : reason,
      reasonPriority: keepReason ? previous.reasonPriority : priority,
    });
  }
  // Sorted keys keep concurrent markers from deadlocking on each other. The
  // default readyAt is database time: claims compare against now(), and a JS
  // clock ahead of Postgres would hide a fresh item from its own drain.
  await repositoryQueries(db)
    .insert(workItem)
    .values(
      [...merged]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, item]) => ({
          drain: drain.key,
          target: item.target,
          ref: item.ref,
          priority: item.priority,
          reason: item.reason,
          ...(readyAt ? { readyAt } : {}),
        })),
    )
    .onConflictDoUpdate(remark);
  await wakeJob(db, { key: drain.key, kind: drain.kind, input: {} });
}

/** The items still current and free, locked without waiting; skipped items stay for a later page. */
export async function lockWork(
  tx: RepositoryQueryInput,
  items: readonly WorkItem[],
  { drain }: { drain?: string } = {},
): Promise<WorkItem[]> {
  if (!items.length) return [];
  const rows = await repositoryQueries(tx)
    .select({ target: workItem.target, ref: workItem.ref })
    .from(workItem)
    .where(
      and(
        workTickets(items),
        drain === undefined ? undefined : eq(workItem.drain, drain),
      ),
    )
    .orderBy(workItem.target, workItem.ref)
    .for("update", { skipLocked: true });
  const held = new Set(rows.map(({ target, ref }) => `${target}\0${ref}`));
  return items.filter(({ target, ref }) => held.has(`${target}\0${ref}`));
}

/** Whether a drain (a key or a correlated key column) still owes any item. */
export const drainPending = (drain: string | SQL) =>
  sql`EXISTS (SELECT 1 FROM ${workItem} WHERE ${workItem.drain} = ${drain})`;

/** Whether an item matching `target` exists whose ticket is not among `observed`. */
export const unobservedWork = (
  target: (column: SQL, ref: SQL) => SQL,
  observed: readonly number[],
  /** Narrow one exact target's refs while retaining the other matched targets. */
  scope?: { target: string; refs: readonly string[] },
) =>
  // One jsonb parameter: a busy fanout can observe thousands of tickets.
  sql`EXISTS (SELECT 1 FROM ${workItem} WHERE ${target(sql`${workItem.target}`, sql`${workItem.ref}`)}
    ${scope ? sql`AND (${workItem.target} <> ${scope.target} OR ${workItem.ref} = ANY(${uuidArrayParam(scope.refs)}))` : sql``}
    AND ${workItem.ticket} NOT IN (
      SELECT jsonb_array_elements_text(${JSON.stringify(observed)}::jsonb)::bigint))`;

/** The explicit wait of each drain's next item; drains whose next item has none are absent. */
export async function drainNextWaitCauses(
  db: RepositoryQueryInput,
  drains: readonly string[],
) {
  if (!drains.length) return new Map<string, WorkWaitCause>();
  const rows = await repositoryQueries(db)
    .selectDistinctOn([workItem.drain], {
      drain: workItem.drain,
      cause: workItem.waitCause,
    })
    .from(workItem)
    .where(inArray(workItem.drain, [...drains]))
    .orderBy(workItem.drain, workItem.readyAt);
  return new Map(
    rows.flatMap(({ drain, cause }) =>
      cause ? [[drain, cause] as const] : [],
    ),
  );
}
