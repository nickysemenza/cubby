import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";
import { shipmentTimelineOut } from "@cubby/schemas/shipment-evidence";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  shipmentObservation,
  shipmentSourceCapture,
  shipmentObservationCapture,
  purchase,
} from "~/server/db/schema";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import { canonicalShipment } from "./evidence";

export function reconcileShipmentTimeline(
  events: readonly {
    id: string;
    event: ShipmentObservationInput;
    superseded: boolean;
  }[],
) {
  const groups = new Map<
    string,
    { event: ShipmentObservationInput; observationIds: string[] }
  >();
  for (const observation of events) {
    if (observation.superseded) continue;
    const event = observation.event;
    // Coarse or unknown timestamps cannot prove two similar scans describe the same occurrence.
    const key =
      event.time.kind !== "instant"
        ? observation.id
        : canonicalJson(
            jsonSnapshot.parse({
              kind: event.kind,
              time: new Date(event.time.value).toISOString(),
              carrier: event.carrierId ?? event.carrierName,
              location: event.location?.trim().toLowerCase() ?? null,
              trackingNumber:
                event.trackingNumber?.replaceAll(/\s/g, "").toUpperCase() ??
                null,
              ...(event.kind === "unknown"
                ? { rawStatus: event.rawStatus }
                : {}),
            }),
          );
    const prior = groups.get(key);
    if (prior) prior.observationIds.push(observation.id);
    else groups.set(key, { event, observationIds: [observation.id] });
  }
  return [...groups.values()].sort((a, b) => {
    const time = (event: ShipmentObservationInput) =>
      event.time.kind === "instant" ? Date.parse(event.time.value) : Infinity;
    return time(a.event) - time(b.event);
  });
}

export function shipmentMilestones(
  events: readonly ShipmentObservationInput[],
  orderedAt: string | null,
) {
  const conflicts: string[] = [];
  const exact = (kind: ShipmentObservationInput["kind"], first: boolean) => {
    const observations = events.filter((event) => event.kind === kind);
    if (
      !observations.length ||
      observations.some((event) => event.time.kind !== "instant")
    )
      return null;
    const instants = [
      ...new Set(
        observations.flatMap((event) =>
          event.time.kind === "instant"
            ? [new Date(event.time.value).toISOString()]
            : [],
        ),
      ),
    ].sort();
    if (!first && instants.length > 1) {
      conflicts.push("Sources report different delivery times.");
      return null;
    }
    return instants[0] ?? null;
  };
  const carrierPossessionAt = exact("carrier_possession", true);
  const deliveredAt = exact("delivered", false);
  const hours = (start: string | null, end: string | null) => {
    if (!start || !end) return null;
    const duration = (Date.parse(end) - Date.parse(start)) / 3600000;
    if (!Number.isFinite(duration)) return null;
    if (duration < 0) {
      conflicts.push("Milestone timestamps are out of order.");
      return null;
    }
    return duration;
  };
  // Purchase dates are often date-only. Midnight is not an observed order timestamp.
  const orderInstant =
    orderedAt && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(orderedAt) ? orderedAt : null;
  return {
    carrierPossessionAt,
    deliveredAt,
    fulfillmentHours: hours(orderInstant, carrierPossessionAt),
    transitHours: hours(carrierPossessionAt, deliveredAt),
    totalWaitHours: hours(orderInstant, deliveredAt),
    conflicts: [...new Set(conflicts)],
  };
}

export async function readShipmentTimeline(db: Database, code: string) {
  const row = await canonicalShipment(db, code, true);
  const records = await getDb(db)
    .select({
      observation: shipmentObservation,
      source: shipmentSourceCapture.source,
    })
    .from(shipmentObservation)
    .innerJoin(
      shipmentSourceCapture,
      eq(shipmentSourceCapture.id, shipmentObservation.sourceCaptureId),
    )
    .where(eq(shipmentObservation.shipmentId, row.id));
  const memberships = records.length
    ? await getDb(db)
        .select()
        .from(shipmentObservationCapture)
        .where(
          inArray(
            shipmentObservationCapture.observationId,
            records.map((record) => record.observation.id),
          ),
        )
    : [];
  const observations = records.map(({ observation, source }) => ({
    ...observation.event,
    observationId: observation.id,
    sourceCaptureId: observation.sourceCaptureId,
    sourcePackageId: observation.sourcePackageId,
    captureIds: memberships
      .filter((membership) => membership.observationId === observation.id)
      .map((membership) => membership.captureId),
    source:
      source.kind === "email"
        ? source
        : {
            kind: source.kind,
            url: source.url,
            externalKey: source.externalKey,
            capturedAt: source.capturedAt,
          },
    firstSeenAt: observation.firstSeenAt.toISOString(),
    lastSeenAt: observation.lastSeenAt.toISOString(),
    superseded: observation.supersededById !== null,
    memberReviewed: observation.memberReviewed,
  }));
  const timeline = reconcileShipmentTimeline(
    records.map(({ observation }) => ({
      id: observation.id,
      event: observation.event,
      superseded: observation.supersededById !== null,
    })),
  );
  const [order] = row.purchaseId
    ? await getDb(db)
        .select({ date: purchase.date })
        .from(purchase)
        .where(and(eq(purchase.id, row.purchaseId)))
        .limit(1)
    : [];
  return shipmentTimelineOut.parse({
    shipmentId: row.shortcode,
    observations,
    timeline,
    milestones: shipmentMilestones(
      timeline.map((item) => item.event),
      order?.date ?? null,
    ),
  });
}
