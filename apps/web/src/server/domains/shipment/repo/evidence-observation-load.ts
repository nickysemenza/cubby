import { and, desc, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { requested } from "~/server/db/helpers/requested";
import {
  shipmentObservation,
  shipmentObservationCapture,
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

export async function loadCaptureObservationIds(
  db: Database,
  captureId: string,
  history: readonly (typeof shipmentObservation.$inferSelect)[],
) {
  if (!history.length) return new Set<string>();
  const ids = requested(
    history.map((row) => ({ entity: "shipmentObservation", id: row.id })),
  );
  const rows = await getDb(db)
    .select({ id: shipmentObservationCapture.observationId })
    .from(shipmentObservationCapture)
    .where(
      and(
        eq(shipmentObservationCapture.captureId, captureId),
        ids.match({
          entity: "shipmentObservation",
          id: sql`${shipmentObservationCapture.observationId}`,
        }),
      ),
    );
  return new Set(rows.map((row) => row.id));
}
