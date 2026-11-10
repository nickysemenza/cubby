import { and, desc, eq, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  shipmentObservation,
  type shipmentSourcePackage,
} from "~/server/db/schema";

export async function loadObservationRevision(
  db: Database,
  sourcePackageId: typeof shipmentSourcePackage.$inferSelect.id,
  occurrenceKey: string,
) {
  const database = getDb(db);
  const sameOccurrence = and(
    eq(shipmentObservation.sourcePackageId, sourcePackageId),
    eq(shipmentObservation.occurrenceKey, occurrenceKey),
  );
  const [current] = await database
    .select()
    .from(shipmentObservation)
    .where(and(sameOccurrence, isNull(shipmentObservation.supersededById)))
    .orderBy(desc(shipmentObservation.lastSeenAt))
    .limit(1);
  const versions = await database
    .select()
    .from(shipmentObservation)
    .where(sameOccurrence)
    .orderBy(desc(shipmentObservation.firstSeenAt));
  return { current, versions };
}
