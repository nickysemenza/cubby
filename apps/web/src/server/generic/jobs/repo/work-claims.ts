/**
 * Claiming and settling work items, private to `defineDrain`: only the drain
 * that holds the Job lease claims, clears, backs off or schedules its items.
 */
import { and, asc, eq, lte, min, sql } from "drizzle-orm";

import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { workItem } from "~/server/db/retained-tables";

import type { JobBackoff } from "../kind-policy";
import { workTickets, type WorkItem } from "./work-items";

/** The ready items, most urgent first. Reads only; publication rechecks tickets. */
export async function claimWork(
  db: RepositoryQueryInput,
  drain: string,
  limit: number,
): Promise<WorkItem[]> {
  return repositoryQueries(db)
    .select({
      target: workItem.target,
      ref: workItem.ref,
      ticket: workItem.ticket,
      priority: workItem.priority,
      attempts: workItem.attempts,
    })
    .from(workItem)
    .where(and(eq(workItem.drain, drain), lte(workItem.readyAt, sql`now()`)))
    .orderBy(
      asc(workItem.priority),
      asc(workItem.readyAt),
      asc(workItem.ticket),
    )
    .limit(limit);
}

/** Clear exactly these tickets; a newer ticket keeps its item. */
export async function clearWork(
  tx: RepositoryQueryInput,
  items: readonly WorkItem[],
) {
  if (!items.length) return;
  await repositoryQueries(tx).delete(workItem).where(workTickets(items));
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
  await repositoryQueries(tx)
    .update(workItem)
    .set({
      attempts: sql`${workItem.attempts} + 1`,
      lastError: error.slice(0, 2000),
      readyAt: sql`now() + least(${backoff.maxMs}::bigint,
        ${backoff.baseMs}::bigint * (2 ^ least(${workItem.attempts}, 20))::bigint) * interval '1 millisecond'`,
    })
    .where(workTickets(items));
}

/** When the drain next has a ready item, or null when it has none. */
export async function nextWorkReadyAt(
  db: RepositoryQueryInput,
  drain: string,
): Promise<Date | null> {
  const [row] = await repositoryQueries(db)
    .select({ readyAt: min(workItem.readyAt) })
    .from(workItem)
    .where(eq(workItem.drain, drain));
  return row?.readyAt ?? null;
}
