import { and, desc, eq, gt, inArray, like, sql } from "drizzle-orm";
import { chunk, clamp } from "es-toolkit";
import pMap from "p-map";
import type { Database } from "./index";
import { schema } from "./index";
import type { UpcMiss } from "./schema";

// How long a recorded miss is trusted before the UPC is eligible for one more
// external try (covers transient upcitemdb failures without re-querying dead
// UPCs on every scan).
const MISS_TTL_DAYS = 30;

// D1 allows 100 binds; the TTL predicate consumes one in addition to the UPCs.
const IN_CHUNK = 99;

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

export async function deleteMiss(db: Database, upc: string): Promise<void> {
  await db.delete(schema.upcMisses).where(eq(schema.upcMisses.upc, upc));
}

export async function getFreshMisses(
  db: Database,
  upcs: string[],
  ttlDays = MISS_TTL_DAYS,
): Promise<Set<string>> {
  const fresh = new Set<string>();
  if (upcs.length === 0) return fresh;

  const batches = await pMap(
    chunk(upcs, IN_CHUNK),
    (batch) =>
      db
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
        ),
    { concurrency: 5 },
  );
  for (const rows of batches) {
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

  // Page rows and total count are independent — one round trip.
  const [rows, countResult] = await Promise.all([
    db.query.upcMisses.findMany({
      where,
      orderBy: [desc(schema.upcMisses.lastCheckedAt)],
      limit: safePageSize,
      offset: (safePage - 1) * safePageSize,
    }),
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.upcMisses)
      .where(where),
  ]);
  const total = countResult[0]?.count ?? 0;

  return { rows, total, page: safePage, pageSize: safePageSize };
}
