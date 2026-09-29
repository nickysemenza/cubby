/**
 * Denominators for the Problems page's coverage meters.
 *
 * Every other detector in this directory answers "which rows are wrong?" and
 * returns just those rows. The coverage sections need the other half of the
 * fraction — the population a backlog is measured against — and nothing else in
 * the codebase computes it. Each count is deliberately the SAME population its
 * paired detector scans, minus that detector's failing predicate, so "N of M"
 * can't quietly compare two different sets. Four of the six are a data-quality
 * check's own `expectedCondition` (declared with `coverage: "<meter>"` on the
 * check, generated into `coverage-totals.gen.ts`), the same SQL the paired
 * `dataGaps` filter scopes to; the two location meters are bespoke populations
 * counted here.
 *
 * All plain `count(*)`s over already-indexed columns. Callers should run this
 * inside `withConnection` so the six queries share one pooled connection.
 */

import type { CoverageTotals } from "@cubby/schemas/problems";
import { and, eq, exists, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { inventoryEntry, location } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { stockOnly } from "~/server/repo/inventory/placement";

import { findCheckCoverageTotals } from "./coverage-totals.gen";

const COUNT = sql<number>`count(*)::int`;

const first = (rows: Array<{ count: number }>): number =>
  Number(rows[0]?.count ?? 0);

export const findCoverageTotals = async (
  db: Database,
): Promise<CoverageTotals> => {
  const dbClient = getDb(db);
  const childLocation = alias(location, "child_location");

  const leafLocations = await dbClient
    .select({ count: COUNT })
    .from(location)
    .where(
      and(
        notDeleted(location),
        notExists(
          dbClient
            .select({ one: sql`1` })
            .from(childLocation)
            .where(
              and(
                eq(childLocation.parentId, location.id),
                notDeleted(childLocation),
              ),
            ),
        ),
      ),
    );

  // Matches the `location/stale-recounts` view's population: locations holding
  // live stock.
  // Leaving installed fixtures in here would permanently cap this meter below
  // 100% — a fixture never gets recounted, so it can never be "covered".
  const stockedLocations = await dbClient
    .select({ count: COUNT })
    .from(location)
    .where(
      and(
        notDeleted(location),
        exists(
          dbClient
            .select({ one: sql`1` })
            .from(inventoryEntry)
            .where(
              and(
                eq(inventoryEntry.locationId, location.id),
                notDeleted(inventoryEntry),
                stockOnly(),
              ),
            ),
        ),
      ),
    );

  return {
    ...(await findCheckCoverageTotals(db)),
    emptyLocations: first(leafLocations),
    staleLocations: first(stockedLocations),
  };
};
