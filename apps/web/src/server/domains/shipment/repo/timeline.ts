import type {
  ShipmentEvidenceSource,
  ShipmentObservationInput,
} from "@cubby/schemas/shipment-evidence";
import {
  datedShipmentEventTime,
  shipmentTimelineOut,
} from "@cubby/schemas/shipment-evidence";
import { and, eq, inArray } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import { roundTo } from "~/lib/round-to";
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
              timeBasis: event.timeBasis ?? "stated_event",
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

/** Summary endpoints preserve date precision; capture/observation times never fill gaps. */
export function shipmentEventSummary(
  timeline: ReturnType<typeof reconcileShipmentTimeline>,
) {
  // First/last describe retained observations, including dated forecasts.
  // Delivery milestones and quality independently require actual event evidence.
  const dated = timeline.flatMap<
    Extract<ShipmentObservationInput["time"], { kind: "instant" | "date" }>
  >(({ event }) => {
    const time = event.time;
    if (time.kind === "instant")
      return [{ ...time, value: new Date(time.value).toISOString() }];
    if (time.kind === "date") return [time];
    // A local clock still establishes its literal calendar day without inventing an offset.
    if (time.kind === "local") {
      const date = time.value.slice(0, 10);
      if (datedShipmentEventTime.safeParse(time).success)
        return [{ kind: "date", value: date }];
    }
    return [];
  });
  const day = (time: (typeof dated)[number]) =>
    time.kind === "date"
      ? time.value
      : householdLocalDate(new Date(time.value));
  // Compare mixed precision in household calendar days; midnight is only a sorting anchor.
  const epoch = (time: (typeof dated)[number]) => Date.parse(time.value);
  dated.sort((a, b) => day(a).localeCompare(day(b)) || epoch(a) - epoch(b));
  const first = dated[0];
  const last = dated.at(-1);
  const coarse = first?.kind === "date" || last?.kind === "date";
  const hours =
    !first || !last || dated.length < 2
      ? null
      : coarse
        ? (Date.parse(day(last)) - Date.parse(day(first))) / 3600000
        : (epoch(last) - epoch(first)) / 3600000;
  return {
    firstEventDate: first ? day(first) : null,
    lastEventDate: last ? day(last) : null,
    eventSpanHours: hours,
    eventSpanLabel:
      hours === null
        ? null
        : coarse
          ? `${hours / 24}d`
          : `${roundTo(hours, 2)}h`,
    eventCount: timeline.length,
  };
}

export function shipmentMilestones(
  events: readonly ShipmentObservationInput[],
  orderedAt: string | null,
) {
  const conflicts: string[] = [];
  const exact = (kind: ShipmentObservationInput["kind"], first: boolean) => {
    const observations = events.filter(
      (event) => event.kind === kind && event.timeBasis !== "estimate",
    );
    if (
      !observations.length ||
      observations.some(
        (event) =>
          event.time.kind !== "instant" ||
          event.timeBasis === "notification_received",
      )
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

function publicTimelineSource(source: ShipmentEvidenceSource) {
  if (source.kind === "email") return source;
  if (source.kind === "tracking_page")
    return {
      kind: source.kind,
      url: source.url,
      externalKey: source.externalKey,
      capturedAt: source.capturedAt,
    };
  return {
    kind: source.kind,
    externalKey: source.externalKey,
    fileName: source.fileName,
    sender: source.sender,
    sentAt: source.sentAt,
    capturedAt: source.capturedAt,
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
        .select({
          observationId: shipmentObservationCapture.observationId,
          captureId: shipmentObservationCapture.captureId,
          source: shipmentSourceCapture.source,
        })
        .from(shipmentObservationCapture)
        .innerJoin(
          shipmentSourceCapture,
          eq(shipmentSourceCapture.id, shipmentObservationCapture.captureId),
        )
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
    source: publicTimelineSource(source),
    captureSources: memberships
      .filter((membership) => membership.observationId === observation.id)
      .map((membership) => ({
        captureId: membership.captureId,
        source: publicTimelineSource(membership.source),
      })),
    firstSeenAt: observation.firstSeenAt.toISOString(),
    lastSeenAt: observation.lastSeenAt.toISOString(),
    superseded: observation.supersededById !== null,
    supersededByObservationId: observation.supersededById,
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
