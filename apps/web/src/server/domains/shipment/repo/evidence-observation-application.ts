import { and, eq, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  shipmentObservation,
  shipmentObservationCapture,
} from "~/server/db/schema";

import type { ObservationWritePlan } from "./evidence-observation-plan";

export async function applyObservationWrite(
  db: Database,
  plan: ObservationWritePlan,
) {
  const database = getDb(db);
  let retainedId: string;
  if (plan.kind === "repeat") {
    await database
      .update(shipmentObservation)
      .set({ firstSeenAt: plan.firstSeenAt, lastSeenAt: plan.lastSeenAt })
      .where(eq(shipmentObservation.id, plan.id));
    retainedId = plan.id;
  } else {
    const [created] = await database
      .insert(shipmentObservation)
      .values(plan.values)
      .returning();
    if (!created) throw new Error("Shipment observation was not retained.");
    if (plan.canSupersede)
      await database
        .update(shipmentObservation)
        .set({ supersededById: created.id })
        .where(
          and(
            eq(
              shipmentObservation.sourcePackageId,
              plan.values.sourcePackageId,
            ),
            eq(shipmentObservation.occurrenceKey, plan.values.occurrenceKey),
            isNull(shipmentObservation.supersededById),
            ne(shipmentObservation.id, created.id),
          ),
        );
    retainedId = created.id;
  }
  await database
    .insert(shipmentObservationCapture)
    .values({
      observationId: retainedId,
      captureId: plan.captureId,
      firstSeenAt: plan.observedAt,
      lastSeenAt: plan.observedAt,
    })
    .onConflictDoUpdate({
      target: [
        shipmentObservationCapture.observationId,
        shipmentObservationCapture.captureId,
      ],
      set: {
        firstSeenAt: sql`least(${shipmentObservationCapture.firstSeenAt}, ${plan.observedAt})`,
        lastSeenAt: sql`greatest(${shipmentObservationCapture.lastSeenAt}, ${plan.observedAt})`,
      },
    });
}
