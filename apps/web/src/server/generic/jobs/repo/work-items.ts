/**
 * Work items: the per-item half of a drain (docs/jobs.md#coarse-jobs-and-work-items). Items hold
 * retry state only; the drain Job's lease fences every item it claimed, and
 * a ticket fences each item against re-marking during its page. This is the
 * producer and adapter interface; claiming and settlement belong to
 * `defineDrain` (`work-claims.ts`).
 */
import { jobState } from "@cubby/schemas/job";
import { and, eq, inArray, lte, sql, type SQL } from "drizzle-orm";

import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job, workItem } from "~/server/db/retained-tables";

import { wakeJob } from "./producer";

export type WorkItem = {
  target: string;
  ref: string;
  ticket: number;
  priority: number;
  attempts: number;
};

/** The drain Job a family of items belongs to. */
export type Drain = { readonly key: string; readonly kind: string };

const itemColumns = {
  target: workItem.target,
  ref: workItem.ref,
  ticket: workItem.ticket,
  priority: workItem.priority,
  attempts: workItem.attempts,
};

/** Exactly these tickets: a re-marked item no longer matches. */
// Drizzle has no tuple IN; a jsonb record set keeps one parameter per call.
export const workTickets = (items: readonly WorkItem[]) => sql`(
  ${workItem.target}, ${workItem.ref}, ${workItem.ticket}) IN (
  SELECT m.target, m.ref, m.ticket FROM jsonb_to_recordset(${JSON.stringify(
    items.map(({ target, ref, ticket }) => ({ target, ref, ticket })),
  )}::jsonb) AS m(target text, ref uuid, ticket bigint))`;

/**
 * A re-mark takes a fresh ticket, the more urgent priority and a fresh
 * attempt budget, so a page already holding the item cannot clear the newer
 * work.
 */
const remark = {
  target: [workItem.target, workItem.ref],
  set: {
    drain: sql`excluded.drain`,
    ticket: sql`nextval('"WorkTicket"')`,
    priority: sql`least(${workItem.priority}, excluded.priority)`,
    readyAt: sql`excluded."readyAt"`,
    attempts: 0,
    lastError: null,
  },
};

/** Mark items in the source transaction and wake their drain. */
export async function markWork(
  db: RepositoryQueryInput,
  drain: Drain,
  items: readonly { target: string; ref: string; priority?: number }[],
  { readyAt }: { readyAt?: Date } = {},
) {
  if (!items.length) return;
  const merged = new Map<
    string,
    { target: string; ref: string; priority: number }
  >();
  for (const { target, ref, priority = 0 } of items) {
    const key = `${target}\0${ref}`;
    const previous = merged.get(key);
    merged.set(key, {
      target,
      ref,
      priority: Math.min(priority, previous?.priority ?? priority),
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
          ...item,
          ...(readyAt ? { readyAt } : {}),
        })),
    )
    .onConflictDoUpdate(remark);
  await wakeJob(db, { key: drain.key, kind: drain.kind, input: {} });
}

/**
 * Mark the rows `source` selects, as `(target text, ref uuid, priority int)`,
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
          min(s.priority), now(), now(), 0, NULL
          FROM (${source}) AS s(target, ref, priority)
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
): Promise<WorkItem[]> {
  if (!items.length) return [];
  const rows = await repositoryQueries(tx)
    .select({ target: workItem.target, ref: workItem.ref })
    .from(workItem)
    .where(workTickets(items))
    .orderBy(workItem.target, workItem.ref)
    .for("update", { skipLocked: true });
  const held = new Set(rows.map(({ target, ref }) => `${target}\0${ref}`));
  return items.filter(({ target, ref }) => held.has(`${target}\0${ref}`));
}

/** Make items wait (a provider visibility poll) without spending an attempt. */
export async function postponeWork(
  tx: RepositoryQueryInput,
  items: readonly WorkItem[],
  until: Date,
) {
  if (!items.length) return;
  await repositoryQueries(tx)
    .update(workItem)
    .set({ readyAt: until })
    .where(workTickets(items));
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

/** Withdraw items regardless of ticket (cancellation, deletion of the source). */
export async function dropWork(
  tx: RepositoryQueryInput,
  target: string,
  refs: readonly string[],
) {
  if (!refs.length) return;
  await repositoryQueries(tx)
    .delete(workItem)
    .where(and(eq(workItem.target, target), inArray(workItem.ref, [...refs])));
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
        })
        .from(workItem)
        .where(
          and(eq(workItem.target, target), inArray(workItem.ref, [...refs])),
        )
    : Promise.resolve([]);

/** Every item of a drain with its retry state, in claim order. */
export const drainItems = (db: RepositoryQueryInput, drain: string) =>
  repositoryQueries(db)
    .select({
      ...itemColumns,
      lastError: workItem.lastError,
      readyAt: workItem.readyAt,
    })
    .from(workItem)
    .where(eq(workItem.drain, drain))
    .orderBy(workItem.priority, workItem.readyAt, workItem.ticket);

/** Whether the drain has an item ready now (not backing off). */
export async function drainReady(db: RepositoryQueryInput, drain: string) {
  const [row] = await repositoryQueries(db)
    .select({ ref: workItem.ref })
    .from(workItem)
    .where(and(eq(workItem.drain, drain), lte(workItem.readyAt, sql`now()`)))
    .limit(1);
  return row !== undefined;
}

/** Whether a target still owes work for `ref` (a correlated column). */
export const workPending = (target: string | SQL, ref: SQL) =>
  sql`EXISTS (SELECT 1 FROM ${workItem} WHERE ${workItem.target} = ${target} AND ${workItem.ref} = ${ref})`;

/** Whether any item whose target matches `target` is still owed. */
export const workPendingWhere = (target: (column: SQL) => SQL) =>
  sql`EXISTS (SELECT 1 FROM ${workItem} WHERE ${target(sql`${workItem.target}`)})`;

/**
 * The owed item of `target`/`ref` (correlated), for a `LEFT JOIN LATERAL`:
 * columns `ref`, `lastError` and `readyAt`.
 */
export const owedWorkItem = (target: SQL, ref: SQL) =>
  sql`(SELECT ${workItem.ref} AS ref, ${workItem.lastError} AS "lastError", ${workItem.readyAt} AS "readyAt"
    FROM ${workItem} WHERE ${workItem.target} = ${target} AND ${workItem.ref} = ${ref})`;

/** Whether any item of `targets` is still owed. */
export const workPendingIn = (targets: readonly string[]) =>
  sql`EXISTS (SELECT 1 FROM ${workItem} WHERE ${inArray(workItem.target, [...targets])})`;

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
  target: (column: SQL) => SQL,
  observed: readonly number[],
) =>
  // One jsonb parameter: a busy fanout can observe thousands of tickets.
  sql`EXISTS (SELECT 1 FROM ${workItem} WHERE ${target(sql`${workItem.target}`)}
    AND ${workItem.ticket} NOT IN (
      SELECT jsonb_array_elements_text(${JSON.stringify(observed)}::jsonb)::bigint))`;

/** Pending items per target-prefix (before any `@`) and the oldest mark's age, for a drain. */
export async function drainBacklog(db: RepositoryQueryInput, drain: string) {
  const family = sql<string>`split_part(${workItem.target}, '@', 1)`;
  const queries = repositoryQueries(db);
  const [targets, [oldest]] = await Promise.all([
    queries
      .select({ target: family, count: sql<number>`count(*)::int` })
      .from(workItem)
      .where(eq(workItem.drain, drain))
      .groupBy(family)
      .orderBy(family),
    queries
      .select({
        seconds: sql<
          number | null
        >`extract(epoch FROM now() - min(${workItem.dirtiedAt}))::int`,
      })
      .from(workItem)
      .where(eq(workItem.drain, drain)),
  ]);
  return { targets, oldestSeconds: oldest?.seconds ?? null };
}

/** A target's owed item priority for `ref` (a correlated column), or null. */
export const workPriority = (target: string, ref: SQL) =>
  sql<
    number | null
  >`(SELECT ${workItem.priority} FROM ${workItem} WHERE ${workItem.target} = ${target} AND ${workItem.ref} = ${ref})`;

/**
 * One item attempt is the drain lease plus the item's ticket: a re-mark
 * (changed input, new demand) or a lost lease makes it obsolete. Domains
 * persist the token on their own row to recognise their attempt's writes.
 */
export const workAttemptToken = (
  claim: { readonly leaseToken: string },
  item: Pick<WorkItem, "ticket">,
) => `${claim.leaseToken}/${item.ticket}`;

/** Whether `token` still holds `target`/`ref` through its drain's live lease. */
export const workAttemptLive = (target: string, ref: SQL, token: string) =>
  sql`EXISTS (SELECT 1 FROM ${workItem} JOIN ${job} ON ${job.key} = ${workItem.drain}
    WHERE ${workItem.target} = ${target} AND ${workItem.ref} = ${ref}
      AND ${workItem.ticket} = split_part(${token}, '/', 2)::bigint
      AND ${job.state} = ${jobState.enum.running} AND ${job.leaseToken} = split_part(${token}, '/', 1)::uuid
      AND ${job.leaseExpiresAt} > now())`;
