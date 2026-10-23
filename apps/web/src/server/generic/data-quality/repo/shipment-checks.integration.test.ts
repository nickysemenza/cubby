import { dataQuality } from "@cubby/schemas/data-quality";
import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";
import { datedShipmentEventTime } from "@cubby/schemas/shipment-evidence";
import type { ShipmentPurpose } from "@cubby/schemas/shipment-fields";
import { generateShortcode } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb, withTransaction } from "~/server/db/helpers";
import {
  dataExceptionRecord,
  entityQuality,
  entityQualityCheck,
  job,
  purchase,
  shipment,
  shipmentObservation,
} from "~/server/db/schema";
import { listShipmentsRead } from "~/server/domains/shipment/repo/entity-repository";
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
import { REFRESH_PAGE_SIZE } from "~/server/generic/derived-refresh/repo/families";
import { invalidateRefreshFamily } from "~/server/generic/derived-refresh/repo/families";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { insertEntityFixtures } from "~/server/testing/repo.fixtures";
import { refreshFamilyHandler } from "~/server/workflows/background-tasks/refresh-families";

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

  const refresh = async () => {
    for (let page = 0; page < 4; page++) {
      const [intent] = await unwrapDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, "refresh:quality"));
      if (!intent)
        throw new Error("Expected quality refresh intent from source write");
      expect(
        await advanceJob(ctx.db, intent.id, {
          "refresh.family": refreshFamilyHandler,
        }),
      ).toBe("succeeded");
      const [current] = await unwrapDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.id, intent.id));
      if (current?.state === "completed") return;
    }
    throw new Error("Synthetic quality pass exceeded its expected page budget");
  };

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
    await invalidateRefreshFamily(ctx.db, "quality");
    await refresh();
    const filtered = await listShipmentsRead(
      ctx.db,
      { dataGap: ["shipment_purchase_association"] },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(filtered.data.map((row) => row.id)).toContain(parcel.code);
  });

  it("requires shipped, delivered, dated, consistent evidence spanning strictly over one day", async () => {
    const cases = [
      { events: [shipped, delivered], score: 100, gaps: [] },
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
    const evaluated = await countTestDbQueries(() =>
      shipmentChecks.evaluate(ctx.db, ids),
    );
    expect(evaluated.queryCount).toBe(1);
    const qualities = await loadDataQualities(ctx.db, "shipment", ids, "live");
    for (const parcel of parcels) {
      const quality = qualities.get(parcel.row.id)!;
      expect(quality.score).toBe(parcel.sample.score);
      expect(quality.gaps.map((gap) => gap.check).sort()).toEqual(
        [...parcel.sample.gaps].sort(),
      );
      const timeline = await readShipmentTimeline(ctx.db, parcel.code);
      const summary = shipmentEventSummary(timeline.timeline);
      const raw = evaluated.result.find((row) => row.id === parcel.row.id)!;
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
    const filtered = await listShipmentsRead(
      ctx.db,
      { dataGap: ["shipment_span"] },
      [{ orderBy: "dataQuality", direction: "asc" }],
      { pageIndex: 0, pageSize: 100 },
      { kind: "selected", fields: ["dataQuality"], groups: ["quality"] },
    );
    expect(filtered.data.map((row) => row.id).sort()).toEqual(
      parcels
        .filter((p) => p.sample.gaps.includes("shipment_span"))
        .map((p) => p.code)
        .sort(),
    );
    const sorted = await listShipmentsRead(
      ctx.db,
      {},
      [{ orderBy: "dataQuality", direction: "asc" }],
      { pageIndex: 0, pageSize: 100 },
      { kind: "selected", fields: ["dataQuality"], groups: ["quality"] },
    );
    expect(
      sorted.data.map((row) => dataQuality.parse(row.dataQuality).score),
    ).toEqual(parcels.map((p) => p.sample.score).sort((a, b) => a - b));
    const defects = await listShipmentsRead(
      ctx.db,
      { dataStatus: ["defect"] },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
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
      Array.from({ length: REFRESH_PAGE_SIZE }, (_, index) => ({
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
    expect(await unwrapDb(ctx.db).select().from(entityQuality)).toEqual([]);
    await refresh();
    expect((await stored()).score).toBe(100);
    // Shipment fixtures also create other stored kinds, such as carrier Vendors.
    const backfilled = await unwrapDb(ctx.db)
      .select()
      .from(entityQuality)
      .where(eq(entityQuality.kind, "shipment"));
    expect(backfilled.map((row) => row.entityId).sort()).toEqual(
      [...historical.map((row) => row.id), parcel.row.id].sort(),
    );
    expect(
      await unwrapDb(ctx.db)
        .select()
        .from(entityQualityCheck)
        .where(eq(entityQualityCheck.kind, "shipment")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: historical[0]!.id,
          checkKey: "shipment_purchase_association",
          state: "gap",
        }),
        expect.objectContaining({
          entityId: historical[0]!.id,
          checkKey: "shipment_purpose",
          state: "gap",
        }),
      ]),
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
    // An older version is stale even when the check states are unchanged.
    await unwrapDb(ctx.db)
      .update(entityQuality)
      .set({ rulesVersion: 0, score: 1 })
      .where(eq(entityQuality.entityId, parcel.row.id));
    await invalidateRefreshFamily(ctx.db, "quality");
    await refresh();
    const [quality] = await unwrapDb(ctx.db)
      .select()
      .from(entityQuality)
      .where(eq(entityQuality.entityId, parcel.row.id));
    expect(quality).toMatchObject({
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
    await invalidateRefreshFamily(ctx.db, "quality");
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
    expect(
      await unwrapDb(ctx.db)
        .select()
        .from(entityQuality)
        .where(eq(entityQuality.entityId, parcel.row.id)),
    ).toEqual([]);
    expect(
      await unwrapDb(ctx.db)
        .select()
        .from(entityQualityCheck)
        .where(eq(entityQualityCheck.entityId, parcel.row.id)),
    ).toEqual([]);
  });

  it("publishes the latest verdict when a write lands during preparation", async () => {
    const parcel = await seed([shipped, delivered]);
    const timeline = await readShipmentTimeline(ctx.db, parcel.code);
    const [intent] = await unwrapDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:quality"));
    const result = await advanceJob(ctx.db, intent!.id, {
      "refresh.family": {
        prepare: async (db, claim) => {
          const prepared = await refreshFamilyHandler.prepare(db, claim);
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
          return prepared;
        },
      },
    });
    // The pass in progress is not restarted; its publication reads the edit.
    expect(result).toBe("succeeded");
    expect(
      (
        await loadDataQualities(ctx.db, "shipment", [parcel.row.id], "stored")
      ).get(parcel.row.id)?.score,
    ).toBe(90);
  });
});
