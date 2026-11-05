import type { ShipmentUpdateData } from "@cubby/schemas/entities/shipment";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  RecordShipmentEvidenceInput,
  ShipmentEvidence,
} from "@cubby/schemas/shipment-evidence";
import type { ShipmentExtraTrackingNumberRemovals } from "@cubby/schemas/shipment-fields";
import { testUserId } from "@cubby/schemas/testing";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  auditLog,
  shipment,
  shipmentObservation,
  shipmentSourceCapture,
  shipmentSourcePackage,
  vendor,
  runFinding,
  expense,
  inventoryEntry,
  email,
  ledgerParty,
  purchase,
  user,
} from "~/server/db/schema";
import {
  memberImportWorld,
  retainedMailFixture,
} from "~/server/domains/purchase-import/operations/order-import.fixtures";
import { mergeVendors } from "~/server/domains/vendor/repo/vendor";
import { executeEntity } from "~/server/entity-kernel";
import { getEntityGraph } from "~/server/generic/entity-graph/repo/entity-graph";
import { getConnectedRecords } from "~/server/generic/entity-links/repo/connected-records";
import { shipmentTrackingReport } from "~/server/generic/entity-report/repo/shipment";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";
import { drainStoredDerived } from "~/server/testing/background-queue";

import {
  carrierFormatEvidence,
  retainedCarrierClaim,
  assessCarrierPacket,
  carrierCaptureEvidence,
  deliveryFieldCodes,
} from "./carrier-evidence";
import {
  recordShipmentEvidence,
  associateShipment,
  mergeShipment,
  reassignShipmentEvidence,
  editShipmentObservation,
  editShipmentReferences,
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
  purpose: "incoming",
  observations: [
    {
      sourceEventKey: "scan-one",
      kind: "carrier_possession",
      timeBasis: "stated_event",
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

const carrierClaim = (
  trackingNumber: string,
  carrierName: string,
  quote = `${carrierName} tracking ${trackingNumber}`,
): NonNullable<ShipmentEvidence["carrierClaims"]>[number] => ({
  trackingNumber,
  carrierName,
  role: "carrier",
  service: null,
  evidence: { kind: "statement", quote },
});

describe("Shipment retained evidence", () => {
  const ctx = withTestDb();

  const setCarrierFixture = async (
    code: string,
    carrierId: (typeof shipment.$inferSelect)["carrierId"],
  ) => {
    await getDb(ctx.db)
      .update(shipment)
      .set({ carrierId })
      .where(eq(shipment.shortcode, code));
  };

  it("corrects source contradictions and preserves replay without assignment receipts", async () => {
    await memberImportWorld(ctx.db, ctx.actor);
    const wrong = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Courier Alpha",
    });
    const correct = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Courier Beta",
      aliases: ["Synthetic Beta Ground", "Synthetic Tracking Carrier"],
    });
    const original = capture("authority", [
      {
        ...packet("123456789012"),
        sourceShipmentKey: null,
        carrierName: "Synthetic Courier Alpha",
      },
    ]);
    const created = await recordShipmentEvidence(ctx.db, original, ctx.actor);
    const code = created.shipmentIds[0]!;
    const [initial] = await getDb(ctx.db)
      .select()
      .from(shipment)
      .where(eq(shipment.shortcode, code));
    expect(initial?.carrierId).not.toBeNull();
    // A stored carrier guess needs no separate ownership classification.
    const wrongId = (
      await getDb(ctx.db)
        .select()
        .from(vendor)
        .where(eq(vendor.shortcode, wrong.output.id))
    )[0]!.id;
    const correctId = (
      await getDb(ctx.db)
        .select()
        .from(vendor)
        .where(eq(vendor.shortcode, correct.output.id))
    )[0]!.id;
    await setCarrierFixture(code, wrongId);
    const quote = "Synthetic Tracking Carrier tracking 123456789012";
    const proof = capture(
      "authority-proof",
      [
        {
          ...packet("123456789012"),
          carrierName: "Synthetic Beta Ground",
        },
      ],
      "2026-06-07T09:00:00Z",
      quote,
    );
    const corrected = await recordShipmentEvidence(ctx.db, proof, ctx.actor);
    expect(corrected.shipmentIds).toEqual([code]);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0],
    ).toMatchObject({
      carrierId: correctId,
      extraTrackingNumbers: [],
    });
    const observations = await getDb(ctx.db).select().from(shipmentObservation);
    const bindings = await getDb(ctx.db).select().from(shipmentSourcePackage);
    await recordShipmentEvidence(ctx.db, original, ctx.actor);
    expect(await getDb(ctx.db).select().from(shipmentSourcePackage)).toEqual(
      bindings,
    );
    expect(
      (await getDb(ctx.db).select().from(shipmentObservation))
        .map((row) => [row.id, row.fingerprint, row.occurrenceKey])
        .sort(),
    ).toEqual(
      observations
        .map((row) => [row.id, row.fingerprint, row.occurrenceKey])
        .sort(),
    );
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0],
    ).toMatchObject({ carrierId: correctId, extraTrackingNumbers: [] });
    const kernel = buildKernelContext(ctx.db, ctx.actor.userId);
    const automated = {
      ...kernel,
      actorContext: {
        ...kernel.actorContext,
        runId: parseEntityId("run", crypto.randomUUID()),
      },
    };
    await expect(
      executeEntity(automated, {
        action: "update",
        entity: "shipment",
        id: code,
        data: { carrierId: correct.output.id },
      }),
    ).rejects.toThrow(/interactive member/);
    await expect(
      executeEntity(
        {
          ...kernel,
          actorContext: { ...kernel.actorContext, channel: "system" },
        },
        {
          action: "update",
          entity: "shipment",
          id: code,
          data: { carrierId: correct.output.id },
        },
      ),
    ).rejects.toThrow(/interactive member/);
    await executeEntity(kernel, {
      action: "update",
      entity: "shipment",
      id: code,
      data: { purpose: "incoming" },
    });
    await executeEntity(buildKernelContext(ctx.db, ctx.actor.userId), {
      action: "update",
      entity: "shipment",
      id: code,
      data: { carrierId: correct.output.id },
    });
    await executeEntity(buildKernelContext(ctx.db, ctx.actor.userId), {
      action: "bulkUpdate",
      entity: "shipment",
      ids: [code],
      data: { carrierId: null, purpose: "outgoing" },
    });
    const refreshed = await recordShipmentEvidence(ctx.db, proof, ctx.actor);
    expect(refreshed.unresolvedPackages).toEqual([]);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0],
    ).toMatchObject({ carrierId: correctId, purpose: "outgoing" });
    expect(carrierFormatEvidence("123456789012")).toMatchObject({
      outcome: "ambiguous_match",
      carriers: ["UPS", "FedEx"],
    });
    expect(
      carrierFormatEvidence("123456789012", ["United Parcel Service"]),
    ).toMatchObject({ outcome: "documented_match", carriers: ["UPS"] });
    expect(
      carrierFormatEvidence("123456789012", ["Synthetic Courier Beta"]),
    ).toMatchObject({ outcome: "unsupported_format", carriers: [] });
  });

  it("corrects historical carrier values while holding source conflicts and identity collisions", async () => {
    await memberImportWorld(ctx.db, ctx.actor);
    const alpha = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Alpha Carrier",
    });
    const beta = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Beta Carrier",
    });
    const carriers = await getDb(ctx.db).select().from(vendor);
    const alphaId = carriers.find(
      (row) => row.shortcode === alpha.output.id,
    )!.id;
    const betaId = carriers.find((row) => row.shortcode === beta.output.id)!.id;
    const quote = "Synthetic Beta Carrier tracking EXAMPLE-PROOF";
    const claim = {
      trackingNumber: "EXAMPLE-PROOF",
      carrierName: "Synthetic Beta Carrier",
      role: "carrier",
      service: null,
      evidence: { kind: "statement", quote },
    } satisfies NonNullable<ShipmentEvidence["carrierClaims"]>[number];
    expect(
      retainedCarrierClaim(
        claim,
        "Synthetic Beta Carrier tracking EXAMPLE-PROOF-LONGER",
      ),
    ).toBe(false);
    expect(
      retainedCarrierClaim({ ...claim, role: "intermediary" }, quote),
    ).toBe(false);
    const unknown = await recordShipmentEvidence(
      ctx.db,
      capture("unknown-authority", [packet("EXAMPLE-PROOF")]),
      ctx.actor,
    );
    const code = unknown.shipmentIds[0]!;
    await getDb(ctx.db)
      .update(shipment)
      .set({ carrierId: alphaId })
      .where(eq(shipment.shortcode, code));
    const proof = capture(
      "unknown-proof",
      [{ ...packet("EXAMPLE-PROOF"), carrierClaims: [claim] }],
      "2026-06-07T09:00:00Z",
      quote,
    );
    expect(
      (await recordShipmentEvidence(ctx.db, proof, ctx.actor))
        .unresolvedPackages,
    ).toEqual([]);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0],
    ).toMatchObject({ carrierId: betaId });
    const findings = await getDb(ctx.db).select().from(runFinding);
    await recordShipmentEvidence(ctx.db, proof, ctx.actor);
    expect(await getDb(ctx.db).select().from(runFinding)).toEqual(findings);
    await setCarrierFixture(code, alphaId);
    const other = await recordShipmentEvidence(
      ctx.db,
      capture("collision-peer", [packet("EXAMPLE-PEER")]),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(shipment)
      .set({ carrierId: betaId, trackingNumber: "EXAMPLE-PROOF" })
      .where(eq(shipment.shortcode, other.shipmentIds[0]!));
    const collision = await recordShipmentEvidence(
      ctx.db,
      { ...proof, shipments: [{ ...proof.shipments[0]!, shipmentId: code }] },
      ctx.actor,
    );
    expect(collision.unresolvedPackages[0]?.reason).toMatch(/collid|Multiple/);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0]?.carrierId,
    ).toBe(alphaId);
    await expect(
      executeEntity(buildKernelContext(ctx.db, ctx.actor.userId), {
        action: "update",
        entity: "shipment",
        id: code,
        data: { carrierId: beta.output.id, purpose: "outgoing" },
      }),
    ).rejects.toMatchObject({
      cause: {
        message: expect.stringMatching(/Shipment tracking identity conflicts/),
      },
    });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0],
    ).toMatchObject({ carrierId: alphaId, purpose: "incoming" });
    const fieldQuote =
      "Carrier: Synthetic Alpha Carrier tracking EXAMPLE-FIELD";
    expect(
      (
        await assessCarrierPacket(
          ctx.db,
          { trackingNumber: "EXAMPLE-FIELD", extraTrackingNumbers: [] },
          { texts: [fieldQuote], links: [] },
        )
      ).primary.carrier?.code,
    ).toBe(alpha.output.id);
    const conflictQuote = "Synthetic Alpha Carrier tracking EXAMPLE-CONFLICT";
    const conflicting = capture(
      "conflicting-explicit",
      [
        {
          ...packet("EXAMPLE-CONFLICT"),
          carrierClaims: [
            {
              ...claim,
              trackingNumber: "EXAMPLE-CONFLICT",
              carrierName: "Synthetic Alpha Carrier",
              evidence: { kind: "label", quote: conflictQuote },
            },
            {
              ...claim,
              trackingNumber: "EXAMPLE-CONFLICT",
              evidence: {
                kind: "statement",
                quote:
                  "Carrier: Synthetic Beta Carrier tracking EXAMPLE-CONFLICT",
              },
            },
          ],
        },
        {
          ...packet("EXAMPLE-OLDER-PACKAGE"),
          observations: packet("EXAMPLE-OLDER-PACKAGE").observations.map(
            (event) => ({
              ...event,
              time: { kind: "instant", value: "2025-06-03T09:00:00Z" },
            }),
          ),
        },
      ],
      "2026-06-07T09:00:00Z",
      conflictQuote +
        "\nCarrier: Synthetic Beta Carrier tracking EXAMPLE-CONFLICT",
    );
    const held = await recordShipmentEvidence(ctx.db, conflicting, ctx.actor);
    expect(held.shipmentIds).toHaveLength(1);
    expect(held.unresolvedPackages).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(shipment)).toHaveLength(3);
    const laterSingleClaim = await recordShipmentEvidence(
      ctx.db,
      capture(
        "conflict-followup",
        [
          {
            ...conflicting.shipments[0]!,
            carrierClaims: [conflicting.shipments[0]!.carrierClaims![0]!],
          },
        ],
        "2026-06-08T09:00:00Z",
        conflictQuote,
      ),
      ctx.actor,
    );
    expect(laterSingleClaim.shipmentIds).toEqual([]);
    expect(laterSingleClaim.unresolvedPackages).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(shipment)).toHaveLength(3);
    const constructed = capture(
      "constructed",
      [packet("EXAMPLE-URL")],
      "2026-06-07T09:00:00Z",
      "Synthetic URL-only evidence",
    );
    constructed.source = {
      ...constructed.source,
      kind: "tracking_page",
      url: "https://www.fedex.com/fedextrack/?trknbr=EXAMPLE-URL",
      externalKey: "constructed",
      capturedAt: "2026-06-07T09:00:00Z",
      content: "Synthetic URL-only evidence",
    };
    const urlResult = await recordShipmentEvidence(
      ctx.db,
      constructed,
      ctx.actor,
    );
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, urlResult.shipmentIds[0]!))
      )[0]?.carrierId,
    ).toBeNull();
  });

  it("review regression: co-occurrence, negation and URL-only text cannot prove carrier attribution", () => {
    const number = "123456789012";
    for (const quote of [
      `We do not ship via UPS. Tracking: ${number}.`,
      `https://www.ups.com/track?tracking=${number}`,
      `Merchant UPS; another carrier handles tracking ${number}.`,
      `UPS appears on this page. Tracking: ${number}.`,
      `Maybe UPS tracking ${number}.`,
      `If UPS tracking ${number} is correct, use that carrier.`,
    ])
      expect(
        retainedCarrierClaim(carrierClaim(number, "UPS", quote), quote),
      ).toBe(false);
    expect(
      retainedCarrierClaim(
        carrierClaim(number, "UPS", `UPS tracking ${number}`),
        `We do not ship via UPS tracking ${number}.`,
      ),
    ).toBe(false);
    expect(
      retainedCarrierClaim(
        carrierClaim(number, "UPS", `UPS tracking ${number}`),
        `Maybe UPS tracking ${number}.`,
      ),
    ).toBe(false);
    const label = `Carrier: UPS\nTracking number: ${number}`;
    expect(
      retainedCarrierClaim(carrierClaim(number, "UPS", label), label),
    ).toBe(true);
  });

  it("review regression: source layout above a tracking label is not a carrier claim", async () => {
    const number = "EXAMPLE-LAYOUT";
    for (const line of [
      "Sun, Jul 21",
      "Hi Example, your order is being shipped!",
      "Estimated delivery: Fri. Jul. 20 - Fri. Jul. 27",
      "Tracking info should be available within 1-2 days",
    ]) {
      const { explicit } = await assessCarrierPacket(
        ctx.db,
        { trackingNumber: number, extraTrackingNumbers: [] },
        { texts: [`${line}\nTracking ID:\n${number}`], links: [] },
      );
      expect(explicit).toEqual([]);
    }
    for (const name of [
      "Synthetic Unknown Carrier",
      "Synthetic Carrier (Ground)",
      "Synthetic Alpha/Beta",
      "Synthetic Carrier 2",
    ]) {
      const { explicit } = await assessCarrierPacket(
        ctx.db,
        { trackingNumber: number, extraTrackingNumbers: [] },
        { texts: [`Carrier: ${name}\nTracking ID: ${number}`], links: [] },
      );
      expect(new Set(explicit.map(({ claim }) => claim.carrierName))).toEqual(
        new Set([name]),
      );
    }
  });

  it("resolves an additional-only identity from explicit source evidence", async () => {
    await createRepoIdentity(ctx, "vendor", { name: "Synthetic Beta Carrier" });
    const number = "EXAMPLE-LEGACY-EXTRA";
    const initial = await recordShipmentEvidence(
      ctx.db,
      capture("legacy-extra", [packet(number)]),
      ctx.actor,
    );
    const code = initial.shipmentIds[0]!;
    await getDb(ctx.db)
      .update(shipment)
      .set({
        trackingNumber: null,
        carrierId: null,
        extraTrackingNumbers: [
          { trackingNumber: number, carrierId: null, carrierName: null },
        ],
      })
      .where(eq(shipment.shortcode, code));
    const claim = carrierClaim(number, "Synthetic Beta Carrier");
    const result = await recordShipmentEvidence(
      ctx.db,
      capture(
        "legacy-extra-proof",
        [{ ...packet(number), carrierClaims: [claim] }],
        "2026-06-07T09:00:00Z",
        claim.evidence.kind === "statement" || claim.evidence.kind === "label"
          ? claim.evidence.quote
          : "",
      ),
      ctx.actor,
    );
    expect(result.unresolvedPackages).toEqual([]);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0],
    ).toMatchObject({
      trackingNumber: number,
      carrierId: expect.any(String),
    });
  });

  it("review regression: conflicting additional carriers hold before unknown-reference matching", async () => {
    await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Alpha Carrier",
    });
    await createRepoIdentity(ctx, "vendor", { name: "Synthetic Beta Carrier" });
    const number = "EXAMPLE-SHARED-EXTRA";
    const alpha = carrierClaim(number, "Synthetic Alpha Carrier");
    const beta = carrierClaim(number, "Synthetic Beta Carrier");
    await recordShipmentEvidence(
      ctx.db,
      capture(
        "extra-established",
        [{ ...packet(number), carrierClaims: [alpha] }],
        "2026-06-06T09:00:00Z",
        `Synthetic Alpha Carrier tracking ${number}`,
      ),
      ctx.actor,
    );
    const result = await recordShipmentEvidence(
      ctx.db,
      capture(
        "extra-conflict",
        [
          {
            ...packet("EXAMPLE-NEW-PRIMARY"),
            extraTrackingNumbers: [
              { trackingNumber: number, carrierName: null, carrierId: null },
            ],
            carrierClaims: [alpha, beta],
          },
        ],
        "2026-06-07T09:00:00Z",
        `Synthetic Alpha Carrier tracking ${number}\nSynthetic Beta Carrier tracking ${number}`,
      ),
      ctx.actor,
    );
    expect(result.unresolvedPackages).toHaveLength(1);
    expect(result.shipmentIds).toEqual([]);
    expect(await getDb(ctx.db).select().from(shipmentObservation)).toHaveLength(
      1,
    );
  });

  it("review regression: unresolved explicit carrier claims conflict across captures", async () => {
    await memberImportWorld(ctx.db, ctx.actor);
    await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Alpha Carrier",
    });
    const number = "EXAMPLE-CROSS-CAPTURE";
    await recordShipmentEvidence(
      ctx.db,
      capture(
        "cross-established",
        [
          {
            ...packet(number),
            carrierClaims: [carrierClaim(number, "Synthetic Alpha Carrier")],
          },
        ],
        "2026-06-06T09:00:00Z",
        `Synthetic Alpha Carrier tracking ${number}`,
      ),
      ctx.actor,
    );
    const result = await recordShipmentEvidence(
      ctx.db,
      capture(
        "cross-unresolved",
        [
          {
            ...packet(number),
            carrierClaims: [
              carrierClaim(number, "Synthetic Unresolved Carrier"),
            ],
          },
        ],
        "2026-06-07T09:00:00Z",
        `Synthetic Unresolved Carrier tracking ${number}`,
      ),
      ctx.actor,
    );
    expect(result.unresolvedPackages).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(shipmentObservation)).toHaveLength(
      1,
    );
    expect(await getDb(ctx.db).select().from(runFinding)).toHaveLength(1);
  });

  it("review regression: alias replay recovers package-level references when event numbers are absent", async () => {
    const original = packet("EXAMPLE-ALIAS-REPLAY");
    original.sourceShipmentKey = null;
    original.observations = original.observations.map((event) => ({
      ...event,
      trackingNumber: null,
    }));
    const input = capture("alias-without-event-number", [original]);
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const replay = await recordShipmentEvidence(
      ctx.db,
      {
        ...input,
        shipments: [
          { ...original, carrierName: "Synthetic Parcel Service Alias" },
        ],
      },
      ctx.actor,
    );
    expect(replay.shipmentIds).toEqual(first.shipmentIds);
    expect(
      await getDb(ctx.db).select().from(shipmentSourcePackage),
    ).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(shipmentObservation)).toHaveLength(
      1,
    );
  });

  it("uses exact carrier tracking links only from the independently retained Email original", async () => {
    const world = await memberImportWorld(ctx.db, ctx.actor);
    const fedex = await createRepoIdentity(ctx, "vendor", { name: "FedEx" });
    await createRepoIdentity(ctx, "vendor", { name: "UPS" });
    const number = "EXAMPLE-LINK";
    const href = `https://www.fedex.com/apps/fedextrack/?action=track&tracknumbers=${number}&cntry_code=us`;
    const originalContent = {
      snippet: null,
      bodyText: null,
      bodyHtml: `<p>Synthetic parcel</p><a href="${href.replaceAll("&", "&amp;")}">Track parcel</a>`,
    };
    await retainedMailFixture(ctx.db, {
      ledgerPartyId: world.party.id,
      messageId: "synthetic-carrier-link",
      checksum: "d".repeat(64),
      content: originalContent,
    });
    const [message] = await getDb(ctx.db)
      .select()
      .from(email)
      .where(eq(email.messageId, "synthetic-carrier-link"));
    const source = {
      kind: "email",
      emailId: parseShortcodeFor("email", message!.shortcode),
      checksum: "d".repeat(64),
    } satisfies RecordShipmentEvidenceInput["source"];
    const parcel = {
      ...packet(number),
      carrierClaims: [
        { ...carrierClaim(number, "FedEx"), evidence: { kind: "link", href } },
      ],
    } satisfies ShipmentEvidence;
    const recorded = await recordShipmentEvidence(
      ctx.db,
      { source, purchaseId: null, shipments: [parcel] },
      ctx.actor,
    );
    const [stored] = await getDb(ctx.db)
      .select()
      .from(shipment)
      .where(eq(shipment.shortcode, recorded.shipmentIds[0]!));
    const [identity] = await getDb(ctx.db)
      .select()
      .from(vendor)
      .where(eq(vendor.id, stored!.carrierId!));
    expect(identity?.shortcode).toBe(fedex.output.id);
    const independent = carrierCaptureEvidence({ source, originalContent });
    for (const invalid of [
      `https://www.fedex.com.evil.example/apps/fedextrack/?tracknumbers=${number}`,
      `https://www.fedex.com/apps/fedextrack/?tracknumbers=${number}&tracknumbers=EXAMPLE-OTHER`,
      `https://www.fedex.com/apps/fedextrack/?tracknumbers=EXAMPLE-OTHER`,
      `https://tracking.example/redirect?target=${encodeURIComponent(href)}`,
    ]) {
      const result = await assessCarrierPacket(
        ctx.db,
        {
          ...parcel,
          carrierClaims: [
            {
              ...carrierClaim(number, "FedEx"),
              evidence: { kind: "link", href: invalid },
            },
          ],
        },
        { texts: [], links: [{ href: invalid, text: "Track" }] },
      );
      expect(result.primary.carrier).toBeNull();
    }
    expect(
      (await assessCarrierPacket(ctx.db, parcel, { texts: [href], links: [] }))
        .primary.carrier,
    ).toBeNull();
    expect(
      (
        await assessCarrierPacket(
          ctx.db,
          {
            ...parcel,
            carrierClaims: [
              {
                ...carrierClaim(number, "UPS"),
                evidence: { kind: "link", href },
              },
            ],
          },
          independent,
        )
      ).primary.carrier?.code,
    ).toBe(fedex.output.id);
    const heldNumber = "EXAMPLE-HTML-HELD";
    const heldFedex = `https://www.fedex.com/fedextrack/?trknbr=${heldNumber}`;
    const heldUps = `https://www.ups.com/track?tracknum=${heldNumber}`;
    await retainedMailFixture(ctx.db, {
      ledgerPartyId: world.party.id,
      messageId: "synthetic-held-html-links",
      checksum: "e".repeat(64),
      content: {
        snippet: null,
        bodyText: null,
        bodyHtml: `<a href="${heldFedex}">Track parcel</a><a href="${heldUps}">Track parcel</a>`,
      },
    });
    const [heldMessage] = await getDb(ctx.db)
      .select()
      .from(email)
      .where(eq(email.messageId, "synthetic-held-html-links"));
    const held = await recordShipmentEvidence(
      ctx.db,
      {
        source: {
          kind: "email",
          emailId: parseShortcodeFor("email", heldMessage!.shortcode),
          checksum: "e".repeat(64),
        },
        purchaseId: null,
        shipments: [packet(heldNumber)],
      },
      ctx.actor,
    );
    expect(held.shipmentIds).toEqual([]);
    expect(held.unresolvedPackages).toHaveLength(1);
    const followup = await recordShipmentEvidence(
      ctx.db,
      capture(
        "html-conflict-followup",
        [packet(heldNumber)],
        "2026-06-07T09:00:00Z",
        `FedEx tracking ${heldNumber}`,
      ),
      ctx.actor,
    );
    expect(followup.shipmentIds).toEqual([]);
    expect(followup.unresolvedPackages).toHaveLength(1);
    const fabricatedPage = capture("constructed-link", [parcel]);
    expect(
      (
        await assessCarrierPacket(
          ctx.db,
          parcel,
          carrierCaptureEvidence({
            source: fabricatedPage.source,
            originalContent: null,
          }),
        )
      ).primary.carrier,
    ).toBeNull();
  });

  it("reads and sorts one retained summary revision until new evidence is published", async () => {
    const first = await recordShipmentEvidence(
      ctx.db,
      capture("stored-summary-one"),
      ctx.actor,
    );
    const code = first.shipmentIds[0];
    if (!code) throw new Error("Synthetic Shipment missing");
    const kernel = buildKernelContext(ctx.db, ctx.actor.userId);
    const read = () =>
      executeEntity(kernel, {
        action: "get",
        entity: "shipment",
        id: code,
        missing: "error",
      });
    expect(await read()).toMatchObject({
      item: {
        fields: {
          eventCount: { result: { kind: "missing" } },
        },
      },
    });
    await drainStoredDerived(ctx.db);
    expect(await read()).toMatchObject({
      item: {
        fields: {
          eventCount: {
            result: {
              kind: "cached",
              decision: { outcome: { kind: "value", value: 1 } },
            },
          },
          firstEventDate: {
            result: {
              kind: "cached",
              decision: { outcome: { value: "2026-06-03" } },
            },
          },
        },
      },
    });

    const parcel = packet();
    parcel.shipmentId = code;
    const observed = parcel.observations[0];
    if (!observed) throw new Error("Synthetic observation missing");
    parcel.observations.push({
      ...observed,
      sourceEventKey: "scan-two",
      kind: "delivered",
      time: { kind: "instant", value: "2026-06-04T09:00:00Z" },
    });
    await recordShipmentEvidence(
      ctx.db,
      capture("stored-summary-two", [parcel]),
      ctx.actor,
    );
    expect(await read()).toMatchObject({
      item: {
        fields: {
          eventCount: {
            result: {
              kind: "cached",
              freshness: "fresh",
              decision: { outcome: { value: 1 } },
            },
          },
        },
      },
    });
    await drainStoredDerived(ctx.db);
    const listed = await executeEntity(kernel, {
      action: "list",
      entity: "shipment",
      filters: {},
      sort: [{ orderBy: "eventCount", direction: "desc" }],
      pagination: { pageIndex: 0, pageSize: 25 },
    });
    expect(listed).toMatchObject({
      items: [
        {
          id: code,
          fields: {
            eventCount: {
              result: {
                kind: "cached",
                freshness: "fresh",
                decision: { outcome: { value: 2 } },
              },
            },
            lastEventDate: {
              result: { decision: { outcome: { value: "2026-06-04" } } },
            },
            eventSpanHours: {
              result: { decision: { outcome: { value: 24 } } },
            },
          },
        },
      ],
    });
  });

  it("labels notification dates and keeps forecasts out of completed delivery", async () => {
    const parcel = packet();
    const scan = parcel.observations[0]!;
    parcel.observations = [
      {
        ...scan,
        time: { kind: "date", value: "2026-06-03" },
        timeBasis: "notification_received",
      },
      {
        ...scan,
        sourceEventKey: "forecast",
        kind: "delivered",
        timeBasis: "estimate",
        rawStatus: "Expected delivery June 7",
        time: { kind: "date", value: "2026-06-07" },
      },
    ];
    await expect(
      recordShipmentEvidence(ctx.db, capture("forecast", [parcel]), ctx.actor),
    ).rejects.toThrow(/source notification/);
    const result = await recordShipmentEvidence(
      ctx.db,
      {
        ...capture("forecast", [parcel]),
        source: {
          kind: "sms_export",
          externalKey: "forecast",
          fileName: "synthetic-messages.txt",
          sender: "Synthetic Carrier",
          sentAt: { kind: "instant", value: "2026-06-03T09:00:00Z" },
          capturedAt: "2026-06-06T09:00:00Z",
          content: "Synthetic pickup and delivery forecast",
        },
      },
      ctx.actor,
    );
    const code = result.shipmentIds[0]!;
    expect(
      (await readShipmentTimeline(ctx.db, code)).milestones.deliveredAt,
    ).toBeNull();
    const blocks = await shipmentTrackingReport(ctx.db, code);
    const rows = blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    expect(
      rows.some((row) =>
        row.lines?.some((line) => line.text === "Notification received"),
      ),
    ).toBe(true);
    expect(
      rows
        .filter((row) => row.title === "Expected delivery June 7")
        .every(
          (row) =>
            row.badges?.some((badge) => badge.label.startsWith("Estimated")) &&
            row.state?.kind !== "done",
        ),
    ).toBe(true);
  });

  it("replays historical untagged evidence without changing its fingerprint or reviewed correction", async () => {
    const parcel = packet();
    parcel.observations[0]!.sourceEventKey = null;
    const input = capture("historical-provenance", [parcel]);
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const code = first.shipmentIds[0]!;
    const original = (await readShipmentTimeline(ctx.db, code))
      .observations[0]!;
    const { timeBasis: _basis, ...literal } = parcel.observations[0]!;
    const fingerprint = await sha256Hex(
      canonicalJson(jsonSnapshot.parse(literal)),
    );
    const [stored] = await getDb(ctx.db)
      .select()
      .from(shipmentObservation)
      .where(eq(shipmentObservation.id, original.observationId));
    if (!stored) throw new Error("Synthetic observation missing");
    const { timeBasis: _storedBasis, ...historicalEvent } = stored.event;
    await getDb(ctx.db)
      .update(shipmentObservation)
      .set({
        event: historicalEvent,
        fingerprint,
        occurrenceKey: `content:${fingerprint}:0`,
      })
      .where(eq(shipmentObservation.id, original.observationId));
    await editShipmentObservation(
      ctx.db,
      {
        shipmentId: code,
        observationId: original.observationId,
        patch: { location: "Reviewed synthetic location" },
      },
      ctx.actor,
    );
    const replay = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(replay).toMatchObject({
      insertedObservations: 0,
      repeatedObservations: 1,
    });
    const rows = await getDb(ctx.db).select().from(shipmentObservation);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === original.observationId)).toMatchObject(
      { event: historicalEvent, fingerprint },
    );
    expect(
      (await readShipmentTimeline(ctx.db, code)).timeline[0]?.event.location,
    ).toBe("Reviewed synthetic location");
  });

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
      shipments: [{ ...packet(), purpose: "unknown" }],
    };
    const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    const replay = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(replay.shipmentIds).toEqual(first.shipmentIds);
    expect(replay.insertedObservations).toBe(0);
    const code = first.shipmentIds[0];
    if (!code) throw new Error("Synthetic Shipment missing");
    const kernel = buildKernelContext(ctx.db, ctx.actor.userId);
    expect(
      await executeEntity(kernel, {
        action: "get",
        entity: "shipment",
        id: code,
        missing: "error",
      }),
    ).toMatchObject({ item: { purpose: "incoming" } });
    await executeEntity(kernel, {
      action: "bulkUpdate",
      entity: "shipment",
      ids: [code],
      data: { purpose: "outgoing" },
    });
    await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(
      await executeEntity(kernel, {
        action: "get",
        entity: "shipment",
        id: code,
        missing: "error",
      }),
    ).toMatchObject({ item: { purpose: "outgoing" } });
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
        patch: {
          rawStatus: "Member verified pickup",
          location: null,
          time: { kind: "date", value: "2025-06-03" },
        },
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
    expect(report.timeline[0]?.event.time).toEqual({
      kind: "date",
      value: "2025-06-03",
    });
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
    const firstCarrier = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Parcel Carrier",
    });
    const secondCarrier = await createRepoIdentity(ctx, "vendor", {
      name: "Other synthetic carrier",
    });
    const identities = await getDb(ctx.db).select().from(vendor);
    await getDb(ctx.db)
      .update(shipment)
      .set({
        carrierId: identities.find(
          (row) => row.shortcode === firstCarrier.output.id,
        )!.id,
      })
      .where(eq(shipment.shortcode, first.shipmentIds[0]!));
    const collision = packet("EXAMPLE-COLLISION");
    collision.carrierName = "Other synthetic carrier";
    collision.observations[0]!.carrierName = collision.carrierName;
    const other = await recordShipmentEvidence(
      ctx.db,
      capture("carrier-collision", [collision]),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(shipment)
      .set({
        trackingNumber: "EXAMPLE-123",
        carrierId: identities.find(
          (row) => row.shortcode === secondCarrier.output.id,
        )!.id,
      })
      .where(eq(shipment.shortcode, other.shipmentIds[0]!));
    const boundReplay = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(boundReplay.shipmentIds).toEqual(first.shipmentIds);
    expect(boundReplay.unresolvedPackages).toEqual([]);
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
      capture("another-order", [
        {
          ...packet(),
          observations: packet().observations.map((event) => ({
            ...event,
            time: { kind: "date", value: "2026-09-03" },
          })),
        },
      ]),
      ctx.actor,
    );
    expect(first.shipmentIds).toHaveLength(2);
    expect(unrelated.shipmentIds[0]).not.toBe(first.shipmentIds[0]);
    expect(await getDb(ctx.db).select().from(shipment)).toHaveLength(3);
  });

  it("combines nearby tracking evidence without a Purchase or known carrier", async () => {
    const firstPacket = packet(" example-123 ");
    firstPacket.carrierName = null;
    firstPacket.observations[0]!.carrierName = null;
    const first = await recordShipmentEvidence(
      ctx.db,
      capture("first-source", [firstPacket]),
      ctx.actor,
    );
    const nextPacket = packet();
    const next = await recordShipmentEvidence(
      ctx.db,
      capture("next-source", [nextPacket]),
      ctx.actor,
    );
    expect(next.shipmentIds).toEqual(first.shipmentIds);
    expect(
      (await readShipmentTimeline(ctx.db, first.shipmentIds[0]!)).observations,
    ).toHaveLength(2);
  });

  it("combines sources with a supported Purchase/carrier/tracking identity", async () => {
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

  it("matches additional references at the 60-day boundary without bridging later periods", async () => {
    const first = await recordShipmentEvidence(
      ctx.db,
      capture("period-start"),
      ctx.actor,
    );
    const handoff = packet("EXAMPLE-HANDOFF");
    handoff.extraTrackingNumbers = [
      { carrierId: null, carrierName: null, trackingNumber: " example-123 " },
    ];
    handoff.observations[0]!.time = { kind: "date", value: "2026-08-02" };
    const last = await recordShipmentEvidence(
      ctx.db,
      capture("period-end", [handoff]),
      ctx.actor,
    );
    expect(last.shipmentIds).toEqual(first.shipmentIds);
    const bridge = packet();
    bridge.observations[0]!.time = { kind: "date", value: "2026-08-03" };
    const held = await recordShipmentEvidence(
      ctx.db,
      capture("period-bridge", [bridge]),
      ctx.actor,
    );
    expect(held.shipmentIds).toEqual([]);
    expect(held.unresolvedPackages).toHaveLength(1);
    const reused = packet();
    reused.observations[0]!.time = { kind: "date", value: "2026-10-05" };
    const next = await recordShipmentEvidence(
      ctx.db,
      capture("recycled-period", [reused]),
      ctx.actor,
    );
    expect(next.shipmentIds).toHaveLength(1);
    expect(next.shipmentIds[0]).not.toBe(first.shipmentIds[0]);
    expect(
      (await readShipmentTimeline(ctx.db, first.shipmentIds[0]!)).observations,
    ).toHaveLength(2);
  });

  it("enforces tracking uniqueness for concurrent direct writers, including snapshot transactions", async () => {
    await recordShipmentEvidence(
      ctx.db,
      capture("race-seed", [packet("EXAMPLE-SEED")]),
      ctx.actor,
    );
    const [original] = await getDb(ctx.db).select().from(shipmentObservation);
    if (!original) throw new Error("Synthetic race evidence missing");
    const attempt = (key: string) =>
      withTransactionDatabase(
        ctx.db,
        async (tdb) => {
          const created = await insertWithShortcode(tdb, "shipment", {
            name: "Synthetic concurrent package",
            trackingNumber: " example-race ",
          });
          const [binding] = await getDb(tdb)
            .insert(shipmentSourcePackage)
            .values({
              shipmentId: created.id,
              sourceKey: original.sourceKey,
              packageKey: key,
            })
            .returning();
          if (!binding) throw new Error("Synthetic race binding missing");
          await getDb(tdb)
            .insert(shipmentObservation)
            .values({
              ...original,
              id: undefined,
              shipmentId: created.id,
              sourcePackageId: binding.id,
              event: { ...original.event, trackingNumber: "EXAMPLE-RACE" },
            });
          return created.id;
        },
        { isolationLevel: "repeatable read" },
      );
    const results = await Promise.allSettled([
      attempt("race-a"),
      attempt("race-b"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const failure = results.find((result) => result.status === "rejected");
    const databaseError = failure?.reason.cause ?? failure?.reason;
    expect(databaseError).toMatchObject({
      code: expect.stringMatching(/^(23505|40001)$/),
    });
    await expect(attempt("race-after-commit")).rejects.toMatchObject({
      cause: {
        constraint: "Shipment_tracking_period_unique",
      },
    });
    const stored = await getDb(ctx.db)
      .select()
      .from(shipment)
      .where(eq(shipment.trackingNumber, " example-race "));
    expect(stored).toHaveLength(1);
  });

  it("retains handoff references and all observations through explicit merge", async () => {
    const internationalCarrier = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Parcel Carrier",
    });
    const postalCarrier = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Postal Carrier",
    });
    const primaryQuote = "Synthetic Parcel Carrier tracking EXAMPLE-123";
    const initialPacket = packet();
    initialPacket.carrierClaims = [
      {
        trackingNumber: "EXAMPLE-123",
        carrierName: "Synthetic Parcel Carrier",
        role: "carrier",
        service: null,
        evidence: { kind: "statement", quote: primaryQuote },
      },
    ];
    const first = await recordShipmentEvidence(
      ctx.db,
      capture(
        "international",
        [initialPacket],
        "2026-06-06T09:00:00Z",
        primaryQuote,
      ),
      ctx.actor,
    );
    const handoff = packet("EXAMPLE-LAST-MILE");
    handoff.carrierName = "Synthetic Postal Carrier";
    handoff.observations = handoff.observations.map((event) => ({
      ...event,
      carrierName: handoff.carrierName,
      kind: "delivered",
    }));
    const postalQuote = "Synthetic Postal Carrier tracking EXAMPLE-LAST-MILE";
    handoff.carrierClaims = [
      {
        trackingNumber: "EXAMPLE-LAST-MILE",
        carrierName: "Synthetic Postal Carrier",
        role: "carrier",
        service: null,
        evidence: { kind: "label", quote: postalQuote },
      },
    ];
    const last = await recordShipmentEvidence(
      ctx.db,
      capture("last-mile", [handoff], "2026-06-06T09:00:00Z", postalQuote),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(shipment)
      .set({
        notes: "Synthetic keeper note",
        extraTrackingNumbers: [
          { carrierId: null, carrierName: null, trackingNumber: "EXAMPLE-123" },
          {
            carrierId: null,
            carrierName: "Synthetic legacy carrier label",
            trackingNumber: "example-123",
          },
        ],
      })
      .where(eq(shipment.shortcode, first.shipmentIds[0]!));
    await getDb(ctx.db)
      .update(shipment)
      .set({ notes: "Synthetic donor note" })
      .where(eq(shipment.shortcode, last.shipmentIds[0]!));
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
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(vendor)
          .where(eq(vendor.id, survivor!.carrierId!))
      )[0]?.shortcode,
    ).toBe(internationalCarrier.output.id);
    expect(survivor?.extraTrackingNumbers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackingNumber: "EXAMPLE-LAST-MILE",
          carrierId: postalCarrier.output.id,
        }),
      ]),
    );
    expect(
      survivor?.extraTrackingNumbers.map((ref) => ref.trackingNumber),
    ).toEqual(["EXAMPLE-LAST-MILE"]);
    expect(survivor?.notes).toBe(
      "Synthetic keeper note\n\nSynthetic donor note",
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
      receivedAt: new Date("2026-09-21T01:00:00Z"),
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
    const scan = input.shipments[0]?.observations[0];
    if (!scan) throw new Error("Synthetic scan missing");
    scan.timeBasis = "notification_received";
    scan.time = { kind: "date", value: "2026-09-21" };
    await expect(
      recordShipmentEvidence(ctx.db, input, ctx.actor),
    ).rejects.toThrow(/Los Angeles calendar date/);
    expect(await getDb(ctx.db).select().from(shipment)).toEqual([]);
    scan.timeBasis = "estimate";
    scan.time = { kind: "date", value: "2026-09-23" };
    const result = await recordShipmentEvidence(ctx.db, input, ctx.actor);
    expect(result.shipmentIds).toHaveLength(1);
    const update = packet();
    update.observations[0]!.time = { kind: "date", value: "2026-09-20" };
    expect(
      (
        await recordShipmentEvidence(
          ctx.db,
          capture("notification-identity", [update]),
          ctx.actor,
        )
      ).shipmentIds,
    ).toEqual(result.shipmentIds);
    const shipmentId = result.shipmentIds[0];
    if (!shipmentId) throw new Error("Synthetic Shipment missing");
    const source = {
      entityKind: "email",
      entityId: message.shortcode,
    } as const;
    const connected = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "entity:shipment",
    });
    expect(connected.items.map((item) => item.target.entityId)).toEqual([
      shipmentId,
    ]);
    expect(connected.items[0]?.paths[0]?.at(-1)?.via?.label).toBe(
      "Tracking evidence",
    );
    const reverse = await getConnectedRecords(ctx.db, {
      source: { entityKind: "shipment", entityId: shipmentId },
      viewKey: "entity:email",
    });
    expect(reverse.items.map((item) => item.target.entityId)).toEqual([
      message.shortcode,
    ]);
    const graph = await getEntityGraph(ctx.db, {
      roots: [source],
      entityKinds: ["shipment"],
    });
    expect(
      graph.edges.some((edge) => edge.relationshipKey === "tracking-emails"),
    ).toBe(true);
    const otherMember = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic other member",
      kind: "member",
    });
    const seller = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic other seller",
    });
    await expect(
      recordShipmentEvidence(
        ctx.db,
        {
          ...input,
          shipments: input.shipments.map((parcel) => ({
            ...parcel,
            carrierId: parseShortcodeFor("vendor", seller.output.id),
          })),
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/Carrier reference and literal carrier name disagree/);
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
      {
        ...packet(),
        carrierId: carrier.output.id,
        carrierName: "Synthetic old carrier",
        sourceShipmentKey: null,
        observations: packet().observations.map((event) => ({
          ...event,
          carrierName: "Synthetic old carrier",
        })),
      },
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

  it("does not let free-text package claims bypass tracking identity", async () => {
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
    expect(result.shipmentIds).toHaveLength(1);
    expect(result.unresolvedPackages).toHaveLength(1);
    expect(
      await getDb(ctx.db).select().from(shipmentSourceCapture),
    ).toHaveLength(1);
  });

  it("retains A to B to A revisions without resurrecting old replays", async () => {
    const original = packet();
    const changed = {
      ...packet(),
      observations: packet().observations.map(
        (event): ShipmentEvidence["observations"][number] => ({
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
    const occurrence: ShipmentEvidence["observations"][number] = {
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

  it("revises a re-read keyless occurrence without inventing or collapsing same-day events", async () => {
    await createRepoIdentity(ctx, "vendor", { name: "ZQX" });
    const event = (
      rawStatus: string,
      overrides: Partial<ShipmentEvidence["observations"][number]> = {},
    ): ShipmentEvidence["observations"][number] => ({
      ...packet().observations[0]!,
      sourceEventKey: null,
      time: { kind: "date", value: "2026-06-03" },
      timeBasis: "stated_event",
      carrierName: null,
      rawStatus,
      ...overrides,
    });
    const reRead = (
      number: string,
      observations: ShipmentEvidence["observations"],
      hint: string | null = null,
    ): ShipmentEvidence => ({
      ...packet(number),
      sourceShipmentKey: null,
      carrierName: hint,
      observations,
    });
    const current = async (code: string) =>
      (await readShipmentTimeline(ctx.db, code)).observations.filter(
        (row) => !row.superseded,
      );

    // An extraction drops a false hint from the same source: one occurrence, two versions.
    const hinted = "EXAMPLE-REREAD-HINT";
    const text = `Tracking ID: ${hinted}\nDelivery: ZQX\nSynthetic item`;
    const original = event("Synthetic pickup", { carrierName: "ZQX" });
    const first = await recordShipmentEvidence(
      ctx.db,
      capture("reread", [reRead(hinted, [original], "ZQX")], undefined, text),
      ctx.actor,
    );
    const code = first.shipmentIds[0]!;
    const [stored] = await getDb(ctx.db)
      .select()
      .from(shipmentObservation)
      .where(
        eq(shipmentObservation.id, (await current(code))[0]!.observationId),
      );
    const corrected = capture(
      "reread",
      [reRead(hinted, [event("Synthetic pickup")])],
      "2026-06-06T10:00:00Z",
      text,
    );
    const revision = await recordShipmentEvidence(ctx.db, corrected, ctx.actor);
    expect(revision).toMatchObject({
      shipmentIds: [code],
      insertedObservations: 1,
      repeatedObservations: 0,
    });
    const [row] = await current(code);
    expect(await current(code)).toHaveLength(1);
    expect(row?.carrierName).toBeNull();
    expect((await readShipmentTimeline(ctx.db, code)).timeline).toHaveLength(1);
    // The original identity and fingerprint stay retained under the same occurrence.
    const versions = await getDb(ctx.db)
      .select()
      .from(shipmentObservation)
      .where(eq(shipmentObservation.sourcePackageId, stored!.sourcePackageId));
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((v) => v.occurrenceKey))).toEqual(
      new Set([stored!.occurrenceKey]),
    );
    expect(versions.find((v) => v.id === stored!.id)).toMatchObject({
      fingerprint: stored!.fingerprint,
      supersededById: row?.observationId,
    });
    // Replaying the corrected extraction repeats it.
    expect(
      await recordShipmentEvidence(ctx.db, corrected, ctx.actor),
    ).toMatchObject({ insertedObservations: 0, repeatedObservations: 1 });
    expect(await current(code)).toHaveLength(1);

    // Changed wording re-read from one source, including at the same capture time.
    const worded = "EXAMPLE-REREAD-WORDING";
    const wordedInput = (rawStatus: string) =>
      capture("reread-wording", [reRead(worded, [event(rawStatus)])]);
    const wordedCode = (
      await recordShipmentEvidence(
        ctx.db,
        wordedInput("Picked up by carrier"),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    await recordShipmentEvidence(
      ctx.db,
      wordedInput("Carrier picked up the parcel"),
      ctx.actor,
    );
    expect(await current(wordedCode)).toMatchObject([
      { rawStatus: "Carrier picked up the parcel" },
    ]);

    // A later snapshot is new source content: its wording cannot prove the same event.
    const snapshot = "EXAMPLE-REREAD-SNAPSHOT";
    const snapshotCode = (
      await recordShipmentEvidence(
        ctx.db,
        capture("reread-snapshot", [reRead(snapshot, [event("Arrived")])]),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    await recordShipmentEvidence(
      ctx.db,
      capture(
        "reread-snapshot",
        [reRead(snapshot, [event("Departed")])],
        "2026-06-06T10:00:00Z",
        "Synthetic later snapshot",
      ),
      ctx.actor,
    );
    expect(await current(snapshotCode)).toHaveLength(2);

    // A newly read second event stays distinct; its sibling repeats unchanged.
    const added = "EXAMPLE-REREAD-ADDED";
    const addedCode = (
      await recordShipmentEvidence(
        ctx.db,
        capture("reread-added", [reRead(added, [event("Arrived")])]),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    await recordShipmentEvidence(
      ctx.db,
      capture("reread-added", [
        reRead(added, [event("Arrived"), event("Departed")]),
      ]),
      ctx.actor,
    );
    expect(await current(addedCode)).toHaveLength(2);

    // Carrier-only changes pair each event; rewording two same-day events is ambiguous.
    const pair = "EXAMPLE-REREAD-PAIR";
    const pairCode = (
      await recordShipmentEvidence(
        ctx.db,
        capture("reread-pair", [
          reRead(pair, [
            event("Arrived", { carrierName: "ZQX" }),
            event("Departed", { carrierName: "ZQX" }),
          ]),
        ]),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    await recordShipmentEvidence(
      ctx.db,
      capture("reread-pair", [
        reRead(pair, [event("Arrived"), event("Departed")]),
      ]),
      ctx.actor,
    );
    expect(await current(pairCode)).toHaveLength(2);
    await recordShipmentEvidence(
      ctx.db,
      capture("reread-pair", [
        reRead(pair, [event("Reached hub"), event("Left hub")]),
      ]),
      ctx.actor,
    );
    expect(await current(pairCode)).toHaveLength(4);

    // Different places or a forecast are not this event, whatever their day and kind.
    for (const [suffix, changed] of [
      ["PLACE", { location: "Synthetic other depot" }],
      ["FORECAST", { timeBasis: "estimate" }],
    ] as const) {
      const number = `EXAMPLE-REREAD-${suffix}`;
      // A stated event keeps the packet admissible beside a forecast.
      const stated = event("Label created", {
        time: { kind: "date", value: "2026-06-02" },
      });
      const distinct = (
        await recordShipmentEvidence(
          ctx.db,
          capture(`reread-${suffix}`, [
            reRead(number, [
              stated,
              event("Arrived", { location: "Synthetic depot" }),
            ]),
          ]),
          ctx.actor,
        )
      ).shipmentIds[0]!;
      await recordShipmentEvidence(
        ctx.db,
        capture(`reread-${suffix}`, [
          reRead(number, [
            stated,
            event("Arrived soon", { location: "Synthetic depot", ...changed }),
          ]),
        ]),
        ctx.actor,
      );
      expect(await current(distinct)).toHaveLength(3);
    }

    // A member's reviewed revision stays current; the re-read is retained behind it.
    const reviewed = "EXAMPLE-REREAD-REVIEWED";
    const reviewedCode = (
      await recordShipmentEvidence(
        ctx.db,
        capture("reread-reviewed", [reRead(reviewed, [event("Arrived")])]),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    const [source] = await current(reviewedCode);
    await editShipmentObservation(
      ctx.db,
      {
        shipmentId: reviewedCode,
        observationId: source!.observationId,
        patch: { rawStatus: "Reviewed synthetic arrival" },
      },
      ctx.actor,
    );
    const behindReview = capture(
      "reread-reviewed",
      [reRead(reviewed, [event("Arrival scanned")])],
      "2026-06-07T09:00:00Z",
    );
    await recordShipmentEvidence(ctx.db, behindReview, ctx.actor);
    expect(
      await recordShipmentEvidence(ctx.db, behindReview, ctx.actor),
    ).toMatchObject({ insertedObservations: 0, repeatedObservations: 1 });
    expect(await current(reviewedCode)).toMatchObject([
      { rawStatus: "Reviewed synthetic arrival", memberReviewed: true },
    ]);
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
    expect(report.observations[0]?.captureSources).toHaveLength(2);
    for (const capture of report.observations[0]?.captureSources ?? []) {
      expect(capture.source).not.toHaveProperty("content");
      expect(report.observations[0]?.captureIds).toContain(capture.captureId);
    }
    const captures = await getDb(ctx.db).select().from(shipmentSourceCapture);
    expect(
      captures.map((row) =>
        row.source.kind === "tracking_page" ? row.source.content : null,
      ),
    ).toContain("  Synthetic snapshot\n");
  });

  it("retires a template package without blocking sibling replay or recreating it", async () => {
    const parcel = packet("EXAMPLE-BOX-1");
    const template: ShipmentEvidence = {
      ...packet(),
      sourceShipmentKey: "Box #3",
      distinctPackageEvidence: "Synthetic notice lists an empty third box",
      carrierName: null,
      trackingNumber: null,
      observations: [
        {
          ...packet().observations[0]!,
          sourceEventKey: "box-3-shipped",
          kind: "vendor_shipped",
          carrierName: null,
          trackingNumber: null,
          rawStatus: "Box #3 has no shipping method or tracking number.",
        },
      ],
    };
    const source = capture("template-source", [parcel, template]);
    const first = await recordShipmentEvidence(ctx.db, source, ctx.actor);
    const [parcelCode, templateCode] = first.shipmentIds;
    const original = await readShipmentTimeline(ctx.db, templateCode!);
    const kernel = buildKernelContext(ctx.db, ctx.actor.userId);
    await expect(
      executeEntity(
        {
          ...kernel,
          actorContext: {
            ...kernel.actorContext,
            runId: parseEntityId("run", crypto.randomUUID()),
          },
        },
        { action: "delete", entity: "shipment", ids: [templateCode!] },
      ),
    ).rejects.toThrow(/interactive member/);
    await executeEntity(kernel, {
      action: "delete",
      entity: "shipment",
      ids: [templateCode!],
    });

    const respelled: ShipmentEvidence = {
      ...template,
      sourceShipmentKey: "box-3",
    };
    const renamed: ShipmentEvidence = {
      ...template,
      sourceShipmentKey: "third-parcel",
    };
    for (const shipments of [
      [parcel, template],
      [parcel, respelled],
      [parcel, renamed],
    ]) {
      const replay = await recordShipmentEvidence(
        ctx.db,
        { ...source, shipments },
        ctx.actor,
      );
      expect(replay.shipmentIds).toEqual([parcelCode]);
      expect(replay.insertedObservations).toBe(0);
      expect(replay.unresolvedPackages).toHaveLength(1);
    }
    // A tracked sibling first seen after the retirement still applies beside the hold.
    const admitted = await recordShipmentEvidence(
      ctx.db,
      { ...source, shipments: [parcel, renamed, packet("EXAMPLE-BOX-2")] },
      ctx.actor,
    );
    expect(admitted.shipmentIds).toHaveLength(2);
    expect(admitted.shipmentIds).toContain(parcelCode);
    expect(admitted.shipmentIds).not.toContain(templateCode);
    expect(admitted.insertedObservations).toBe(1);
    expect(admitted.unresolvedPackages).toHaveLength(1);
    const [retained] = await getDb(ctx.db)
      .select({ id: shipment.id, deletedAt: shipment.deletedAt })
      .from(shipment)
      .where(eq(shipment.shortcode, templateCode!));
    expect(retained?.deletedAt).not.toBeNull();
    const evidence = await getDb(ctx.db)
      .select({
        id: shipmentObservation.id,
        fingerprint: shipmentObservation.fingerprint,
        sourcePackageId: shipmentObservation.sourcePackageId,
      })
      .from(shipmentObservation)
      .where(eq(shipmentObservation.shipmentId, retained!.id));
    expect(evidence).toEqual(
      original.observations.map((observation) => ({
        id: observation.observationId,
        fingerprint: expect.any(String),
        sourcePackageId: observation.sourcePackageId,
      })),
    );
    // Only one source owns a respelling: the same label from another source stays distinct.
    const other = await recordShipmentEvidence(
      ctx.db,
      capture("another-order", [template]),
      ctx.actor,
    );
    expect(other.shipmentIds).toHaveLength(1);
    expect(other.shipmentIds).not.toContain(templateCode);
  });

  it("joins lifecycle sources only when retained links name the same parcel", async () => {
    const world = await memberImportWorld(ctx.db, ctx.actor);
    const tracker = (
      shipmentId: string,
      index = 0,
      order = "000-0000001-0000001",
    ) =>
      `https://www.amazon.com/progress-tracker/package?_encoding=UTF8&orderId=${order}&packageIndex=${index}&shipmentId=${shipmentId}`;
    const redirected = (href: string) =>
      `https://www.amazon.com/gp/r.html?C=SYNTHETIC&U=${encodeURIComponent(href)}&H=SYNTHETIC`;
    const key = (shipmentId: string, index = 0) =>
      `amazon:000-0000001-0000001:shipmentId=${shipmentId}:packageIndex=${index}`;
    const trackingless = (
      sourceShipmentKey: string,
      overrides: Partial<ShipmentEvidence> = {},
      value = "2026-06-03",
    ): ShipmentEvidence => ({
      ...packet(),
      sourceShipmentKey,
      distinctPackageEvidence: "Synthetic vendor notice for one package",
      carrierName: null,
      trackingNumber: null,
      observations: [
        {
          ...packet().observations[0]!,
          sourceEventKey: `${value}-delivered`,
          kind: "delivered",
          time: { kind: "date", value },
          carrierName: null,
          trackingNumber: null,
          rawStatus: "Synthetic delivered notice",
        },
      ],
      ...overrides,
    });
    let messages = 0;
    const mail = async (hrefs: readonly string[], bodyText: string | null) => {
      const messageId = `synthetic-lifecycle-${++messages}`;
      const checksum = await sha256Hex(messageId);
      await retainedMailFixture(ctx.db, {
        ledgerPartyId: world.party.id,
        messageId,
        checksum,
        content: {
          snippet: null,
          bodyText,
          bodyHtml: `<p>Synthetic parcel notice</p>${hrefs
            .map(
              (href) =>
                `<a href="${href.replaceAll("&", "&amp;")}">Track package</a>`,
            )
            .join("")}`,
        },
      });
      const [message] = await getDb(ctx.db)
        .select()
        .from(email)
        .where(eq(email.messageId, messageId));
      return {
        source: {
          kind: "email",
          emailId: parseShortcodeFor("email", message!.shortcode),
          checksum,
        },
        message: message!,
      } satisfies {
        source: RecordShipmentEvidenceInput["source"];
        message: typeof email.$inferSelect;
      };
    };
    const record = async (
      hrefs: readonly string[],
      parcel: ShipmentEvidence,
      siblings: ShipmentEvidence[] = [],
      bodyText: string | null = null,
    ) =>
      recordShipmentEvidence(
        ctx.db,
        {
          source: (await mail(hrefs, bodyText)).source,
          purchaseId: null,
          shipments: [parcel, ...siblings],
        },
        ctx.actor,
      );
    const notice = async (
      hrefs: readonly string[],
      parcel: ShipmentEvidence,
      bodyText: string | null = null,
    ) => (await record(hrefs, parcel, [], bodyText)).shipmentIds[0];

    const id = "Ab3dEf7Gh";
    const shipped = await notice(
      [redirected(tracker(id))],
      trackingless(key(id)),
    );
    // A grouped notice names its other parcel too; the respelled key selects this one.
    await expect(
      notice(
        [tracker(id), tracker(id, 1)],
        trackingless(
          `amazon:000-0000001-0000001:shipmentId:${id}:packageIndex:0`,
          {},
          "2026-06-05",
        ),
      ),
    ).resolves.toBe(shipped);
    // The same parcel after a separate shipping period is not this Shipment.
    const reused = await notice(
      [tracker(id)],
      trackingless(key(id), {}, "2026-10-03"),
    );
    expect(reused).not.toBe(shipped);
    // June's Shipment no longer fits, so it is no rival to October's.
    await expect(
      notice([tracker(id)], trackingless(key(id), {}, "2026-10-05")),
    ).resolves.toBe(reused);
    // A split parcel, a key naming a parcel its source does not link, and another order.
    await expect(
      notice([tracker(id, 1)], trackingless(key(id, 1))),
    ).resolves.not.toBe(shipped);
    await expect(
      notice([tracker(id, 1)], trackingless(key(id))),
    ).resolves.not.toBe(shipped);
    const orderless = `shipmentId=Zz9yXw8Vu:packageIndex=0`;
    const firstOrder = await notice(
      [tracker("Zz9yXw8Vu")],
      trackingless(orderless),
    );
    await expect(
      notice(
        [tracker("Zz9yXw8Vu", 0, "000-0000002-0000002")],
        trackingless(orderless),
      ),
    ).resolves.not.toBe(firstOrder);

    // Counters, labels and order ids stay separate however they are spelled, including
    // when both sources retain the same tracker link the key does not name.
    for (const [stored, incoming] of [
      ["Shipment 1", "Shipment1"],
      ["Package1", "Package 1"],
      ["Delivery2", "delivery-2"],
      ["Parcel12", "Parcel12"],
      ["W123456789", "W123456789"],
      ["ORD-ABC12345", "ORD-ABC12345"],
      ["Order#A1B2C3D4", "order a1b2c3d4"],
      ["Shipment from Example", "Shipment from Example"],
      ["10000001-Example", "10000001-Example"],
    ] as const) {
      for (const hrefs of [[], [tracker("Kn4pQr7St")]]) {
        const first = await notice(hrefs, trackingless(stored));
        await expect(notice(hrefs, trackingless(incoming))).resolves.not.toBe(
          first,
        );
      }
    }
    // A tracking page retains no independent link in either direction.
    const paged = (
      await recordShipmentEvidence(
        ctx.db,
        capture("page-package", [trackingless(key("Pg5hJk2Lm"))]),
        ctx.actor,
      )
    ).shipmentIds[0];
    await expect(
      notice([tracker("Pg5hJk2Lm")], trackingless(key("Pg5hJk2Lm"))),
    ).resolves.not.toBe(paged);
    const pageAfterMail = await recordShipmentEvidence(
      ctx.db,
      capture("mail-package", [trackingless(key(id))]),
      ctx.actor,
    );
    expect(pageAfterMail.shipmentIds).not.toContain(shipped);

    // An unknown direction can join; a disagreeing direction stays separate.
    const inbound = await notice(
      [tracker("Rt6vBn3Cx")],
      trackingless(key("Rt6vBn3Cx")),
    );
    await expect(
      notice(
        [tracker("Rt6vBn3Cx")],
        trackingless(key("Rt6vBn3Cx"), { purpose: "unknown" }),
      ),
    ).resolves.toBe(inbound);
    const outgoing = trackingless(key("Rt6vBn3Cx"), { purpose: "outgoing" });
    const outbound = await notice([tracker("Rt6vBn3Cx")], outgoing);
    expect(outbound).not.toBe(inbound);
    await expect(notice([tracker("Rt6vBn3Cx")], outgoing)).resolves.toBe(
      outbound,
    );
    // An unknown direction now fits both: hold it, and still apply the tracked sibling.
    const held = await record(
      [tracker("Rt6vBn3Cx")],
      trackingless(key("Rt6vBn3Cx"), { purpose: "unknown" }),
      [packet("EXAMPLE-UNKNOWN-DIRECTION-SIBLING")],
    );
    expect(held.shipmentIds).toHaveLength(1);
    expect(held.shipmentIds).not.toContain(inbound);
    expect(held.shipmentIds).not.toContain(outbound);
    expect(held.unresolvedPackages).toEqual([
      {
        sourceShipmentKey: key("Rt6vBn3Cx"),
        reason: expect.stringContaining("cannot prove which nearby Shipment"),
      },
    ]);
    const heldFindings = async () =>
      (await getDb(ctx.db).select().from(runFinding)).length;
    expect(await heldFindings()).toBe(1);

    // Another member's package is not a candidate, and never refuses the tracked sibling.
    const seller = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Package Seller",
    });
    const otherMember = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic other member",
      kind: "member",
    });
    const account = await createRepoIdentity(ctx, "vendorAccount", {
      vendorId: seller.output.id,
      ledgerPartyId: otherMember.output.id,
    });
    const foreignOrder = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller.output.id,
      vendorAccountId: account.output.id,
    });
    const householdOrder = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller.output.id,
    });
    const purchaseRow = async (shortcode: string) => {
      const [order] = await getDb(ctx.db)
        .select({ purchaseId: shipment.purchaseId })
        .from(shipment)
        .where(
          eq(shipment.shortcode, parseShortcodeFor("shipment", shortcode)),
        );
      return order!.purchaseId;
    };
    const unownedPackage = await notice(
      [tracker("Un8cMw4Dy")],
      trackingless(key("Un8cMw4Dy")),
    );
    await associateShipment(
      ctx.db,
      { shipmentId: unownedPackage, purchaseId: householdOrder.output.id },
      ctx.actor,
    );
    const householdPurchase = await purchaseRow(unownedPackage!);
    await expect(
      notice([tracker("Un8cMw4Dy")], trackingless(key("Un8cMw4Dy"))),
    ).resolves.toBe(unownedPackage);
    await expect(purchaseRow(unownedPackage!)).resolves.toBe(householdPurchase);
    // Another Purchase stays separate, and its Shipment then has no rival for that Purchase.
    const otherOrder = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller.output.id,
    });
    const underOtherOrder = async () =>
      recordShipmentEvidence(
        ctx.db,
        {
          source: (await mail([tracker("Un8cMw4Dy")], null)).source,
          purchaseId: otherOrder.output.id,
          shipments: [trackingless(key("Un8cMw4Dy"))],
        },
        ctx.actor,
      );
    const separateOrder = (await underOtherOrder()).shipmentIds[0];
    expect(separateOrder).not.toBe(unownedPackage);
    expect((await underOtherOrder()).shipmentIds).toEqual([separateOrder]);

    const foreignShipment = await notice(
      [tracker("Fg7xVb5Ez")],
      trackingless(key("Fg7xVb5Ez")),
    );
    const [foreignPurchase] = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.shortcode, foreignOrder.output.id));
    await getDb(ctx.db)
      .update(shipment)
      .set({ purchaseId: foreignPurchase!.id })
      .where(eq(shipment.shortcode, foreignShipment!));
    const sibling = packet("EXAMPLE-OWNERSHIP-SIBLING");
    const withSibling = await record(
      [tracker("Fg7xVb5Ez")],
      trackingless(key("Fg7xVb5Ez")),
      [sibling],
    );
    expect(withSibling.shipmentIds).toHaveLength(2);
    expect(withSibling.shipmentIds).not.toContain(foreignShipment);
    expect(withSibling.unresolvedPackages).toEqual([]);
    // The foreign Shipment is no rival to the member's own package for this parcel.
    await expect(
      notice([tracker("Fg7xVb5Ez")], trackingless(key("Fg7xVb5Ez"))),
    ).resolves.toBe(withSibling.shipmentIds[0]);

    const foreignSource = await mail([tracker("Hj2yNq6Gw")], null);
    const foreignSourced = (
      await recordShipmentEvidence(
        ctx.db,
        {
          source: foreignSource.source,
          purchaseId: null,
          shipments: [trackingless(key("Hj2yNq6Gw"))],
        },
        ctx.actor,
      )
    ).shipmentIds[0];
    const [otherParty] = await getDb(ctx.db)
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(eq(ledgerParty.shortcode, otherMember.output.id));
    await getDb(ctx.db)
      .update(email)
      .set({ ledgerPartyId: otherParty!.id })
      .where(eq(email.id, foreignSource.message.id));
    await expect(
      notice([tracker("Hj2yNq6Gw")], trackingless(key("Hj2yNq6Gw"))),
    ).resolves.not.toBe(foreignSourced);

    // Identical item lists cannot tell a renumbered parcel from a second box: hold the
    // packet for review, commit its tracked sibling, and neither join nor duplicate.
    const itemList = (...lines: readonly string[]) =>
      lines.map((line) => `* ${line}\r\n  Quantity: 1`).join("\r\n\r\n");
    const groceries = itemList("Synthetic lemons", "Synthetic onion");
    const reordered = itemList("Synthetic onion", "Synthetic lemons");
    const shipmentCount = async () =>
      (await getDb(ctx.db).select({ id: shipment.id }).from(shipment)).length;
    const expectHeld = async (
      hrefs: readonly string[],
      parcelKey: string,
      unjoined: string,
      siblingNumber: string,
      list: string,
    ) => {
      const [findings, count] = [await heldFindings(), await shipmentCount()];
      const result = await record(
        hrefs,
        trackingless(parcelKey),
        [packet(siblingNumber)],
        list,
      );
      expect(result.unresolvedPackages).toEqual([
        {
          sourceShipmentKey: parcelKey,
          reason: expect.stringContaining("cannot prove which nearby Shipment"),
        },
      ]);
      expect(result.shipmentIds).toHaveLength(1);
      expect(result.shipmentIds).not.toContain(unjoined);
      expect(await heldFindings()).toBe(findings + 1);
      // Only the tracked sibling became a Shipment.
      expect(await shipmentCount()).toBe(count + 1);
    };
    const renumbered = "Mp4tYh9Bq";
    const dispatched = (await notice(
      [tracker(renumbered, 2)],
      trackingless(key(renumbered, 2)),
      groceries,
    ))!;
    // One compatible candidate is enough: a real renumbering and a second box look alike.
    await expectHeld(
      [tracker(renumbered, 0)],
      `amazon:order=000-0000001-0000001:shipmentId=${renumbered}:packageIndex=0`,
      dispatched,
      "EXAMPLE-RENUMBERED-SIBLING",
      reordered,
    );
    await expectHeld(
      [tracker(renumbered, 6)],
      key(renumbered, 6),
      dispatched,
      "EXAMPLE-SECOND-BOX-SIBLING",
      groceries,
    );
    // The retained parcel number and key still join their one Shipment normally.
    await expect(
      notice(
        [tracker(renumbered, 2)],
        trackingless(key(renumbered, 2)),
        groceries,
      ),
    ).resolves.toBe(dispatched);

    // No compatible candidate creates a separate Shipment as before.
    const separate = async (
      hrefs: readonly string[],
      parcelKey: string,
      list: string,
      overrides: Partial<ShipmentEvidence> = {},
      value = "2026-06-03",
    ) => {
      const result = await record(
        hrefs,
        trackingless(parcelKey, overrides, value),
        [],
        list,
      );
      expect(result.unresolvedPackages).toEqual([]);
      expect(result.shipmentIds).not.toContain(dispatched);
      return result.shipmentIds[0]!;
    };
    await separate(
      [tracker(renumbered, 1)],
      key(renumbered, 1),
      itemList("Synthetic lemons", "Synthetic limes"),
    );
    await separate(
      [tracker(renumbered, 3), tracker(renumbered, 4)],
      key(renumbered, 3),
      groceries,
    );
    await separate(
      [tracker(renumbered, 5, "000-0000002-0000002")],
      key(renumbered, 5),
      groceries,
    );
    const singleLine = itemList("Synthetic rice");
    await separate([tracker("Vc8dRs3Lk", 0)], key("Vc8dRs3Lk", 0), singleLine);
    await separate([tracker("Vc8dRs3Lk", 1)], key("Vc8dRs3Lk", 1), singleLine);
    // Period and direction filter a candidate before it can hold the packet.
    await separate(
      [tracker(renumbered, 7)],
      key(renumbered, 7),
      groceries,
      {},
      "2026-10-03",
    );
    await separate([tracker(renumbered, 8)], key(renumbered, 8), groceries, {
      purpose: "outgoing",
    });
    // So does another Purchase.
    const listedOrder = "Lt6wZc9Ks";
    const underOrder = async (index: number, purchaseId: string) =>
      recordShipmentEvidence(
        ctx.db,
        {
          source: (await mail([tracker(listedOrder, index)], groceries)).source,
          purchaseId: parseShortcodeFor("purchase", purchaseId),
          shipments: [trackingless(key(listedOrder, index))],
        },
        ctx.actor,
      );
    const firstOrderBox = await underOrder(0, householdOrder.output.id);
    const secondOrderBox = await underOrder(1, otherOrder.output.id);
    expect(secondOrderBox.unresolvedPackages).toEqual([]);
    expect(secondOrderBox.shipmentIds).not.toEqual(firstOrderBox.shipmentIds);

    // An exact match beside an alternative with the same items is still no proof.
    const contested = "Bz5nGf2Wx";
    const altered = itemList("Synthetic lemons", "Synthetic basil");
    const elsewhere = (await notice(
      [tracker(contested, 2)],
      trackingless(key(contested, 2)),
      groceries,
    ))!;
    const exact = await separate(
      [tracker(contested, 0)],
      key(contested, 0),
      altered,
    );
    await expect(
      notice([tracker(contested, 0)], trackingless(key(contested, 0)), altered),
    ).resolves.toBe(exact);
    await expectHeld(
      [tracker(contested, 0)],
      key(contested, 0),
      exact,
      "EXAMPLE-CONTESTED-SIBLING",
      groceries,
    );
    expect(elsewhere).not.toBe(exact);
  });

  it("keeps a member carrier correction through replay without an extra handoff", async () => {
    await memberImportWorld(ctx.db, ctx.actor);
    const number = "EXAMPLE-MEMBER-CARRIER";
    const guess = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Delivery Code",
    });
    const actual = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Actual Carrier",
    });
    const notice = (name: string, key: string) =>
      capture(key, [
        { ...packet(number), sourceShipmentKey: null, carrierName: name },
      ]);
    const guessed = notice("Synthetic Delivery Code", "delivery-code");
    const code = (await recordShipmentEvidence(ctx.db, guessed, ctx.actor))
      .shipmentIds[0]!;
    await getDb(ctx.db)
      .update(shipment)
      .set({
        extraTrackingNumbers: [
          {
            carrierId: actual.output.id,
            carrierName: "Synthetic Actual Carrier",
            trackingNumber: number,
          },
        ],
      })
      .where(eq(shipment.shortcode, code));

    await executeEntity(buildKernelContext(ctx.db, ctx.actor.userId), {
      action: "update",
      entity: "shipment",
      id: code,
      data: { carrierId: actual.output.id },
    });
    const replay = await recordShipmentEvidence(ctx.db, guessed, ctx.actor);

    expect(replay.shipmentIds).toEqual([code]);
    expect(replay.unresolvedPackages).toEqual([]);
    const [row] = await getDb(ctx.db)
      .select({
        carrier: vendor.shortcode,
        extras: shipment.extraTrackingNumbers,
      })
      .from(shipment)
      .innerJoin(vendor, eq(vendor.id, shipment.carrierId))
      .where(eq(shipment.shortcode, code));
    expect(row).toEqual({ carrier: actual.output.id, extras: [] });
    expect(guess.output.id).not.toBe(actual.output.id);
  });

  it("keeps a delivery-field code from establishing a carrier while labeled claims and handoffs survive", async () => {
    await memberImportWorld(ctx.db, ctx.actor);
    const code = await createRepoIdentity(ctx, "vendor", { name: "ZQX" });
    const actual = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Actual Carrier",
    });
    const notice = (number: string) =>
      `Tracking ID: ${number}\nDelivery: ZQX\nSynthetic item`;
    const hinted = (
      number: string,
      hint: Pick<ShipmentEvidence, "carrierId" | "carrierName">,
    ): ShipmentEvidence => {
      const base = packet(number);
      return {
        ...base,
        ...hint,
        sourceShipmentKey: null,
        observations: base.observations.map((observation) => ({
          ...observation,
          ...hint,
        })),
      };
    };
    const carrierOf = async (shipmentCode: string) => {
      const [row] = await getDb(ctx.db)
        .select({
          carrierId: shipment.carrierId,
          extras: shipment.extraTrackingNumbers,
        })
        .from(shipment)
        .where(eq(shipment.shortcode, shipmentCode));
      return row;
    };

    // Name, stale Vendor reference and reference-only hints all restate the field.
    for (const [key, hint] of [
      ["name", { carrierId: null, carrierName: "ZQX" }],
      ["stale", { carrierId: code.output.id, carrierName: "ZQX" }],
      ["reference", { carrierId: code.output.id, carrierName: null }],
      ["mismatch", { carrierId: actual.output.id, carrierName: "ZQX" }],
    ] as const) {
      const number = `EXAMPLE-CODE-${key.toUpperCase()}`;
      const input = capture(
        `delivery-${key}`,
        [hinted(number, hint)],
        undefined,
        notice(number),
      );
      const first = await recordShipmentEvidence(ctx.db, input, ctx.actor);
      const shipmentCode = first.shipmentIds[0]!;
      expect(await carrierOf(shipmentCode)).toEqual({
        carrierId: null,
        extras: [],
      });
      const timeline = await readShipmentTimeline(ctx.db, shipmentCode);
      expect(timeline.observations[0]).toMatchObject({
        carrierId: null,
        carrierName: null,
      });
      const replay = await recordShipmentEvidence(ctx.db, input, ctx.actor);
      expect(replay).toMatchObject({
        shipmentIds: [shipmentCode],
        insertedObservations: 0,
        repeatedObservations: 1,
        unresolvedPackages: [],
      });
    }

    // A later notice for a package under a real carrier adds no false handoff.
    const known = await recordShipmentEvidence(
      ctx.db,
      capture("delivery-known", [
        hinted("EXAMPLE-CODE-KNOWN", {
          carrierId: null,
          carrierName: "Synthetic Actual Carrier",
        }),
      ]),
      ctx.actor,
    );
    const later = capture(
      "delivery-later",
      [
        {
          ...hinted("EXAMPLE-CODE-KNOWN", {
            carrierId: null,
            carrierName: "ZQX",
          }),
          extraTrackingNumbers: [
            {
              carrierId: null,
              carrierName: "ZQX",
              trackingNumber: "EXAMPLE-CODE-KNOWN",
            },
            {
              carrierId: actual.output.id,
              carrierName: "Synthetic Actual Carrier",
              trackingNumber: "EXAMPLE-CODE-HANDOFF",
            },
          ],
        },
      ],
      undefined,
      notice("EXAMPLE-CODE-KNOWN"),
    );
    expect(
      (await recordShipmentEvidence(ctx.db, later, ctx.actor)).shipmentIds,
    ).toEqual(known.shipmentIds);
    const [knownRow] = await getDb(ctx.db)
      .select({
        carrier: vendor.shortcode,
        extras: shipment.extraTrackingNumbers,
      })
      .from(shipment)
      .innerJoin(vendor, eq(vendor.id, shipment.carrierId))
      .where(eq(shipment.shortcode, known.shipmentIds[0]!));
    expect(knownRow).toEqual({
      carrier: actual.output.id,
      extras: [
        {
          carrierId: actual.output.id,
          carrierName: "Synthetic Actual Carrier",
          trackingNumber: "EXAMPLE-CODE-HANDOFF",
        },
      ],
    });

    // Genuine labels and other hints beside the field are unaffected.
    const labeled = "EXAMPLE-CODE-LABELED";
    const labeledCode = (
      await recordShipmentEvidence(
        ctx.db,
        capture(
          "delivery-labeled",
          [hinted(labeled, { carrierId: null, carrierName: "ZQX" })],
          undefined,
          `Carrier: ZQX\nTracking ID: ${labeled}\nDelivery: ZQX`,
        ),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    const [labeledRow] = await getDb(ctx.db)
      .select({ carrier: vendor.shortcode })
      .from(shipment)
      .innerJoin(vendor, eq(vendor.id, shipment.carrierId))
      .where(eq(shipment.shortcode, labeledCode));
    expect(labeledRow).toEqual({ carrier: code.output.id });
    const beside = "EXAMPLE-CODE-BESIDE";
    const besideCode = (
      await recordShipmentEvidence(
        ctx.db,
        capture(
          "delivery-beside",
          [
            hinted(beside, {
              carrierId: null,
              carrierName: "Synthetic Actual Carrier",
            }),
          ],
          undefined,
          notice(beside),
        ),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    expect((await carrierOf(besideCode))?.carrierId).not.toBeNull();
    const { explicit } = await assessCarrierPacket(
      ctx.db,
      { trackingNumber: "EXAMPLE-SPLIT", extraTrackingNumbers: [] },
      { texts: ["Delivery:\nZQX\nTracking ID: EXAMPLE-SPLIT"], links: [] },
    );
    expect(explicit).toEqual([]);
    for (const text of [
      "Delivery: Synthetic Carrier",
      "Delivery: ZQX Ground",
      "Delivery: FREE\nFREE returns",
      "Estimated delivery Sun, Jul 21",
      "Delivery: ZQX Tracking",
      "Delivery: ZQX Tracking ID: 1\nCarrier: ZQX Tracking ID: 1",
    ])
      expect(deliveryFieldCodes({ texts: [text] })).toEqual(new Set());
    for (const text of [
      "Delivery: ZQX; https://example.test/zqx/track",
      "Delivery:\tZQX\tTracking",
      "Delivery: ZQX Tracking ID: 1",
      "Delivery: ZQX tracking #1",
      "Delivery: ZQX Trk # 1",
      "Delivery: ZQX Carrier: Synthetic Actual Carrier",
      "Delivery: ZQX Order #1",
      "Delivery: ZQX Status: Shipped",
    ])
      expect(deliveryFieldCodes({ texts: [text] })).toEqual(new Set(["ZQX"]));

    // A field ended by the next label or column clears the hint, not a handoff.
    const tabbed = "EXAMPLE-CODE-TABBED";
    const tabbedCode = (
      await recordShipmentEvidence(
        ctx.db,
        capture(
          "delivery-tabbed",
          [
            {
              ...hinted(tabbed, { carrierId: null, carrierName: "ZQX" }),
              extraTrackingNumbers: [
                {
                  carrierId: actual.output.id,
                  carrierName: "Synthetic Actual Carrier",
                  trackingNumber: "EXAMPLE-CODE-TABBED-HANDOFF",
                },
              ],
            },
          ],
          undefined,
          `Delivery:\tZQX\tTracking ID: ${tabbed}`,
        ),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    expect(await carrierOf(tabbedCode)).toEqual({
      carrierId: null,
      extras: [
        {
          carrierId: actual.output.id,
          carrierName: "Synthetic Actual Carrier",
          trackingNumber: "EXAMPLE-CODE-TABBED-HANDOFF",
        },
      ],
    });
    const inline = "EXAMPLE-CODE-INLINE";
    const inlineCode = (
      await recordShipmentEvidence(
        ctx.db,
        capture(
          "delivery-inline",
          [hinted(inline, { carrierId: null, carrierName: "ZQX" })],
          undefined,
          `Delivery: ZQX Tracking ID: ${inline}`,
        ),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    expect((await carrierOf(inlineCode))?.carrierId).toBeNull();
    const inlineLabeled = "EXAMPLE-CODE-INLINE-LABELED";
    const inlineLabeledCode = (
      await recordShipmentEvidence(
        ctx.db,
        capture(
          "delivery-inline-labeled",
          [hinted(inlineLabeled, { carrierId: null, carrierName: "ZQX" })],
          undefined,
          `Carrier: ZQX Tracking ID: ${inlineLabeled}\nDelivery: ZQX Tracking ID: ${inlineLabeled}`,
        ),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    expect((await carrierOf(inlineLabeledCode))?.carrierId).not.toBeNull();

    // A known carrier's name alone in the field stays unknown until a label names it.
    await createRepoIdentity(ctx, "vendor", { name: "UPS" });
    const named = "EXAMPLE-CODE-NAMED";
    const namedCode = (
      await recordShipmentEvidence(
        ctx.db,
        capture(
          "delivery-named",
          [hinted(named, { carrierId: null, carrierName: "UPS" })],
          undefined,
          `Tracking ID: ${named}\nDelivery: UPS`,
        ),
        ctx.actor,
      )
    ).shipmentIds[0]!;
    expect((await carrierOf(namedCode))?.carrierId).toBeNull();

    // Re-extraction dropping the hint changes the fallback key, not the binding.
    for (const [key, sourceEventKey] of [
      ["keyed", "scan-one"],
      ["keyless", null],
    ] as const) {
      const fresh = `EXAMPLE-CODE-FRESH-${key.toUpperCase()}`;
      const extraction = (
        hint: Pick<ShipmentEvidence, "carrierId" | "carrierName">,
      ) => {
        const base = hinted(fresh, hint);
        return capture(
          `delivery-fresh-${key}`,
          [
            {
              ...base,
              observations: base.observations.map((observation) => ({
                ...observation,
                sourceEventKey,
              })),
            },
          ],
          undefined,
          `Tracking ID: ${fresh}\nDelivery: ZQX`,
        );
      };
      const first = await recordShipmentEvidence(
        ctx.db,
        extraction({ carrierId: null, carrierName: "ZQX" }),
        ctx.actor,
      );
      const redone = await recordShipmentEvidence(
        ctx.db,
        extraction({ carrierId: null, carrierName: null }),
        ctx.actor,
      );
      const [bound] = await getDb(ctx.db)
        .select({ id: shipment.id })
        .from(shipment)
        .where(eq(shipment.shortcode, first.shipmentIds[0]!));
      const bindings = await getDb(ctx.db)
        .select({ packageKey: shipmentSourcePackage.packageKey })
        .from(shipmentSourcePackage)
        .where(eq(shipmentSourcePackage.shipmentId, bound!.id));
      expect(redone).toMatchObject({
        shipmentIds: first.shipmentIds,
        unresolvedPackages: [],
      });
      expect(bindings).toEqual([{ packageKey: `ZQX:${fresh}` }]);
      expect(
        (await readShipmentTimeline(ctx.db, first.shipmentIds[0]!)).timeline,
      ).toHaveLength(1);
    }
  });

  it("removes an extra reference only through an audited, keyed member correction", async () => {
    await memberImportWorld(ctx.db, ctx.actor);
    const number = "EXAMPLE-EXTRA-EDIT";
    const falseCarrier = await createRepoIdentity(ctx, "vendor", {
      name: "SHP",
    });
    const handoff = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Handoff Carrier",
    });
    const hinted = (carrierName: string | null): ShipmentEvidence => {
      const base = packet(number);
      return {
        ...base,
        carrierName,
        sourceShipmentKey: null,
        observations: base.observations.map((observation) => ({
          ...observation,
          carrierName,
        })),
      };
    };
    const delivery = `Tracking ID: ${number}\nDelivery: SHP`;
    const source = capture("extra-edit", [hinted("SHP")], undefined, delivery);
    const code = (await recordShipmentEvidence(ctx.db, source, ctx.actor))
      .shipmentIds[0]!;
    const falseExtra = {
      carrierId: falseCarrier.output.id,
      carrierName: null,
      trackingNumber: number,
    };
    const genuine = {
      carrierId: handoff.output.id,
      carrierName: "Synthetic Handoff Carrier",
      trackingNumber: "EXAMPLE-EXTRA-HANDOFF",
    };
    await getDb(ctx.db)
      .update(shipment)
      .set({ extraTrackingNumbers: [falseExtra, genuine] })
      .where(eq(shipment.shortcode, code));
    const read = async () => {
      const [row] = await getDb(ctx.db)
        .select({
          id: shipment.id,
          carrierId: shipment.carrierId,
          purpose: shipment.purpose,
          extras: shipment.extraTrackingNumbers,
        })
        .from(shipment)
        .where(eq(shipment.shortcode, code));
      const entries = await getDb(ctx.db)
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(eq(auditLog.entityId, row!.id));
      return { ...row!, changes: entries.map(({ changes }) => changes) };
    };
    const update = (data: ShipmentUpdateData) =>
      executeEntity(buildKernelContext(ctx.db, ctx.actor.userId), {
        action: "update",
        entity: "shipment",
        id: code,
        data,
      });
    const remove = (
      ...keys: ShipmentExtraTrackingNumberRemovals[number]["key"][]
    ) => keys.map((key) => ({ op: "remove" as const, key }));
    const falseKey = {
      trackingNumber: falseExtra.trackingNumber,
      carrierId: falseExtra.carrierId,
    };

    // Source intake establishes this handoff after the member's client read the list.
    const added = {
      carrierId: handoff.output.id,
      carrierName: "Synthetic Handoff Carrier",
      trackingNumber: "EXAMPLE-EXTRA-ADDED",
    };
    await recordShipmentEvidence(
      ctx.db,
      capture(
        "extra-added",
        [{ ...hinted(null), extraTrackingNumbers: [added] }],
        undefined,
        `Tracking ID: ${number}`,
      ),
      ctx.actor,
    );
    const concurrent = await read();
    expect(concurrent.extras).toEqual([falseExtra, genuine, added]);

    // Replacement lists, additions and the bulk resolver cannot reach the writer.
    for (const extraTrackingNumbers of [
      [genuine],
      [{ op: "add", key: falseKey }],
      [{ op: "replace", key: falseKey, value: {} }],
      [],
    ])
      await expect(
        // @ts-expect-error The update contract accepts only keyed removals.
        update({ extraTrackingNumbers }),
      ).rejects.toThrow("extraTrackingNumbers");
    await expect(
      executeEntity(buildKernelContext(ctx.db, ctx.actor.userId), {
        action: "bulkUpdate",
        entity: "shipment",
        ids: [code],
        // @ts-expect-error The bulk contract omits this field.
        data: { extraTrackingNumbers: remove(falseKey) },
      }),
    ).rejects.toThrow("extraTrackingNumbers");

    for (const actor of [
      { ...ctx.actor, channel: "system" as const },
      { ...ctx.actor, runId: parseEntityId("run", crypto.randomUUID()) },
    ])
      await expect(
        editShipmentReferences(
          ctx.db,
          {
            shipmentId: parseShortcodeFor("shipment", code),
            extraTrackingNumbers: [
              {
                op: "remove",
                key: {
                  trackingNumber: number,
                  carrierId: falseCarrier.output.id,
                },
              },
            ],
          },
          actor,
        ),
      ).rejects.toThrow("interactive member request");

    // A missing key refuses the whole update, with its carrier and purpose edits.
    for (const missing of [
      { trackingNumber: "EXAMPLE-EXTRA-GONE", carrierId: null },
      { trackingNumber: number, carrierId: handoff.output.id },
    ])
      await expect(
        update({
          purpose: "outgoing",
          carrierId: handoff.output.id,
          extraTrackingNumbers: remove(falseKey, missing),
        }),
      ).rejects.toThrow("nothing changed");
    expect(await read()).toEqual(concurrent);

    // A carrier edit that changes nothing leaves no audit row.
    await update({ carrierId: null });
    expect(await read()).toEqual(concurrent);

    await update({
      extraTrackingNumbers: remove({
        ...falseKey,
        trackingNumber: number.toLowerCase(),
      }),
    });
    const corrected = [genuine, added];
    const removal = await read();
    expect(removal.extras).toEqual(corrected);
    expect(removal.changes).toEqual([
      ...concurrent.changes,
      {
        extraTrackingNumbers: {
          from: [falseExtra, genuine, added],
          to: corrected,
        },
      },
    ]);

    // Neither retained nor fresh extraction of the Delivery field restores it.
    await recordShipmentEvidence(ctx.db, source, ctx.actor);
    await recordShipmentEvidence(
      ctx.db,
      capture("extra-edit", [hinted(null)], undefined, delivery),
      ctx.actor,
    );
    expect(await read()).toMatchObject({
      carrierId: null,
      extras: corrected,
      changes: removal.changes,
    });
    await expect(
      update({ extraTrackingNumbers: remove(falseKey) }),
    ).rejects.toThrow("nothing changed");
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
