import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { unwrapDb } from "~/server/db/helpers";
import { shipment } from "~/server/db/schema";
import { listShipmentsRead } from "~/server/domains/shipment/repo/entity-repository";
import {
  canonicalShipment,
  editShipmentObservation,
  recordShipmentEvidence,
} from "~/server/domains/shipment/repo/evidence";
import { shipmentQualityFacts } from "~/server/domains/shipment/repo/quality";
import {
  readShipmentTimeline,
  shipmentEventSummary,
} from "~/server/domains/shipment/repo/timeline";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { scoreSql } from "~/server/generic/data-quality/repo/sql";

const event = (
  kind: ShipmentObservationInput["kind"],
  time: ShipmentObservationInput["time"],
): ShipmentObservationInput => ({
  kind,
  time,
  sourceEventKey: null,
  rawStatus: "Synthetic tracking evidence",
  location: null,
  carrierId: null,
  carrierName: null,
  trackingNumber: null,
});
const instant = (value: string): ShipmentObservationInput["time"] => ({
  kind: "instant",
  value,
});
const day = (value: string): ShipmentObservationInput["time"] => ({
  kind: "date",
  value,
});
const shipped = event("carrier_possession", instant("2026-06-01T09:00:00Z"));
const delivered = event("delivered", instant("2026-06-03T09:00:00Z"));

describe("Shipment evidence quality", () => {
  const ctx = withTestDb();
  const seed = async (observations: ShipmentObservationInput[]) => {
    const key = `synthetic-quality-${crypto.randomUUID()}`;
    const result = await recordShipmentEvidence(
      ctx.db,
      {
        source: {
          kind: "tracking_page",
          url: "https://tracking.example/quality",
          externalKey: key,
          content: "Synthetic shipment quality evidence",
          capturedAt: "2026-06-04T09:00:00Z",
        },
        purchaseId: null,
        shipments: [
          {
            shipmentId: null,
            sourceShipmentKey: key,
            distinctPackageEvidence: null,
            carrierId: null,
            carrierName: null,
            trackingNumber: key,
            extraTrackingNumbers: [],
            purpose: "outbound",
            observations: observations.map((observation, index) => ({
              ...observation,
              sourceEventKey: `event-${index}`,
            })),
          },
        ],
      },
      ctx.actor,
    );
    const code = result.shipmentIds[0]!;
    return { code, row: await canonicalShipment(ctx.db, code) };
  };

  it("requires shipped, delivered, dated, consistent evidence spanning strictly over one day", async () => {
    const cases = [
      { events: [shipped, delivered], score: 100, gaps: [] },
      {
        events: [delivered],
        score: 25,
        gaps: [
          "shipment_event_count",
          "shipment_shipped",
          "shipment_event_span",
          "shipment_milestone_dates",
        ],
      },
      {
        events: [
          shipped,
          { ...shipped, rawStatus: "Another source reports pickup" },
        ],
        score: 25,
        gaps: [
          "shipment_event_count",
          "shipment_delivered",
          "shipment_event_span",
          "shipment_milestone_dates",
        ],
      },
      {
        events: [shipped, event("delivered", instant("2026-06-02T09:00:00Z"))],
        score: 90,
        gaps: ["shipment_event_span"],
      },
      {
        events: [shipped, event("delivered", instant("2026-06-02T09:00:01Z"))],
        score: 100,
        gaps: [],
      },
      {
        events: [
          event("carrier_possession", day("2026-06-01")),
          event("delivered", day("2026-06-03")),
        ],
        score: 100,
        gaps: [],
      },
      {
        events: [
          event("carrier_possession", day("2026-06-01")),
          event("delivered", day("2026-06-02")),
        ],
        score: 90,
        gaps: ["shipment_event_span"],
      },
      {
        events: [event("label_created", day("2026-06-01")), delivered],
        score: 60,
        gaps: ["shipment_shipped", "shipment_milestone_dates"],
      },
      {
        events: [event("carrier_possession", { kind: "unknown" }), delivered],
        score: 80,
        gaps: ["shipment_milestone_dates", "shipment_event_span"],
      },
      {
        events: [
          shipped,
          delivered,
          event("delivered", instant("2026-06-03T11:00:00Z")),
        ],
        score: 90,
        gaps: ["shipment_chronology"],
      },
      {
        events: [event("carrier_possession", day("2026-06-05")), delivered],
        score: 90,
        gaps: ["shipment_chronology"],
      },
      {
        events: [event("in_transit", day("2026-06-01")), delivered],
        score: 100,
        gaps: [],
      },
    ];
    for (const sample of cases) {
      const parcel = await seed(sample.events);
      const quality = (
        await loadDataQualities(ctx.db, "shipment", [parcel.row.id])
      ).get(parcel.row.id)!;
      expect(quality.score).toBe(sample.score);
      expect(quality.gaps.map((gap) => gap.check)).toEqual(
        expect.arrayContaining(sample.gaps),
      );
      expect(quality.gaps).toHaveLength(sample.gaps.length);
      const timeline = await readShipmentTimeline(ctx.db, parcel.code);
      const summary = shipmentEventSummary(timeline.timeline);
      const facts = z
        .array(
          z.object({
            eventCount: z.coerce.number(),
            extendedSpan: z.boolean(),
          }),
        )
        .parse(
          (
            await unwrapDb(ctx.db).execute(
              shipmentQualityFacts(sql`ARRAY[${parcel.row.id}]::uuid[]`),
            )
          ).rows,
        )[0]!;
      expect(facts.eventCount).toBe(summary.eventCount);
      expect(facts.extendedSpan).toBe(
        summary.eventSpanHours !== null && summary.eventSpanHours > 24,
      );
      const scalar = await unwrapDb(ctx.db)
        .select({ score: scoreSql("shipment") })
        .from(shipment)
        .where(eq(shipment.id, parcel.row.id));
      expect(Number(scalar[0]?.score)).toBe(quality.score);
      const filtered = await listShipmentsRead(
        ctx.db,
        { dataGap: ["shipment_event_span"] },
        [{ orderBy: "dataQuality", direction: "asc" }],
        { pageIndex: 0, pageSize: 100 },
        { kind: "selected", fields: ["dataQuality"], groups: ["quality"] },
      );
      expect(filtered.data.some((row) => row.id === parcel.code)).toBe(
        quality.gaps.some((gap) => gap.check === "shipment_event_span"),
      );
    }
  });

  it("re-evaluates current revisions and retains an unknown date gap without inventing capture dates", async () => {
    const parcel = await seed([shipped, delivered]);
    const timeline = await readShipmentTimeline(ctx.db, parcel.code);
    await editShipmentObservation(
      ctx.db,
      {
        shipmentId: parcel.code,
        observationId: timeline.observations.find(
          (observation) => observation.kind === "delivered",
        )!.observationId,
        patch: {
          time: { kind: "local", value: "Wednesday morning", timezone: null },
        },
      },
      ctx.actor,
    );
    const quality = (
      await loadDataQualities(ctx.db, "shipment", [parcel.row.id])
    ).get(parcel.row.id)!;
    expect(quality.gaps.map((gap) => gap.check)).toEqual(
      expect.arrayContaining([
        "shipment_event_span",
        "shipment_milestone_dates",
      ]),
    );
    expect(quality.gaps.map((gap) => gap.check)).not.toContain(
      "shipment_chronology",
    );
    const current = shipmentEventSummary(
      (await readShipmentTimeline(ctx.db, parcel.code)).timeline,
    );
    expect(current.eventCount).toBe(2);
    expect(current.eventSpanHours).toBeNull();
  });
});
