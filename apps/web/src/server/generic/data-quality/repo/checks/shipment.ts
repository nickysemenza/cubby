import {
  datedShipmentEventTime,
  type ShipmentObservationInput,
} from "@cubby/schemas/shipment-evidence";
import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { purchase, shipment, shipmentObservation } from "~/server/db/schema";
import {
  reconcileShipmentTimeline,
  shipmentEventSummary,
  shipmentMilestones,
} from "~/server/domains/shipment/repo/timeline";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
export const SHIPMENT_QUALITY_RULES_VERSION = 2;

type ShipmentQualityRecord = Awaited<
  ReturnType<typeof loadShipmentQualityRecords>
>[number];
const observed = qualityCheck.observed<ShipmentQualityRecord>;

export const shipmentChecks = defineStoredEntityChecks({
  entity: "shipment",
  table: shipment,
  rulesVersion: SHIPMENT_QUALITY_RULES_VERSION,
  load: loadShipmentQualityRecords,
  checks: {
    shipment_purpose: observed((r) => r.purpose !== "unknown"),
    // Reviewed null is a deliberate non-purchase decision; a deleted link is not.
    shipment_purchase_association: observed((r) =>
      r.purchaseId !== null
        ? r.livePurchaseId !== null
        : r.purchaseAssociationReviewed,
    ),
    shipment_events: observed((r) => r.summary.eventCount >= 2),
    shipment_shipped: observed((r) => r.events.some(movement)),
    shipment_delivered: observed((r) =>
      r.events.some((event) => event.kind === "delivered"),
    ),
    shipment_span: observed(
      (r) => r.summary.eventSpanHours !== null && r.summary.eventSpanHours > 24,
    ),
    shipment_dates: observed(
      (r) =>
        r.events.some((event) => movement(event) && dated(event)) &&
        r.events.some((event) => event.kind === "delivered" && dated(event)),
    ),
    shipment_chronology: observed((r) => r.milestones.conflicts.length === 0),
  },
});

const movement = (event: { kind: string }) =>
  [
    "carrier_possession",
    "in_transit",
    "out_for_delivery",
    "delivery_attempt",
  ].includes(event.kind);
// A local clock with a calendar date counts as dated without inventing an instant.
const dated = (event: { time: ShipmentObservationInput["time"] }) =>
  datedShipmentEventTime.safeParse(event.time).success;

async function loadShipmentQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  // One source query for the whole page, including parcels with no observations.
  const rows = await unwrapDb(db)
    .select({
      id: shipment.id,
      shortcode: shipment.shortcode,
      purpose: shipment.purpose,
      purchaseId: shipment.purchaseId,
      purchaseAssociationReviewed: shipment.purchaseAssociationReviewed,
      livePurchaseId: purchase.id,
      observation: shipmentObservation,
    })
    .from(shipment)
    .leftJoin(
      purchase,
      and(eq(purchase.id, shipment.purchaseId), notDeleted(purchase)),
    )
    .leftJoin(
      shipmentObservation,
      eq(shipmentObservation.shipmentId, shipment.id),
    )
    .where(
      and(
        notDeleted(shipment),
        sql`${shipment.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.id) ?? [];
    group.push(row);
    groups.set(row.id, group);
  }
  return [...groups.values()].map((group) => {
    const row = group[0]!;
    const timeline = reconcileShipmentTimeline(
      group.flatMap(({ observation }) =>
        observation
          ? [
              {
                id: observation.id,
                event: observation.event,
                superseded: observation.supersededById !== null,
              },
            ]
          : [],
      ),
    );
    const events = timeline.map(({ event }) => event);
    return {
      id: row.id,
      shortcode: row.shortcode,
      purpose: row.purpose,
      purchaseId: row.purchaseId,
      purchaseAssociationReviewed: row.purchaseAssociationReviewed,
      livePurchaseId: row.livePurchaseId,
      events,
      summary: shipmentEventSummary(timeline),
      // The Purchase has a calendar date, not an observed order instant.
      milestones: shipmentMilestones(events, null),
    };
  });
}
