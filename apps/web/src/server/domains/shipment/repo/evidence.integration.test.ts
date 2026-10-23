import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  RecordShipmentEvidenceInput,
  ShipmentEvidence,
  ShipmentObservationInput,
} from "@cubby/schemas/shipment-evidence";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  shipment,
  shipmentObservation,
  shipmentSourceCapture,
  expense,
  inventoryEntry,
  email,
  user,
} from "~/server/db/schema";
import {
  memberImportWorld,
  retainedMailFixture,
} from "~/server/domains/purchase-import/operations/order-import.fixtures";
import { mergeVendors } from "~/server/domains/vendor/repo/vendor";
import { shipmentTrackingReport } from "~/server/generic/entity-report/repo/shipment";

import {
  recordShipmentEvidence,
  associateShipment,
  mergeShipment,
  reassignShipmentEvidence,
  editShipmentObservation,
} from "./evidence";
import { readShipmentTimeline } from "./timeline";

const packet = (number = "EXAMPLE-123"): ShipmentEvidence => ({
  shipmentId: null,
  sourceShipmentKey: number,
  distinctPackageEvidence: null,
  carrierId: null,
  carrierName: "Synthetic Parcel Carrier",
  trackingNumber: number,
  extraTrackingNumbers: [],
  purpose: "outbound",
  observations: [
    {
      sourceEventKey: "scan-one",
      kind: "carrier_possession",
      time: { kind: "instant", value: "2026-06-03T09:00:00Z" },
      rawStatus: "Synthetic pickup",
      location: null,
      carrierId: null,
      carrierName: "Synthetic Parcel Carrier",
      trackingNumber: number,
    },
  ],
});
const capture = (
  key: string,
  shipments = [packet()],
  capturedAt = "2026-06-06T09:00:00Z",
  content = `Synthetic tracking evidence ${key}`,
): RecordShipmentEvidenceInput => ({
  source: {
    kind: "tracking_page",
    url: "https://tracking.example/package",
    externalKey: key,
    capturedAt,
    content,
  },
  purchaseId: null,
  shipments,
});

describe("Shipment retained evidence", () => {
  const ctx = withTestDb();

  it("requires a calendar date for new observations and reviewed time edits", async () => {
    const undated = packet();
    const scan = undated.observations[0];
    if (!scan) throw new Error("Synthetic observation missing");
    scan.time = { kind: "unknown" };
    await expect(
      recordShipmentEvidence(ctx.db, capture("undated", [undated]), ctx.actor),
    ).rejects.toThrow("calendar date");
    const first = await recordShipmentEvidence(
      ctx.db,
      capture("dated"),
      ctx.actor,
    );
    const code = first.shipmentIds[0];
    if (!code) throw new Error("Synthetic Shipment missing");
    const timeline = await readShipmentTimeline(ctx.db, code);
    const observation = timeline.observations[0];
    if (!observation) throw new Error("Synthetic observation missing");
    await expect(
      editShipmentObservation(
        ctx.db,
        {
          shipmentId: code,
          observationId: observation.observationId,
          patch: { time: { kind: "unknown" } },
        },
        ctx.actor,
      ),
    ).rejects.toThrow("calendar date");
  });

  it("retains an exported SMS, replays without duplicates and refuses changed message evidence", async () => {
    const input: RecordShipmentEvidenceInput = {
      source: {
        kind: "sms_export",
        externalKey: "synthetic-thread:message-one",
        fileName: "synthetic-carrier.txt",
        sender: "Synthetic Parcel Carrier",
        sentAt: {
          kind: "local",
          value: "2026-06-03T09:05:00",
          timezone: "America/Los_Angeles",
        },
        capturedAt: "2026-06-06T09:00:00Z",
        content: "Synthetic Parcel Carrier: EXAMPLE-123 picked up.",
      },
      purchaseId: null,
      shipments: [packet()],
    };
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const replay = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(replay.shipmentIds).toEqual(first.shipmentIds);
    expect(replay.insertedObservations).toBe(0);
    const code = first.shipmentIds[0];
    if (!code) throw new Error("Synthetic Shipment missing");
    const timeline = await readShipmentTimeline(ctx.db, code);
    expect(timeline.observations).toHaveLength(1);
    expect(timeline.observations[0]?.source).toMatchObject({
      kind: "sms_export",
      externalKey: "synthetic-thread:message-one",
      sender: "Synthetic Parcel Carrier",
      sentAt:
        input.source.kind === "sms_export" ? input.source.sentAt : undefined,
    });
    const captures = await getDb(ctx.db).select().from(shipmentSourceCapture);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.source).toEqual(input.source);
    if (input.source.kind !== "sms_export")
      throw new Error("Synthetic SMS missing");
    await expect(
      recordShipmentEvidence(
        ctx.db,
        {
          ...input,
          source: {
            ...input.source,
            sentAt: {
              kind: "local",
              value: "2026-06-03T09:05:00",
              timezone: null,
            },
          },
        },
        ctx.actor,
      ),
    ).rejects.toThrow("America/Los_Angeles");
    await expect(
      recordShipmentEvidence(
        ctx.db,
        {
          ...input,
          source: { ...input.source, content: "Synthetic changed message" },
        },
        ctx.actor,
      ),
    ).rejects.toThrow("exported SMS source changed");
    expect(
      (await readShipmentTimeline(ctx.db, code)).observations,
    ).toHaveLength(1);
    const otherUserId = testUserId("synthetic-sms-member");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Synthetic second member",
      email: "sms-member@example.com",
      emailVerified: true,
    });
    await recordShipmentEvidence(
      ctx.db,
      {
        ...input,
        source: { ...input.source, fileName: "synthetic-second-export.txt" },
        shipments: [{ ...packet(), shipmentId: code }],
      },
      { ...ctx.actor, userId: otherUserId },
    );
    const report = await shipmentTrackingReport(ctx.db, code);
    const timelineBlock = report.find((block) => block.kind === "records");
    if (timelineBlock?.kind !== "records")
      throw new Error("Synthetic timeline missing");
    expect(timelineBlock.rows).toHaveLength(1);
    expect(timelineBlock.rows[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "SMS from Synthetic Parcel Carrier · synthetic-carrier.txt",
        }),
        expect.objectContaining({
          text: "SMS from Synthetic Parcel Carrier · synthetic-second-export.txt",
        }),
      ]),
    );
  });

  it("partially edits a keyless observation, retains originals and protects the reviewed revision from replay", async () => {
    const parcel = packet();
    const event = parcel.observations[0];
    if (!event) throw new Error("Synthetic event missing");
    parcel.observations = [
      {
        ...event,
        sourceEventKey: null,
        time: { kind: "local", value: "2026-06-03T09:00:00", timezone: null },
      },
    ];
    const input = capture("member-edit", [parcel]);
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const code = first.shipmentIds[0];
    if (!code) throw new Error("Synthetic Shipment missing");
    const before = await readShipmentTimeline(ctx.db, code);
    const original = before.observations[0];
    if (!original) throw new Error("Synthetic observation missing");
    const edit = {
      shipmentId: code,
      observationId: original.observationId,
      patch: {
        time: { kind: "instant", value: "2026-06-03T09:00:00-07:00" },
        location: "Synthetic West Coast Facility",
      },
    };
    await editShipmentObservation(ctx.db, edit, ctx.actor);
    await editShipmentObservation(ctx.db, edit, ctx.actor);
    await recordShipmentEvidence(
      ctx.db,
      {
        ...input,
        source: {
          ...input.source,
          kind: "tracking_page",
          url: "https://tracking.example/package",
          externalKey: "member-edit",
          content: "Synthetic later capture with the original scan",
          capturedAt: new Date().toISOString(),
        },
      },
      ctx.actor,
    );
    const after = await readShipmentTimeline(ctx.db, code);
    expect(after.timeline).toHaveLength(1);
    expect(after.observations).toHaveLength(2);
    expect(
      after.observations.find(
        (observation) => observation.observationId === original.observationId,
      ),
    ).toMatchObject({
      time: original.time,
      superseded: true,
      memberReviewed: false,
    });
    expect(after.timeline[0]?.event).toEqual({
      ...event,
      sourceEventKey: null,
      ...edit.patch,
      carrierId: original.carrierId,
    });
    expect(
      after.observations.find((observation) => !observation.superseded),
    ).toMatchObject({
      memberReviewed: true,
      captureIds: original.captureIds,
    });
    expect(after.milestones.carrierPossessionAt).toBe(
      "2026-06-03T16:00:00.000Z",
    );
    await expect(
      editShipmentObservation(ctx.db, { ...edit, patch: {} }, ctx.actor),
    ).rejects.toThrow(/changed field/);
    const another = await recordShipmentEvidence(
      ctx.db,
      capture("another-shipment", [packet("EXAMPLE-OTHER")]),
      ctx.actor,
    );
    await expect(
      editShipmentObservation(
        ctx.db,
        { ...edit, shipmentId: another.shipmentIds[0] },
        ctx.actor,
      ),
    ).rejects.toThrow(/does not belong/);
    await expect(
      editShipmentObservation(
        ctx.db,
        { ...edit, patch: { rawStatus: "Another edit" } },
        ctx.actor,
      ),
    ).rejects.toThrow(/superseded/);
    await expect(
      editShipmentObservation(ctx.db, edit, {
        ...ctx.actor,
        userId: testUserId("foreign-observation-editor"),
      }),
    ).rejects.toThrow(/does not own/);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("keeps member edits active when a keyed source publishes another revision", async () => {
    const input = capture("keyed-edit");
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const code = first.shipmentIds[0];
    if (!code) throw new Error("Synthetic Shipment missing");
    const original = (await readShipmentTimeline(ctx.db, code)).observations[0];
    if (!original) throw new Error("Synthetic observation missing");
    await editShipmentObservation(
      ctx.db,
      {
        shipmentId: code,
        observationId: original.observationId,
        patch: { rawStatus: "Member verified pickup", location: null },
      },
      ctx.actor,
    );
    const revised = packet();
    revised.observations = revised.observations.map((event) => ({
      ...event,
      rawStatus: "Later source revision",
    }));
    await recordShipmentEvidence(
      ctx.db,
      capture(
        "keyed-edit",
        [revised],
        new Date().toISOString(),
        "Synthetic later source revision",
      ),
      ctx.actor,
    );
    const report = await readShipmentTimeline(ctx.db, code);
    expect(report.timeline).toHaveLength(1);
    expect(report.timeline[0]?.event.rawStatus).toBe("Member verified pickup");
    expect(report.observations).toHaveLength(3);
    expect(
      report.observations.filter((observation) => observation.superseded),
    ).toHaveLength(2);
  });

  it("replays a package without duplicate observations, financial writes or inventory receipts", async () => {
    const input = capture("replay");
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const repeat = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(repeat.shipmentIds).toEqual(first.shipmentIds);
    expect(repeat).toMatchObject({
      insertedObservations: 0,
      repeatedObservations: 1,
    });
    expect(await getDb(ctx.db).select().from(shipment)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(shipmentObservation)).toHaveLength(
      1,
    );
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("keeps source revisions and ignores superseded observations in milestones", async () => {
    const input = capture("revision");
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const revised = packet();
    revised.observations[0] = {
      ...revised.observations[0]!,
      time: { kind: "instant", value: "2026-06-03T11:00:00Z" },
      rawStatus: "Corrected pickup time",
    };
    await recordShipmentEvidence(
      ctx.db,
      {
        ...input,
        source: {
          ...input.source,
          kind: "tracking_page",
          url: "https://tracking.example/package",
          externalKey: "revision",
          capturedAt: "2026-06-06T10:00:00Z",
          content: "Synthetic corrected capture",
        },
        shipments: [revised],
      },
      ctx.actor,
    );
    const timeline = await readShipmentTimeline(ctx.db, first.shipmentIds[0]!);
    expect(timeline.observations).toHaveLength(2);
    expect(timeline.timeline).toHaveLength(1);
    expect(timeline.milestones.carrierPossessionAt).toBe(
      "2026-06-03T11:00:00.000Z",
    );
    expect(
      await getDb(ctx.db).select().from(shipmentSourceCapture),
    ).toHaveLength(2);
  });

  it("retains split packages and does not globally identify reused tracking numbers", async () => {
    const first = await recordShipmentEvidence(
      ctx.db,
      capture("first", [packet(), packet("EXAMPLE-456")]),
      ctx.actor,
    );
    const unrelated = await recordShipmentEvidence(
      ctx.db,
      capture("another-order"),
      ctx.actor,
    );
    expect(first.shipmentIds).toHaveLength(2);
    expect(unrelated.shipmentIds[0]).not.toBe(first.shipmentIds[0]);
    expect(await getDb(ctx.db).select().from(shipment)).toHaveLength(3);
  });

  it("combines sources only with a supported Purchase/carrier/tracking identity", async () => {
    const seller = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Seller",
    });
    const order = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller.output.id,
    });
    const input = { ...capture("carrier"), purchaseId: order.output.id };
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const second = await recordShipmentEvidence(
      ctx.db,
      { ...capture("shop"), purchaseId: order.output.id },
      ctx.actor,
    );
    expect(second.shipmentIds).toEqual(first.shipmentIds);
    const report = await readShipmentTimeline(ctx.db, first.shipmentIds[0]!);
    expect(report.observations).toHaveLength(2);
    expect(report.timeline).toHaveLength(1);
  });

  it("retains handoff references and all observations through explicit merge", async () => {
    const first = await recordShipmentEvidence(
      ctx.db,
      capture("international"),
      ctx.actor,
    );
    const handoff = packet("EXAMPLE-LAST-MILE");
    handoff.carrierName = "Synthetic Postal Carrier";
    handoff.observations = handoff.observations.map((event) => ({
      ...event,
      carrierName: handoff.carrierName,
      kind: "delivered",
    }));
    const last = await recordShipmentEvidence(
      ctx.db,
      capture("last-mile", [handoff]),
      ctx.actor,
    );
    await mergeShipment(
      ctx.db,
      { sourceId: last.shipmentIds[0], targetId: first.shipmentIds[0] },
      ctx.actor,
    );
    const report = await readShipmentTimeline(ctx.db, last.shipmentIds[0]!);
    expect(report.shipmentId).toBe(first.shipmentIds[0]);
    expect(report.observations).toHaveLength(2);
    const [survivor] = await getDb(ctx.db)
      .select()
      .from(shipment)
      .where(eq(shipment.shortcode, report.shipmentId));
    expect(survivor?.extraTrackingNumbers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ trackingNumber: "EXAMPLE-LAST-MILE" }),
      ]),
    );
    expect(await getDb(ctx.db).select().from(shipment)).toHaveLength(2);
  });

  it("requires distinct-package evidence for trackingless imports", async () => {
    const trackingless = {
      ...packet(),
      trackingNumber: null,
      sourceShipmentKey: "package-a",
      distinctPackageEvidence: "Vendor explicitly names package A",
    };
    const first = await recordShipmentEvidence(
      ctx.db,
      capture("trackingless", [trackingless]),
      ctx.actor,
    );
    expect(first.shipmentIds).toHaveLength(1);
    await expect(
      recordShipmentEvidence(
        ctx.db,
        capture("unsupported", [
          { ...trackingless, distinctPackageEvidence: null },
        ]),
        ctx.actor,
      ),
    ).rejects.toThrow(/distinct-package/);
  });

  it("checks owned Email originals and checksums before retaining evidence", async () => {
    const world = await memberImportWorld(ctx.db, ctx.actor);
    await retainedMailFixture(ctx.db, {
      ledgerPartyId: world.party.id,
      messageId: "synthetic-shipment",
      checksum: "a".repeat(64),
    });
    const [message] = await getDb(ctx.db)
      .select()
      .from(email)
      .where(eq(email.messageId, "synthetic-shipment"));
    if (!message) throw new Error("Synthetic Email missing");
    const input: RecordShipmentEvidenceInput = {
      source: {
        kind: "email",
        emailId: parseShortcodeFor("email", message.shortcode),
        checksum: "a".repeat(64),
      },
      purchaseId: null,
      shipments: [packet()],
    };
    await expect(
      recordShipmentEvidence(
        ctx.db,
        {
          ...input,
          source: {
            ...input.source,
            kind: "email",
            emailId: parseShortcodeFor("email", message.shortcode),
            checksum: "b".repeat(64),
          },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/changed/);
    expect(await getDb(ctx.db).select().from(shipment)).toEqual([]);
    const result = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(result.shipmentIds).toHaveLength(1);
    const otherMember = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic other member",
      kind: "member",
    });
    const seller = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic other seller",
    });
    const account = await createRepoIdentity(ctx, "vendorAccount", {
      vendorId: seller.output.id,
      ledgerPartyId: otherMember.output.id,
    });
    const order = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller.output.id,
      vendorAccountId: account.output.id,
    });
    await expect(
      recordShipmentEvidence(
        ctx.db,
        {
          ...capture("foreign-attachment", [
            { ...packet(), shipmentId: result.shipmentIds[0]! },
          ]),
          purchaseId: order.output.id,
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/different members/);
  });

  it("keeps source package identity stable through a carrier Vendor merge", async () => {
    const carrier = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic old carrier",
    });
    const keeper = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic canonical carrier",
    });
    const input = capture("carrier-identity", [
      { ...packet(), carrierId: carrier.output.id, sourceShipmentKey: null },
    ]);
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    await mergeVendors(
      ctx.db,
      { keepId: keeper.output.id, mergeIds: [carrier.output.id] },
      ctx.actor,
    );
    const replay = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(replay.shipmentIds).toEqual(first.shipmentIds);
    expect(await getDb(ctx.db).select().from(shipmentObservation)).toHaveLength(
      1,
    );
  });

  it("associates unmatched packages without creating Purchase or Expense records", async () => {
    const result = await recordShipmentEvidence(
      ctx.db,
      capture("unmatched"),
      ctx.actor,
    );
    const seller = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic association seller",
    });
    const order = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller.output.id,
    });
    await associateShipment(
      ctx.db,
      { shipmentId: result.shipmentIds[0], purchaseId: order.output.id },
      ctx.actor,
    );
    const [row] = await getDb(ctx.db).select().from(shipment);
    expect(row?.purchaseId).not.toBeNull();
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });

  it("preserves an explicitly detached Purchase association on replay", async () => {
    const seller = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic detached seller",
    });
    const order = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller.output.id,
    });
    const input = { ...capture("detached"), purchaseId: order.output.id };
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    await associateShipment(
      ctx.db,
      { shipmentId: first.shipmentIds[0], purchaseId: null },
      ctx.actor,
    );
    await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const [row] = await getDb(ctx.db).select().from(shipment);
    expect(row).toMatchObject({
      purchaseId: null,
      purchaseAssociationReviewed: true,
    });
  });

  it("keeps explicitly distinct packages under one master tracking number", async () => {
    const seller = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic split seller",
    });
    const order = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller.output.id,
    });
    const packages = ["a", "b"].map((key) => ({
      ...packet(),
      sourceShipmentKey: key,
      distinctPackageEvidence: `Vendor names separate package ${key}`,
    }));
    const result = await recordShipmentEvidence(
      ctx.db,
      { ...capture("master", packages), purchaseId: order.output.id },
      ctx.actor,
    );
    expect(result.shipmentIds).toHaveLength(2);
  });

  it("retains A to B to A revisions without resurrecting old replays", async () => {
    const original = packet();
    const changed = {
      ...packet(),
      observations: packet().observations.map(
        (event): ShipmentObservationInput => ({
          ...event,
          rawStatus: "Synthetic corrected pickup",
          time: { kind: "instant", value: "2026-06-03T11:00:00Z" },
        }),
      ),
    };
    const first = await recordShipmentEvidence(
      ctx.db,
      capture("restored", [original]),
      ctx.actor,
    );
    await recordShipmentEvidence(
      ctx.db,
      capture(
        "restored",
        [changed],
        "2026-06-06T10:00:00Z",
        "Synthetic changed snapshot",
      ),
      ctx.actor,
    );
    await recordShipmentEvidence(
      ctx.db,
      capture("restored", [original], "2026-06-06T11:00:00Z"),
      ctx.actor,
    );
    await recordShipmentEvidence(
      ctx.db,
      capture(
        "restored",
        [changed],
        "2026-06-06T10:00:00Z",
        "Synthetic changed snapshot",
      ),
      ctx.actor,
    );
    const report = await readShipmentTimeline(ctx.db, first.shipmentIds[0]!);
    expect(report.observations).toHaveLength(3);
    expect(report.observations.filter((row) => !row.superseded)).toHaveLength(
      1,
    );
    expect(report.milestones.carrierPossessionAt).toBe(
      "2026-06-03T09:00:00.000Z",
    );
  });

  it("retains multiple identical source occurrences with coarse timestamps", async () => {
    const occurrence: ShipmentObservationInput = {
      ...packet().observations[0]!,
      sourceEventKey: null,
      time: { kind: "date", value: "2026-06-03" },
    };
    const input = capture("coarse", [
      { ...packet(), observations: [occurrence, occurrence] },
    ]);
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const repeat = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(repeat).toMatchObject({
      insertedObservations: 0,
      repeatedObservations: 2,
    });
    const report = await readShipmentTimeline(ctx.db, first.shipmentIds[0]!);
    expect(report.observations).toHaveLength(2);
    expect(report.timeline).toHaveLength(2);
  });

  it("links repeated observations to every supporting literal capture", async () => {
    const first = await recordShipmentEvidence(
      ctx.db,
      capture(
        "support",
        [packet()],
        "2026-06-06T09:00:00Z",
        "  Synthetic snapshot\n",
      ),
      ctx.actor,
    );
    await recordShipmentEvidence(
      ctx.db,
      capture(
        "support",
        [packet()],
        "2026-06-06T10:00:00Z",
        "Synthetic snapshot",
      ),
      ctx.actor,
    );
    const report = await readShipmentTimeline(ctx.db, first.shipmentIds[0]!);
    expect(report.observations).toHaveLength(1);
    expect(report.observations[0]?.captureIds).toHaveLength(2);
    const captures = await getDb(ctx.db).select().from(shipmentSourceCapture);
    expect(
      captures.map((row) =>
        row.source.kind === "tracking_page" ? row.source.content : null,
      ),
    ).toContain("  Synthetic snapshot\n");
  });

  it("keeps explicit source package reassignment through subsequent replay", async () => {
    const input = capture("misassociated");
    const source = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const target = await recordShipmentEvidence(
      ctx.db,
      capture("correct-package", [packet("EXAMPLE-CORRECT")]),
      ctx.actor,
    );
    const report = await readShipmentTimeline(ctx.db, source.shipmentIds[0]!);
    const sourcePackageId = report.observations[0]?.sourcePackageId;
    if (!sourcePackageId)
      throw new Error("Synthetic source package identity missing");
    await reassignShipmentEvidence(
      ctx.db,
      { sourcePackageId, targetShipmentId: target.shipmentIds[0] },
      ctx.actor,
    );
    const replay = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(replay.shipmentIds).toEqual(target.shipmentIds);
    expect(
      (await readShipmentTimeline(ctx.db, target.shipmentIds[0]!)).observations,
    ).toHaveLength(2);
  });
});
