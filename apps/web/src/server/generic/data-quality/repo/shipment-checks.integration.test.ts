import { dataQuality } from "@cubby/schemas/data-quality";
import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";
import { datedShipmentEventTime } from "@cubby/schemas/shipment-evidence";
import type { ShipmentPurpose } from "@cubby/schemas/shipment-fields";
import { generateShortcode } from "@cubby/shared";
import { and, eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb, withTransaction } from "~/server/db/helpers";
import {
  dataExceptionRecord,
  purchase,
  shipment,
  shipmentObservation,
} from "~/server/db/schema";
import { shipmentScaffold } from "~/server/domains/shipment/repo/entity-repository";
import {
  associateShipment,
  canonicalShipment,
  editShipmentObservation,
  recordShipmentEvidence,
} from "~/server/domains/shipment/repo/evidence";
import {
  readShipmentTimeline,
  shipmentEventSummary,
} from "~/server/domains/shipment/repo/timeline";
import { executeEntity } from "~/server/entity-kernel";
import { tombstoneEntityIdentities } from "~/server/entity-kernel/repo/entity-identity-writer";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { scoreSql } from "~/server/generic/data-quality/repo/sql";
import { DERIVED_COMPUTE_BATCH } from "~/server/generic/derived/repo/drain";
import {
  claimDerivedMarks,
  markAllStoredDerived,
  prepareDerivedPage,
  publishDerivedPage,
} from "~/server/generic/derived/repo/drain";
import {
  derivedMarkTickets,
  drainStoredDerived,
} from "~/server/testing/background-queue";
import {
  storedQuality,
  storedQualityIds,
} from "~/server/testing/quality.fixtures";
import { insertEntityFixtures } from "~/server/testing/repo.fixtures";
import { derivedComputes } from "~/server/workflows/derived-computes";

import {
  shipmentChecks,
  SHIPMENT_QUALITY_RULES_VERSION,
} from "./checks/shipment";
import { loadQualityBreakdown } from "./hydrate";

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
  const seed = async (
    observations: ShipmentObservationInput[],
    options: { reviewed?: boolean; purpose?: ShipmentPurpose } = {},
  ) => {
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
            purpose: options.purpose ?? "incoming",
            observations: observations.map((observation, index) => ({
              ...observation,
              timeBasis: observation.timeBasis ?? "stated_event",
              time: datedShipmentEventTime.safeParse(observation.time).success
                ? observation.time
                : day("2026-06-01"),
              sourceEventKey: `event-${index}`,
            })),
          },
        ],
      },
      ctx.actor,
    );
    const code = result.shipmentIds[0]!;
    const row = await canonicalShipment(ctx.db, code);
    // Legacy undated rows remain readable, but the current writer correctly refuses creating them.
    for (const [index, observation] of observations.entries()) {
      if (!datedShipmentEventTime.safeParse(observation.time).success)
        await unwrapDb(ctx.db)
          .update(shipmentObservation)
          .set({
            event: { ...observation, sourceEventKey: `event-${index}` },
          })
          .where(
            and(
              eq(shipmentObservation.shipmentId, row.id),
              eq(shipmentObservation.sourceEventKey, `event-${index}`),
            ),
          );
    }
    if (options.reviewed !== false)
      await associateShipment(
        ctx.db,
        { shipmentId: code, purchaseId: null },
        ctx.actor,
      );
    return { code, row };
  };

  const refresh = () => drainStoredDerived(ctx.db);

  it("requires known purpose and a live purchase or a reviewed non-purchase association", async () => {
    const parcel = await seed([shipped, delivered], {
      reviewed: false,
      purpose: "unknown",
    });
    const quality = async () =>
      (
        await loadDataQualities(ctx.db, "shipment", [parcel.row.id], "live")
      ).get(parcel.row.id)!;
    expect((await quality()).score).toBe(49);
    expect((await quality()).gaps.map((gap) => gap.check)).toEqual(
      expect.arrayContaining([
        "shipment_purpose",
        "shipment_purchase_association",
      ]),
    );
    await associateShipment(
      ctx.db,
      { shipmentId: parcel.code, purchaseId: null },
      ctx.actor,
    );
    expect((await quality()).score).toBe(69);
    const kernel = buildKernelContext(ctx.db, ctx.actor.userId);
    await executeEntity(kernel, {
      action: "bulkUpdate",
      entity: "shipment",
      ids: [parcel.code],
      data: { purpose: "outgoing" },
    });
    expect((await quality()).score).toBe(100);
    await refresh();
    expect(
      (
        await loadDataQualities(ctx.db, "shipment", [parcel.row.id], "stored")
      ).get(parcel.row.id)?.score,
    ).toBe(100);

    const seller = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic parcel seller",
    });
    const order = await createRepoEntity(ctx, "purchase", {
      vendorId: seller.output.id,
      displayLabel: "Synthetic parcel order",
    });
    await associateShipment(
      ctx.db,
      { shipmentId: parcel.code, purchaseId: order.output.id },
      ctx.actor,
    );
    // Imported live associations need no separate member review.
    await unwrapDb(ctx.db)
      .update(shipment)
      .set({ purchaseAssociationReviewed: false })
      .where(eq(shipment.id, parcel.row.id));
    expect((await quality()).score).toBe(100);
    await unwrapDb(ctx.db)
      .update(purchase)
      .set({ deletedAt: new Date() })
      .where(eq(purchase.id, order.entityId));
    expect((await quality()).gaps.map((gap) => gap.check)).toContain(
      "shipment_purchase_association",
    );
    expect((await quality()).score).toBeLessThan(100);
    // Reviewing an existing link does not make a deleted Purchase valid.
    await unwrapDb(ctx.db)
      .update(shipment)
      .set({ purchaseAssociationReviewed: true })
      .where(eq(shipment.id, parcel.row.id));
    expect((await quality()).score).toBeLessThan(100);
    await refresh();
    const filtered = await shipmentScaffold.read(ctx.db, {
      filters: { dataGap: ["shipment_purchase_association"] },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 100 },
    });
    expect(filtered.data.map((row) => row.id)).toContain(parcel.code);
  });

  it("requires shipped, delivered, dated, consistent evidence spanning strictly over one day", async () => {
    const cases = [
      { events: [shipped, delivered], score: 100, gaps: [] },
      {
        events: [shipped, { ...delivered, timeBasis: "estimate" as const }],
        score: 25,
        gaps: [
          "shipment_events",
          "shipment_delivered",
          "shipment_span",
          "shipment_dates",
        ],
      },
      {
        events: [delivered],
        score: 25,
        gaps: [
          "shipment_events",
          "shipment_shipped",
          "shipment_span",
          "shipment_dates",
        ],
      },
      {
        events: [
          shipped,
          { ...shipped, rawStatus: "Another source reports pickup" },
        ],
        score: 25,
        gaps: [
          "shipment_events",
          "shipment_delivered",
          "shipment_span",
          "shipment_dates",
        ],
      },
      {
        events: [shipped, event("delivered", instant("2026-06-02T09:00:00Z"))],
        score: 90,
        gaps: ["shipment_span"],
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
          shipped,
          event("delivered", {
            kind: "local",
            value: "2026-06-03T09:00:00",
            timezone: "America/Los_Angeles",
          }),
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
        gaps: ["shipment_span"],
      },
      {
        events: [event("label_created", day("2026-06-01")), delivered],
        score: 60,
        gaps: ["shipment_shipped", "shipment_dates"],
      },
      {
        events: [event("carrier_possession", { kind: "unknown" }), delivered],
        score: 80,
        gaps: ["shipment_dates", "shipment_span"],
      },
      {
        events: [
          event("carrier_possession", {
            kind: "local",
            value: "Wednesday morning",
            timezone: null,
          }),
          delivered,
        ],
        score: 80,
        gaps: ["shipment_dates", "shipment_span"],
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
        events: [
          event("carrier_possession", instant("2026-06-05T09:00:00Z")),
          delivered,
        ],
        score: 90,
        gaps: ["shipment_chronology"],
      },
      {
        events: [event("carrier_possession", day("2026-06-05")), delivered],
        score: 100,
        gaps: [],
      },
      {
        events: [event("in_transit", day("2026-06-01")), delivered],
        score: 100,
        gaps: [],
      },
    ];
    const parcels = [];
    for (const sample of cases)
      parcels.push({ ...(await seed(sample.events)), sample });
    const ids = parcels.map((parcel) => parcel.row.id);
    const evaluated = await shipmentChecks.evaluate(ctx.db, ids);
    const qualities = await loadDataQualities(ctx.db, "shipment", ids, "live");
    for (const parcel of parcels) {
      const quality = qualities.get(parcel.row.id)!;
      expect(quality.score).toBe(parcel.sample.score);
      expect(quality.gaps.map((gap) => gap.check).sort()).toEqual(
        [...parcel.sample.gaps].sort(),
      );
      const timeline = await readShipmentTimeline(ctx.db, parcel.code);
      const summary = shipmentEventSummary(
        timeline.timeline.filter(({ event }) => event.timeBasis !== "estimate"),
      );
      const raw = evaluated.find((row) => row.id === parcel.row.id)!;
      expect(raw.checks.shipment_events).toBe(
        summary.eventCount >= 2 ? "pass" : "gap",
      );
      expect(raw.checks.shipment_span).toBe(
        summary.eventSpanHours !== null && summary.eventSpanHours > 24
          ? "pass"
          : "gap",
      );
    }
    await refresh();
    const scalar = await unwrapDb(ctx.db)
      .select({ id: shipment.id, score: scoreSql("shipment") })
      .from(shipment);
    for (const parcel of parcels)
      expect(
        Number(scalar.find((row) => row.id === parcel.row.id)?.score),
      ).toBe(parcel.sample.score);
    const filtered = await shipmentScaffold.read(ctx.db, {
      filters: { dataGap: ["shipment_span"] },
      sorts: [{ orderBy: "dataQuality", direction: "asc" }],
      pagination: { pageIndex: 0, pageSize: 100 },
      projection: ["dataQuality"],
    });
    expect(filtered.data.map((row) => row.id).sort()).toEqual(
      parcels
        .filter((p) => p.sample.gaps.includes("shipment_span"))
        .map((p) => p.code)
        .sort(),
    );
    const sorted = await shipmentScaffold.read(ctx.db, {
      filters: {},
      sorts: [{ orderBy: "dataQuality", direction: "asc" }],
      pagination: { pageIndex: 0, pageSize: 100 },
      projection: ["dataQuality"],
    });
    expect(
      sorted.data.map((row) => dataQuality.parse(row.dataQuality).score),
    ).toEqual(parcels.map((p) => p.sample.score).sort((a, b) => a - b));
    const defects = await shipmentScaffold.read(ctx.db, {
      filters: { dataStatus: ["defect"] },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 100 },
    });
    expect(defects.data.map((row) => row.id).sort()).toEqual(
      parcels
        .filter((p) => p.sample.gaps.includes("shipment_chronology"))
        .map((p) => p.code)
        .sort(),
    );
  });

  it("re-evaluates current revisions using dated local clocks without inventing exact times", async () => {
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
          time: { kind: "local", value: "2026-06-03T09:00:00", timezone: null },
        },
      },
      ctx.actor,
    );
    const quality = (
      await loadDataQualities(ctx.db, "shipment", [parcel.row.id], "live")
    ).get(parcel.row.id)!;
    expect(quality.gaps).toHaveLength(0);
    expect(quality.gaps.map((gap) => gap.check)).not.toContain(
      "shipment_chronology",
    );
    const current = shipmentEventSummary(
      (await readShipmentTimeline(ctx.db, parcel.code)).timeline,
    );
    expect(current.eventCount).toBe(2);
    expect(current.eventSpanHours).toBe(48);
  });

  it("backfills stored rows, retains them across reads and input changes, and recomputes older rules versions", async () => {
    // Historical records have no endpoint capture; cross the actual page boundary.
    const historical = await insertEntityFixtures(
      ctx.db,
      shipment,
      "shipment",
      Array.from({ length: DERIVED_COMPUTE_BATCH }, (_, index) => ({
        name: `Synthetic historical parcel ${index}`,
        shortcode: generateShortcode("shipment"),
      })),
    );
    const parcel = await seed([shipped, delivered]);
    const stored = async () =>
      (
        await loadDataQualities(ctx.db, "shipment", [parcel.row.id], "stored")
      ).get(parcel.row.id)!;
    expect((await stored()).status).toBe("not_assessed");
    expect(
      (await loadQualityBreakdown(ctx.db, "shipment", parcel.code)).score,
    ).toBe(100);
    expect(await storedQualityIds(ctx.db)).toEqual([]);
    await refresh();
    expect((await stored()).score).toBe(100);
    // Shipment fixtures also create other stored kinds, such as carrier Vendors.
    expect(await storedQualityIds(ctx.db, "shipment")).toEqual(
      [...historical.map((row) => row.id), parcel.row.id].sort(),
    );
    expect((await storedQuality(ctx.db, historical[0]!.id))?.checks).toEqual(
      expect.objectContaining({
        shipment_purchase_association: "gap",
        shipment_purpose: "gap",
      }),
    );
    const timeline = await readShipmentTimeline(ctx.db, parcel.code);
    await editShipmentObservation(
      ctx.db,
      {
        shipmentId: parcel.code,
        observationId: timeline.observations.find(
          (o) => o.kind === "delivered",
        )!.observationId,
        // Same-day delivery leaves only the span gap.
        patch: { time: instant("2026-06-01T12:00:00Z") },
      },
      ctx.actor,
    );
    expect((await stored()).score).toBe(100);
    expect(
      (await loadQualityBreakdown(ctx.db, "shipment", parcel.code)).score,
    ).toBe(90);
    await refresh();
    expect((await stored()).score).toBe(90);
    // An older version is stale even when the check states are unchanged:
    // reconciliation republishes it.
    await unwrapDb(ctx.db).execute(sql`
      UPDATE "DerivedValue" SET value = jsonb_set(value, '{rulesVersion}', '0'),
        "sortNumber" = 1
       WHERE "entityId" = ${parcel.row.id} AND key = 'dataQuality'`);
    await markAllStoredDerived(ctx.db);
    await refresh();
    expect(await storedQuality(ctx.db, parcel.row.id)).toMatchObject({
      score: 90,
      rulesVersion: SHIPMENT_QUALITY_RULES_VERSION,
    });
    // Waivers are durable member decisions and survive later evidence edits.
    await unwrapDb(ctx.db).insert(dataExceptionRecord).values({
      entityId: parcel.row.id,
      entityKind: "shipment",
      check: "shipment_span",
      reason: "unavailable",
      note: "Synthetic retained decision",
    });
    expect((await stored()).gaps.map((gap) => gap.check)).toContain(
      "shipment_span",
    );
    expect((await stored()).score).toBe(90);
    // Recording the waiver marked the record; the drain applies it.
    await refresh();
    expect((await stored()).score).toBe(100);
    await editShipmentObservation(
      ctx.db,
      {
        shipmentId: parcel.code,
        observationId: (
          await readShipmentTimeline(ctx.db, parcel.code)
        ).observations.find((o) => o.kind === "delivered" && !o.superseded)!
          .observationId,
        patch: { time: instant("2026-06-01T15:00:00Z") },
      },
      ctx.actor,
    );
    expect(
      (await loadQualityBreakdown(ctx.db, "shipment", parcel.code)).score,
    ).toBe(100);
    await refresh();
    expect((await stored()).score).toBe(100);
    expect((await stored()).exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "shipment_span", state: "active" }),
      ]),
    );
    await withTransaction(ctx.db, async (tx) => {
      await tx
        .update(shipment)
        .set({ deletedAt: new Date() })
        .where(eq(shipment.id, parcel.row.id));
      await tombstoneEntityIdentities(tx, [parcel.row.id]);
    });
    expect(await storedQuality(ctx.db, parcel.row.id)).toBeUndefined();
  });

  it("publishes the latest verdict when a write lands during preparation", async () => {
    const parcel = await seed([shipped, delivered]);
    const timeline = await readShipmentTimeline(ctx.db, parcel.code);
    const plan = await prepareDerivedPage(
      ctx.db,
      derivedComputes,
      await claimDerivedMarks(ctx.db),
    );
    await editShipmentObservation(
      ctx.db,
      {
        shipmentId: parcel.code,
        observationId: timeline.observations.find(
          (o) => o.kind === "delivered",
        )!.observationId,
        patch: { time: instant("2026-06-01T12:00:00Z") },
      },
      ctx.actor,
    );
    // The edit re-ticketed the mark, so the stale page cannot clear it; the
    // next drain publishes the edit's verdict (ADR 0021).
    await publishDerivedPage(ctx.db, plan);
    expect(
      await derivedMarkTickets(ctx.db, "shipment.dataQuality", parcel.row.id),
    ).toHaveLength(1);
    await drainStoredDerived(ctx.db);
    expect(
      (
        await loadDataQualities(ctx.db, "shipment", [parcel.row.id], "stored")
      ).get(parcel.row.id)?.score,
    ).toBe(90);
  });
});
