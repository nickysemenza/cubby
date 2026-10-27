/**
 * Work items: the per-item half of a drain (docs/jobs.md#drains). Items hold
 * retry state only; the drain Job's lease fences every item it claimed, and
 * a ticket fences each item against re-marking during its page.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { uuidArrayParam } from "~/server/db/helpers/query";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";

import type { JobBackoff } from "../kind-policy";
import { wakeJob } from "./producer";

const workItemRow = z.object({
  target: z.string(),
  ref: z.string(),
  ticket: z.coerce.number(),
  priority: z.coerce.number(),
  attempts: z.coerce.number(),
});
export type WorkItem = z.output<typeof workItemRow>;

/** The drain Job a family of items belongs to. */
export type Drain = { readonly key: string; readonly kind: string };

const ticketSet = (items: readonly WorkItem[]) =>
  sql`jsonb_to_recordset(${JSON.stringify(
    items.map(({ target, ref, ticket }) => ({ target, ref, ticket })),
  )}::jsonb) AS m(target text, ref uuid, ticket bigint)`;

/**
 * Mark items in the source transaction and wake their drain. A re-mark takes
 * a fresh ticket, the more urgent priority and a fresh attempt budget, so a
 * page already holding the item cannot clear the newer work.
 */
export async function markWork(
  db: RepositoryQueryInput,
  drain: Drain,
  items: readonly { target: string; ref: string; priority?: number }[],
  { readyAt }: { readyAt?: Date } = {},
) {
  if (!items.length) return;
  await repositoryQueries(db).execute(sql`
    INSERT INTO "WorkItem" (drain, target, ref, priority, "readyAt")
    SELECT ${drain.key}, i.target, i.ref, min(i.priority), ${(readyAt ?? new Date()).toISOString()}::timestamp
      FROM jsonb_to_recordset(${JSON.stringify(
        items.map(({ target, ref, priority = 0 }) => ({
          target,
          ref,
          priority,
        })),
      )}::jsonb) AS i(target text, ref uuid, priority int)
     GROUP BY i.target, i.ref ORDER BY i.target, i.ref
    ON CONFLICT (target, ref) DO UPDATE SET
      drain = EXCLUDED.drain,
      ticket = nextval('"WorkTicket"'),
      priority = LEAST("WorkItem".priority, EXCLUDED.priority),
      "readyAt" = EXCLUDED."readyAt",
      attempts = 0,
      "lastError" = NULL`);
  await wakeJob(db, { key: drain.key, kind: drain.kind, input: {} });
}

/** The ready items, most urgent first. Reads only; publication rechecks tickets. */
export async function claimWork(
  db: RepositoryQueryInput,
  drain: string,
  limit: number,
): Promise<WorkItem[]> {
  const result = await repositoryQueries(db).execute(sql`
    SELECT target, ref, ticket, priority, attempts FROM "WorkItem"
     WHERE drain = ${drain} AND "readyAt" <= now()
     ORDER BY priority, "readyAt", ticket
     LIMIT ${limit}`);
  return z.array(workItemRow).parse(result.rows);
}

/** The items still current and free, locked without waiting; skipped items stay for a later page. */
export async function lockWork(
  tx: RepositoryQueryInput,
  items: readonly WorkItem[],
): Promise<WorkItem[]> {
  if (!items.length) return [];
  const result = await repositoryQueries(tx).execute(sql`
    SELECT w.target, w.ref::text AS ref FROM "WorkItem" w
      JOIN ${ticketSet(items)}
        ON w.target = m.target AND w.ref = m.ref AND w.ticket = m.ticket
     ORDER BY w.target, w.ref
     FOR UPDATE OF w SKIP LOCKED`);
  const held = new Set(
    z
      .array(z.object({ target: z.string(), ref: z.string() }))
      .parse(result.rows)
      .map(({ target, ref }) => `${target}\0${ref}`),
  );
  return items.filter(({ target, ref }) => held.has(`${target}\0${ref}`));
}

/** Clear exactly these tickets; a newer ticket keeps its item. */
export async function clearWork(
  tx: RepositoryQueryInput,
  items: readonly WorkItem[],
) {
  if (!items.length) return;
  await repositoryQueries(tx).execute(sql`
    DELETE FROM "WorkItem" w USING ${ticketSet(items)}
     WHERE w.target = m.target AND w.ref = m.ref AND w.ticket = m.ticket`);
}

/** Back off failed items; other items of the page still publish. */
export async function deferWork(
  tx: RepositoryQueryInput,
  items: readonly WorkItem[],
  error: string,
  backoff: JobBackoff,
) {
  if (!items.length) return;
  // Computed per item from its own attempt count; clamped so a long failure
  // streak can never overflow the interval and roll back the page.
  await repositoryQueries(tx).execute(sql`
    UPDATE "WorkItem" w SET
      attempts = w.attempts + 1,
      "lastError" = ${error.slice(0, 2000)},
      "readyAt" = now() + least(${backoff.maxMs}::bigint,
        ${backoff.baseMs}::bigint * (2 ^ least(w.attempts, 20))::bigint) * interval '1 millisecond'
      FROM ${ticketSet(items)}
     WHERE w.target = m.target AND w.ref = m.ref AND w.ticket = m.ticket`);
}

/** Make items wait (a provider visibility poll) without spending an attempt. */
export async function postponeWork(
  tx: RepositoryQueryInput,
  items: readonly WorkItem[],
  until: Date,
) {
  if (!items.length) return;
  await repositoryQueries(tx).execute(sql`
    UPDATE "WorkItem" w SET "readyAt" = ${until.toISOString()}::timestamp
      FROM ${ticketSet(items)}
     WHERE w.target = m.target AND w.ref = m.ref AND w.ticket = m.ticket`);
}

/** Withdraw items regardless of ticket (cancellation, deletion of the source). */
export async function dropWork(
  tx: RepositoryQueryInput,
  target: string,
  refs: readonly string[],
) {
  if (!refs.length) return;
  await repositoryQueries(tx).execute(sql`
    DELETE FROM "WorkItem" WHERE target = ${target}
       AND ref = ANY(${uuidArrayParam(refs)})`);
}

/** When the drain next has a ready item, or null when it has none. */
export async function nextWorkReadyAt(
  db: Database,
  drain: string,
): Promise<Date | null> {
  const result = await repositoryQueries(db).execute(sql`
    SELECT min("readyAt") AS "readyAt" FROM "WorkItem" WHERE drain = ${drain}`);
  const value = z
    .object({ readyAt: z.coerce.date().nullable() })
    .parse(result.rows[0] ?? { readyAt: null });
  return value.readyAt;
}
