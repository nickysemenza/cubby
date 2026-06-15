import { and, desc, eq, gt, inArray, like, sql } from "drizzle-orm";
import { chunk, clamp } from "es-toolkit";
import type { Database } from "./index";
import { schema } from "./index";
import type { UpcMiss } from "./schema";

// How long a recorded miss is trusted before the UPC is eligible for one more
// external try (covers transient upcitemdb failures without re-querying dead
// UPCs on every scan).
export const MISS_TTL_DAYS = 30;

// D1 caps bound parameters per statement; chunk IN-lists well under the limit.
const IN_CHUNK = 100;

/**
 * Record (or refresh) a miss for a UPC. On conflict, bump `attempts` and
 * refresh `lastCheckedAt` so the TTL window restarts.
 */
export async function recordMiss(db: Database, upc: string): Promise<void> {
  await db
    .insert(schema.upcMisses)
    .values({ upc })
    .onConflictDoUpdate({
      target: schema.upcMisses.upc,
      set: {
        attempts: sql`${schema.upcMisses.attempts} + 1`,
        lastCheckedAt: sql`(datetime('now'))`,
      },
    });
}

/** Delete a miss (e.g. once the UPC graduates to a real product). */
export async function deleteMiss(db: Database, upc: string): Promise<void> {
  await db.delete(schema.upcMisses).where(eq(schema.upcMisses.upc, upc));
}

/**
 * Of the given UPCs, return the set that has a *fresh* miss (within TTL) — i.e.
 * already tried and known-missing, so they should not be looked up again yet.
 */
export async function getFreshMisses(
  db: Database,
  upcs: string[],
  ttlDays = MISS_TTL_DAYS,
): Promise<Set<string>> {
  const fresh = new Set<string>();
  if (upcs.length === 0) return fresh;

  for (const batch of chunk(upcs, IN_CHUNK)) {
    const rows = await db
      .select({ upc: schema.upcMisses.upc })
      .from(schema.upcMisses)
      .where(
        and(
          inArray(schema.upcMisses.upc, batch),
          gt(
            schema.upcMisses.lastCheckedAt,
            sql`datetime('now', ${`-${ttlDays} days`})`,
          ),
        ),
      );
    for (const r of rows) fresh.add(r.upc);
  }
  return fresh;
}

export type ListMissesOptions = {
  q?: string;
  page?: number;
  pageSize?: number;
};

export type ListMissesResult = {
  rows: UpcMiss[];
  total: number;
  page: number;
  pageSize: number;
};

/** Paginated miss listing for the admin worklist, newest-checked first. */
export async function listMisses(
  db: Database,
  { q, page = 1, pageSize = 25 }: ListMissesOptions = {},
): Promise<ListMissesResult> {
  const safePage = Math.max(page, 1);
  const safePageSize = clamp(pageSize, 1, 100);

  const where =
    q && q.trim().length > 0
      ? like(schema.upcMisses.upc, `%${q.trim()}%`)
      : undefined;

  const rows = await db.query.upcMisses.findMany({
    where,
    orderBy: [desc(schema.upcMisses.lastCheckedAt)],
    limit: safePageSize,
    offset: (safePage - 1) * safePageSize,
  });

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.upcMisses)
    .where(where);
  const total = countResult[0]?.count ?? 0;

  return { rows, total, page: safePage, pageSize: safePageSize };
}
