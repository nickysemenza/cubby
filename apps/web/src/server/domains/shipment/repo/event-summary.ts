import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { shipment, shipmentObservation } from "~/server/db/schema";
import {
  reconcileShipmentTimeline,
  shipmentEventSummary,
} from "~/server/domains/shipment/repo/timeline";
import { listPrepare } from "~/server/generic/list/repo/field-compiler";

type Summary = ReturnType<typeof shipmentEventSummary>;
type ShipmentId = typeof shipment.$inferSelect.id;

/** Page reads are bounded; sorting prepares the live population once before pagination. */
export async function loadShipmentEventSummaries(
  db: Database | DrizzleTransaction,
  ids?: ShipmentId[],
): Promise<Map<string, Summary>> {
  if (ids?.length === 0) return new Map();
  const records = await unwrapDb(db)
    .select({
      id: shipmentObservation.id,
      shipmentId: shipmentObservation.shipmentId,
      event: shipmentObservation.event,
    })
    .from(shipmentObservation)
    .innerJoin(shipment, eq(shipment.id, shipmentObservation.shipmentId))
    .where(
      and(
        notDeleted(shipment),
        isNull(shipmentObservation.supersededById),
        ids ? inArray(shipment.id, ids) : undefined,
      ),
    );
  const groups = new Map<string, typeof records>();
  for (const record of records) {
    const group = groups.get(record.shipmentId) ?? [];
    group.push(record);
    groups.set(record.shipmentId, group);
  }
  return new Map(
    [...groups].map(([id, events]) => [
      id,
      shipmentEventSummary(
        reconcileShipmentTimeline(
          events.map((event) => ({ ...event, superseded: false })),
        ),
      ),
    ]),
  );
}

export const shipmentEventSummaries = listPrepare((db) =>
  loadShipmentEventSummaries(db),
);

export const shipmentSummarySort = (
  key: "firstEventDate" | "lastEventDate" | "eventSpanHours" | "eventCount",
) =>
  shipmentEventSummaries.value((summaries) => {
    const values = Object.fromEntries(
      [...summaries].map(([id, summary]) => {
        const value = summary[key];
        return [id, typeof value === "string" ? Date.parse(value) : value];
      }),
    );
    const scalar = sql`((${JSON.stringify(values)}::jsonb ->> (${shipment.id})::text)::double precision)`;
    return key === "eventCount" ? sql`coalesce(${scalar}, 0)` : scalar;
  });
