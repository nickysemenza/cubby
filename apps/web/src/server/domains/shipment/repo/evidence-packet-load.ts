import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { requested } from "~/server/db/helpers/requested";
import {
  shipment,
  shipmentObservation,
  shipmentSourcePackage,
} from "~/server/db/schema";

type SourcePackage = typeof shipmentSourcePackage.$inferSelect;
export async function loadSourcePackages(db: Database, sourceKey: string) {
  return getDb(db)
    .select()
    .from(shipmentSourcePackage)
    .where(eq(shipmentSourcePackage.sourceKey, sourceKey));
}
export async function loadAliasBindings(
  db: Database,
  sourceKey: string,
  number: string,
) {
  const database = getDb(db);
  const prior = await database
    .select({ binding: shipmentSourcePackage })
    .from(shipmentSourcePackage)
    .innerJoin(
      shipmentObservation,
      eq(shipmentObservation.sourcePackageId, shipmentSourcePackage.id),
    )
    .where(
      and(
        eq(shipmentSourcePackage.sourceKey, sourceKey),
        sql`upper(regexp_replace(${shipmentObservation.event}->>'trackingNumber', '[[:space:]]', '', 'g')) = ${number}`,
      ),
    );
  const packets = await database
    .select({ binding: shipmentSourcePackage })
    .from(shipmentSourcePackage)
    .innerJoin(shipment, eq(shipment.id, shipmentSourcePackage.shipmentId))
    .where(
      and(
        eq(shipmentSourcePackage.sourceKey, sourceKey),
        sql`(upper(regexp_replace(${shipment.trackingNumber}, '[[:space:]]', '', 'g')) = ${number} OR EXISTS (SELECT 1 FROM jsonb_array_elements(${shipment.extraTrackingNumbers}) ref WHERE upper(regexp_replace(ref->>'trackingNumber', '[[:space:]]', '', 'g')) = ${number}))`,
      ),
    );
  return [...prior, ...packets];
}
export async function loadRetiredPackage(
  db: Database,
  sourcePackages: readonly SourcePackage[],
) {
  const ids = requested(
    sourcePackages.map((known) => ({
      entity: "shipment",
      id: known.shipmentId,
    })),
  );
  const [retired] = await getDb(db)
    .select({ id: shipment.id })
    .from(shipment)
    .where(
      and(
        ids.match({ entity: "shipment", id: sql`${shipment.id}` }),
        isNotNull(shipment.deletedAt),
      ),
    )
    .limit(1);
  return retired;
}
