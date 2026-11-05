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

/**
 * Mark the rows `source` selects, as `(target text, ref uuid, priority int, reason text)`,
 * in one statement. Returns each target's marked count and up to `sample`
 * refs, so a large fanout never materializes in the Worker. `wake: false` is
 * for the drain's own publication, which is already due again while items
 * remain.
 */
export async function markWorkFrom(
  db: RepositoryQueryInput,
  drain: Drain,
  source: SQL,
  {
    sample = 0,
    wake = true,
    existing = "remark",
  }: {
    sample?: number;
    wake?: boolean;
    /** `keep` leaves an owed item's ticket, attempts and backoff alone (reconcile, clock expiry). */
    existing?: "remark" | "keep";
  } = {},
): Promise<{ target: string; count: number; refs: string[] }[]> {
  const queries = repositoryQueries(db);
  // Several inputs can reach one item: grouping keeps the most urgent
  // priority and never updates one conflict row twice in a statement.
  const insert = queries.insert(workItem).select(
    sql`SELECT ${drain.key}, s.target, s.ref, nextval('"WorkTicket"'),
          min(s.priority), now(), now(), 0, NULL, NULL, NULL, NULL,
          (array_agg(s.reason ORDER BY s.priority, s.reason) FILTER (WHERE s.reason IS NOT NULL))[1],
          NULL, NULL, NULL
          FROM (${source}) AS s(target, ref, priority, reason)
         WHERE s.ref IS NOT NULL
         GROUP BY s.target, s.ref ORDER BY s.target, s.ref`,
  );
  const marked = queries
    .$with("marked")
    .as(
      (existing === "keep"
        ? insert.onConflictDoNothing()
        : insert.onConflictDoUpdate(remark)
      ).returning({ target: workItem.target, ref: workItem.ref }),
    );
  const ordinal = sql<number>`row_number() OVER (PARTITION BY ${marked.target} ORDER BY ${marked.ref})`;
  const numbered = queries.$with("numbered").as(
    queries
      .select({
        target: marked.target,
        ref: marked.ref,
        ordinal: ordinal.as("ordinal"),
      })
      .from(marked),
  );
  const rows = await queries
    .with(marked, numbered)
    .select({
      target: numbered.target,
      count: sql<number>`count(*)::int`,
      refs: sql<
        string[] | null
      >`array_agg(${numbered.ref}::text ORDER BY ${numbered.ref}) FILTER (WHERE ${numbered.ordinal} <= ${sample})`,
    })
    .from(numbered)
    .groupBy(numbered.target);
  if (wake && rows.length)
    await wakeJob(db, { key: drain.key, kind: drain.kind, input: {} });
  return rows.map(({ target, count, refs }) => ({
    target,
    count,
    refs: refs ?? [],
  }));
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

/** Hold a target's items until `until`, whatever their ticket; a page already holding one keeps it. */
export async function postponeWorkRefs(
  tx: RepositoryQueryInput,
  target: string,
  refs: readonly string[],
  until: Date,
): Promise<string[]> {
  if (!refs.length) return [];
  const rows = await repositoryQueries(tx)
    .update(workItem)
    .set({ readyAt: until })
    .where(and(eq(workItem.target, target), inArray(workItem.ref, [...refs])))
    .returning({ drain: workItem.drain });
  return [...new Set(rows.map((row) => row.drain))].sort();
}

/** A target's items whose ref is in `refs` (a subquery or array), as composable rows. */
export async function workItemsFor(
  db: RepositoryQueryInput,
  target: string,
  refs: readonly string[] | SQL,
): Promise<WorkItem[]> {
  if (Array.isArray(refs) && !refs.length) return [];
  return repositoryQueries(db)
    .select(itemColumns)
    .from(workItem)
    .where(
      and(
        eq(workItem.target, target),
        Array.isArray(refs)
          ? inArray(workItem.ref, refs)
          : sql`${workItem.ref} IN (${refs})`,
      ),
    );
}

/** Items with their drain and retry state, for operator reads and fixtures. */
export const workItemStates = (
  db: RepositoryQueryInput,
  target: string,
  refs: readonly string[],
) =>
  refs.length
    ? repositoryQueries(db)
        .select({
          ...itemColumns,
          drain: workItem.drain,
          lastError: workItem.lastError,
          readyAt: workItem.readyAt,
          waitCause: workItem.waitCause,
          waitStartedAt: workItem.waitStartedAt,
        })
        .from(workItem)
        .where(
          and(eq(workItem.target, target), inArray(workItem.ref, [...refs])),
        )
    : Promise.resolve([]);


/** Fenced caller only. An observation grants no authority over a work ticket. */
export async function observeWorkExecution(
  tx: RepositoryQueryInput,
  items: readonly WorkItem[],
  leaseToken: string,
) {
  if (!items.length) return;
  // Producers may hold marks while saving domain rows; observation must not
  // delay independent members of this page behind those busy marks.
  const held = await lockWork(tx, items);
  if (!held.length) return;
  await repositoryQueries(tx)
    .update(workItem)
    .set({
      executionLeaseToken: leaseToken,
      executionTicket: workItem.ticket,
      executionStartedAt: sql`now()`,
    })
    .where(workTickets(held));
}


/** Whether a drain (a key or a correlated key column) still owes any item. */
export const drainPending = (drain: string | SQL) =>
  sql`EXISTS (SELECT 1 FROM ${workItem} WHERE ${workItem.drain} = ${drain})`;

/**
 * The live tickets of a drain's items whose target matches, for a page that
 * must later tell observed items from newer ones.
 */
export async function workTicketsWhere(
  db: RepositoryQueryInput,
  drain: string,
  target: (column: SQL) => SQL,
): Promise<number[]> {
  const rows = await repositoryQueries(db)
    .select({ ticket: workItem.ticket })
    .from(workItem)
    .where(and(eq(workItem.drain, drain), target(sql`${workItem.target}`)));
  return rows.map((row) => row.ticket);
}

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
