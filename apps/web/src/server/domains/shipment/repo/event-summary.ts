import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { shipment, shipmentObservation } from "~/server/db/schema";
import {
  reconcileShipmentTimeline,
  shipmentEventSummary,
} from "~/server/domains/shipment/repo/timeline";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";

/** Reconcile once per claimed batch; ordinary reads never load observations. */
const eventSummaryCompute: DerivedCompute = async (db, ids) => {
  if (ids.length === 0) return new Map();
  const shipmentIds = ids.map((id) => parseEntityId("shipment", id));
  const records = await unwrapDb(db)
    .select({
      id: shipment.id,
      observationId: shipmentObservation.id,
      event: shipmentObservation.event,
    })
    .from(shipment)
    .leftJoin(
      shipmentObservation,
      and(
        eq(shipment.id, shipmentObservation.shipmentId),
        isNull(shipmentObservation.supersededById),
      ),
    )
    .where(and(notDeleted(shipment), inArray(shipment.id, shipmentIds)));
  const groups = new Map<
    string,
    Parameters<typeof reconcileShipmentTimeline>[0][number][]
  >();
  for (const record of records) {
    const group = groups.get(record.id) ?? [];
    if (record.observationId && record.event)
      group.push({
        id: record.observationId,
        event: record.event,
        superseded: false,
      });
    groups.set(record.id, group);
  }
  const out = new Map<string, DerivedComputed>();
  for (const [id, observations] of groups) {
    const value = shipmentEventSummary(reconcileShipmentTimeline(observations));
    out.set(id, { value, sort: null });
  }
  return out;
};

export const shipmentDerivedComputes = {
  "shipment.eventSummary": eventSummaryCompute,
};
