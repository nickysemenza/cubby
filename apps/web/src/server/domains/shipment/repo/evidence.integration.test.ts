import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  RecordShipmentEvidenceInput,
  ShipmentEvidence,
} from "@cubby/schemas/shipment-evidence";
import { testUserId } from "@cubby/schemas/testing";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  shipment,
  shipmentObservation,
  shipmentSourceCapture,
  shipmentSourcePackage,
  vendor,
  assessmentState,
  feedback,
  expense,
  inventoryEntry,
  email,
  user,
} from "~/server/db/schema";
import {
  memberImportWorld,
  retainedMailFixture,
} from "~/server/domains/purchase-import/operations/order-import.fixtures";
import { shipmentCarrierEvidence } from "~/server/domains/shipment/repo/carrier-packets";
import { mergeVendors } from "~/server/domains/vendor/repo/vendor";
import { executeEntity } from "~/server/entity-kernel";
import { recordFeedback } from "~/server/generic/assessment/repo/assessment";
import { listAutomaticDecisions } from "~/server/generic/assessment/repo/automatic-decisions";
import {
  loadReceiptFieldAuthority,
  recordFieldAssignmentReceipt,
} from "~/server/generic/assessment/repo/automatic-fields";
import { listSuggestions } from "~/server/generic/assessment/repo/suggestion-review";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { withAuditReceipts } from "~/server/generic/audit-log/repo/audit-receipts";
import { getEntityGraph } from "~/server/generic/entity-graph/repo/entity-graph";
import { getConnectedRecords } from "~/server/generic/entity-links/repo/connected-records";
import { shipmentTrackingReport } from "~/server/generic/entity-report/repo/shipment";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";
import { drainStoredDerived } from "~/server/testing/background-queue";

import { auditShipmentCarriers } from "./carrier-audit";
import {
  carrierFormatEvidence,
  retainedCarrierClaim,
  assessCarrierPacket,
  carrierCaptureEvidence,
} from "./carrier-evidence";
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

  const authorityOf = async (code: string) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(shipment)
      .where(eq(shipment.shortcode, code));
    return loadReceiptFieldAuthority(
      ctx.db,
      "shipment",
      row!.id,
      "carrierId",
      row!.carrierId,
    );
  };
  const seedAuthority = async (
    code: string,
    carrierId: (typeof shipment.$inferSelect)["carrierId"],
    authority: "automatic" | "unknown",
  ) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(shipment)
      .where(eq(shipment.shortcode, code));
    const { auditIds } = await withAuditReceipts(async () => {
      await getDb(ctx.db)
        .update(shipment)
        .set({ carrierId })
        .where(eq(shipment.id, row!.id));
      await logAuditEntries(ctx.db, ctx.actor, [
        {
          entityKind: "shipment",
          entityId: row!.id,
          action: "update",
          changes: { carrierId: { from: row!.carrierId, to: carrierId } },
        },
      ]);
    });
    if (authority === "automatic") {
      const [carrier] = carrierId
        ? await getDb(ctx.db)
            .select()
            .from(vendor)
            .where(eq(vendor.id, carrierId))
        : [];
      await recordFieldAssignmentReceipt(ctx.db, {
        entity: "shipment",
        recordId: row!.id,
        field: "carrierId",
        rawValue: carrierId,
        value: carrier?.shortcode ?? null,
        authority,
        actor: ctx.actor,
        auditIds,
      });
    }
  };

  it("corrects only machine-owned carrier assignments and protects member intent and replay", async () => {
    await memberImportWorld(ctx.db, ctx.actor);
    const wrong = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Courier Alpha",
    });
    const correct = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Courier Beta",
      aliases: ["Synthetic Beta Ground"],
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
    expect(initial).toMatchObject({
      carrierId: null,
    });
    // Seed a positively machine-owned historical mistake; legacy default authority is tested separately.
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
    await seedAuthority(code, wrongId, "automatic");
    const quote = "Synthetic Beta Ground tracking 123456789012";
    const proof = capture(
      "authority-proof",
      [
        {
          ...packet("123456789012"),
          carrierName: "Synthetic Beta Ground",
          carrierClaims: [
            {
              trackingNumber: "123456789012",
              carrierName: "Synthetic Beta Ground",
              role: "carrier",
              service: "Ground",
              evidence: { kind: "statement", quote },
            },
          ],
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
    const automaticOwner = await authorityOf(code);
    expect(automaticOwner.kind).toBe("automatic");
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
    expect((await authorityOf(code)).kind).toBe("automatic");
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
    expect((await authorityOf(code)).kind).toBe("automatic");
    expect(
      (await listAutomaticDecisions(ctx.db, { recordIds: [code] })).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: "field",
          applicationVerified: true,
          automaticRule: "retained-source@1",
        }),
      ]),
    );
    expect(
      await listSuggestions(ctx.db, {
        entity: "shipment",
        recordIds: [code],
        status: "pending",
      }),
    ).toEqual([]);
    if (automaticOwner.kind === "unknown")
      throw new Error("Synthetic automatic receipt missing");
    const [application] = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.id, automaticOwner.receiptId));
    await recordFeedback(ctx.db, {
      assessmentId: application!.assessmentId,
      operationId: "synthetic-carrier-confirmation",
      verdict: "correct",
      authority: "member",
      actorUserId: ctx.actor.userId,
      intent: "history",
    });
    expect((await authorityOf(code)).kind).toBe("unknown");
    await executeEntity(buildKernelContext(ctx.db, ctx.actor.userId), {
      action: "update",
      entity: "shipment",
      id: code,
      data: { carrierId: correct.output.id },
    });
    expect((await authorityOf(code)).kind).toBe("member");
    await executeEntity(buildKernelContext(ctx.db, ctx.actor.userId), {
      action: "bulkUpdate",
      entity: "shipment",
      ids: [code],
      data: { carrierId: null, purpose: "outgoing" },
    });
    const held = await recordShipmentEvidence(ctx.db, proof, ctx.actor);
    expect(held.unresolvedPackages).toHaveLength(1);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0],
    ).toMatchObject({ carrierId: null, purpose: "outgoing" });
    const before = await getDb(ctx.db).select().from(assessmentState);
    const retained = await getDb(ctx.db).select().from(shipmentCarrierEvidence);
    const audit = await auditShipmentCarriers(ctx.db, {});
    expect(
      audit.candidates.some(
        (candidate) => candidate.category === "member_decision",
      ),
    ).toBe(true);
    expect(await getDb(ctx.db).select().from(assessmentState)).toEqual(before);
    expect(await getDb(ctx.db).select().from(shipmentCarrierEvidence)).toEqual(
      retained,
    );
    const directory = await mkdtemp(join(tmpdir(), "synthetic-carrier-audit-"));
    try {
      const output = join(directory, "private.json");
      const runAudit = (file: string, databaseUrl = ctx.databaseUrl) =>
        promisify(execFile)(
          "pnpm",
          [
            "exec",
            "tsx",
            "tooling/shipment-carrier-audit.ts",
            "--output",
            file,
          ],
          {
            env: { ...process.env, CARRIER_AUDIT_DATABASE_URL: databaseUrl },
          },
        );
      await runAudit(output);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(audit);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      const existing = join(directory, "existing.json");
      await writeFile(existing, "Synthetic existing report", { mode: 0o644 });
      await expect(runAudit(existing)).rejects.toMatchObject({
        stderr: expect.stringContaining("EEXIST"),
      });
      expect(await readFile(existing, "utf8")).toBe(
        "Synthetic existing report",
      );
      const url = new URL(ctx.databaseUrl);
      url.searchParams.set("options", "-c statement_timeout=30000");
      await expect(
        runAudit(join(directory, "options.json"), url.toString()),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Connection URL options are not accepted",
        ),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it("holds unknown authority, conflicting source claims and identity collisions without speculative packages", async () => {
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
    ).toHaveLength(1);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0],
    ).toMatchObject({ carrierId: alphaId });
    const findings = await getDb(ctx.db).select().from(assessmentState);
    await recordShipmentEvidence(ctx.db, proof, ctx.actor);
    expect(await getDb(ctx.db).select().from(assessmentState)).toEqual(
      findings,
    );
    expect(
      (await auditShipmentCarriers(ctx.db, { scope: "unresolved" })).candidates,
    ).toHaveLength(1);
    await seedAuthority(code, alphaId, "automatic");
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
    expect((await authorityOf(code)).kind).toBe("automatic");
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0],
    ).toMatchObject({ carrierId: alphaId, purpose: "incoming" });
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
                quote: "Synthetic Beta Carrier tracking EXAMPLE-CONFLICT",
              },
            },
          ],
        },
      ],
      "2026-06-07T09:00:00Z",
      conflictQuote + "\nSynthetic Beta Carrier tracking EXAMPLE-CONFLICT",
    );
    const held = await recordShipmentEvidence(ctx.db, conflicting, ctx.actor);
    expect(held.shipmentIds).toEqual([]);
    expect(held.unresolvedPackages).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(shipment)).toHaveLength(2);
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
    expect(await getDb(ctx.db).select().from(shipment)).toHaveLength(2);
    expect(
      (
        await auditShipmentCarriers(ctx.db, { scope: "unresolved" })
      ).candidates.some((row) => row.category === "conflicting_or_handoff"),
    ).toBe(true);
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

  it("review regression: additional-only identity cannot bypass historical carrier authority", async () => {
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
    await seedAuthority(code, null, "unknown");
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
    expect(result.unresolvedPackages).toHaveLength(1);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(shipment)
          .where(eq(shipment.shortcode, code))
      )[0],
    ).toMatchObject({
      trackingNumber: null,
      carrierId: null,
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
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(eq(assessmentState.family, "run_finding")),
    ).toHaveLength(1);
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
      ).primary.carrier,
    ).toBeNull();
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
              freshness: "stale",
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
    const result = await recordShipmentEvidence(
      ctx.db,
      capture("forecast", [parcel]),
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
