import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { requested } from "~/server/db/helpers/requested";
import {
  shipment,
  shipmentObservation,
  shipmentSourcePackage,
} from "~/server/db/schema";

import {
  identityCandidateSchema,
  identityWindowSchema,
} from "./evidence-packet-plan";

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

export async function loadIdentityCandidates(
  db: Database,
  references: readonly { number: string; carrier: string | null }[],
  observations: readonly ShipmentObservationInput[],
  notificationDate: string | null,
) {
  const dates = await getDb(db).execute(
    sql`SELECT
    min(shipment_event_day(e))::text AS first, max(shipment_event_day(e))::text AS last
    FROM jsonb_array_elements(${JSON.stringify(observations)}::jsonb) e`,
    "objects",
  );
  const observedWindow = identityWindowSchema.parse(dates[0]);
  const window = {
    first: observedWindow.first ?? notificationDate,
    last: observedWindow.last ?? notificationDate,
  };
  const result = await getDb(db).execute(
    // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- carrier is the existing identity JSON object's key, not a carrier-role value.
    sql`SELECT id, shortcode, purchase_id,
    first_day::text, last_day::text, carrier_conflict FROM shipment_identity_candidates(
    (SELECT coalesce(jsonb_agg(jsonb_build_object('trackingNumber', r->>'trackingNumber',
      'carrier', shipment_carrier_key(r->>'carrier'))), '[]'::jsonb)
     FROM jsonb_array_elements(${JSON.stringify(references.map((ref) => ({ trackingNumber: ref.number, carrier: ref.carrier })))}::jsonb) r),
    ${window.first}::date, ${window.last}::date)`,
    "objects",
  );
  return {
    window,
    candidates: z.array(identityCandidateSchema).parse(result),
  };
}
