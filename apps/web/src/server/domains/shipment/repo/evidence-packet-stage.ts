import type { ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  parseShortcodeFor,
  type PurchaseId,
  type ShortcodeFor,
} from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { shipmentSourceCapture, ledgerParty, vendor } from "~/server/db/schema";
import { publishRunFinding } from "~/server/domains/run/repo/run-finding";
import {
  carrierCaptureEvidence,
  loadCarrierHistory,
  carrierClaimsConflict,
  resolveCarrierName,
  carrierFormatEvidence,
  deliveryFieldCodes,
  withoutDeliveryFieldCarrier,
} from "~/server/domains/shipment/repo/carrier-evidence";
import { normalizeTrackingNumber } from "~/server/domains/shipment/repo/carrier-recognition";
import { constraintViolation } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import { deduplicateShipmentTrackingReferences } from "./carrier-references";
import type { ShipmentWriterInput } from "./evidence";
import {
  retainedPackageShipment,
  canonicalShipment,
  carrierReference,
  projectCarrierReferences,
  assertPurchaseSourceOwner,
  automaticPurchaseAssociation,
} from "./evidence-internal";
import { applyObservationWrite } from "./evidence-observation-application";
import { loadObservationRevision } from "./evidence-observation-load";
import { planObservationWrite } from "./evidence-observation-plan";
import { loadIdentityCandidates } from "./evidence-packet-load";
import {
  identityWindowSchema,
  planPacketAdmission,
  planCarrierCorrection,
} from "./evidence-packet-plan";
import { prepareShipmentPacket } from "./evidence-packet-prepare";
import { applyShipmentWrite } from "./evidence-shipment-application";
import { planShipmentWrite } from "./evidence-shipment-plan";
const canonical = (value: unknown) => canonicalJson(jsonSnapshot.parse(value));
export type PacketState = {
  shipmentIds: ShortcodeFor<"shipment">[];
  unresolvedPackages: { sourceShipmentKey: string | null; reason: string }[];
  insertedObservations: number;
  repeatedObservations: number;
};
export type PacketContext = {
  input: ShipmentWriterInput;
  actor: ActorContext;
  capture: typeof shipmentSourceCapture.$inferSelect;
  sourceKey: string;
  ownerId: string | null;
  notificationDate: string | null;
  purchaseId: PurchaseId | null;
  observedAt: Date;
  sourceEvidence: ReturnType<typeof carrierCaptureEvidence>;
  deliveryCodes: ReturnType<typeof deliveryFieldCodes>;
  submitted: ShipmentWriterInput["shipments"][number];
};
// oxlint-disable-next-line complexity -- Packet admission keeps source identity and carrier revalidation in transaction order.
export async function processShipmentPacket(
  tdb: Database,
  context: PacketContext,
  state: PacketState,
) {
  const {
    input,
    actor,
    capture,
    sourceKey,
    ownerId,
    notificationDate,
    purchaseId,
    observedAt,
    deliveryCodes,
    submitted,
  } = context;
  const { shipmentIds, unresolvedPackages } = state;
  const database = getDb(tdb);
  const prepared = await prepareShipmentPacket(tdb, context, state);
  if (!prepared) return;
  const {
    packet,
    suggestion,
    number,
    packageKey,
    binding,
    sourceBindingAmbiguous,
    extraTrackingNumbers,
    references,
    identified,
    effectiveObservations,
  } = prepared;
  let { row, carrier } = prepared;
  const identity = await loadIdentityCandidates(
    tdb,
    references,
    effectiveObservations,
    notificationDate,
  );
  // Resolve the final candidate before source and complete-period checks, including additional references.
  if (
    !row &&
    !packet.distinctPackageEvidence &&
    identity.candidates.length === 1 &&
    identity.candidates[0]
  ) {
    const proposed = await canonicalShipment(
      tdb,
      identity.candidates[0].shortcode,
    );
    if (
      !purchaseId ||
      !proposed.purchaseId ||
      proposed.purchaseId === purchaseId
    )
      row = proposed;
  }
  let retainedPackageAmbiguous = false;
  if (!row && !number && packet.sourceShipmentKey) {
    const retained = await retainedPackageShipment(tdb, {
      capture,
      ownerId,
      packageKey: packet.sourceShipmentKey,
      purpose: packet.purpose,
      purchaseId,
      window: identity.window,
    });
    retainedPackageAmbiguous = retained === "ambiguous";
    if (retained !== "ambiguous") row = retained;
  }
  const existingDates = row
    ? identityWindowSchema.parse(
        (
          await database.execute(
            sql`SELECT first_day::text AS first, last_day::text AS last FROM shipment_identity_window(${row.id}::uuid)`,
            "objects",
          )
        )[0],
      )
    : null;
  const carrierHistory =
    row || references.length
      ? await loadCarrierHistory(tdb, {
          ...(row ? { shipmentId: row.id } : { window: identity.window }),
          references: references.map((ref) => ref.number),
        })
      : null;
  const { carrierIssue, correctingCarrier } = planCarrierCorrection({
    row,
    carrierId: carrier.id,
    number,
    sourceBindingAmbiguous,
    explicitConflict: carrierClaimsConflict(suggestion.explicit),
    historyTruncated: carrierHistory?.truncated ?? false,
    historyConflict: carrierHistory
      ? carrierClaimsConflict([
          ...suggestion.explicit,
          ...carrierHistory.claims,
        ])
      : false,
    supported: Boolean(suggestion.primary.carrier),
    candidates: identity.candidates,
  });
  const currentRowId = row?.id;
  const projection = row
    ? await projectCarrierReferences(tdb, {
        row,
        carrier,
        number,
        extraTrackingNumbers,
        correctingCarrier,
        carrierName: suggestion.primary.carrier?.name ?? null,
      })
    : null;
  let projectedCollision = false;
  if (row && projection && correctingCarrier) {
    const [primaryCarrier] = projection.carrierId
      ? await database
          .select({ code: vendor.shortcode })
          .from(vendor)
          .where(eq(vendor.id, projection.carrierId))
      : [];
    const completeReferences = [
      ...(projection.trackingNumber
        ? [
            {
              number: normalizeTrackingNumber(projection.trackingNumber),
              carrier: primaryCarrier?.code ?? null,
            },
          ]
        : []),
      ...projection.extraTrackingNumbers.map((ref) => ({
        number: normalizeTrackingNumber(ref.trackingNumber),
        carrier: ref.carrierId,
      })),
    ];
    const complete = await loadIdentityCandidates(
      tdb,
      completeReferences,
      effectiveObservations,
      notificationDate,
    );
    projectedCollision = complete.candidates.some(
      (candidate) =>
        candidate.id !== currentRowId && !candidate.carrier_conflict,
    );
  }
  const { candidate, ambiguity } = planPacketAdmission({
    row,
    identity,
    references,
    packet,
    purchaseId,
    existingDates,
    carrierIssue,
    retainedPackageAmbiguous,
    correctingCarrier,
    projectedCollision,
  });
  if (ambiguity) {
    unresolvedPackages.push({
      sourceShipmentKey: packet.sourceShipmentKey,
      reason: ambiguity,
    });
    const namedCarrier =
      suggestion.primary.carrier ??
      (await resolveCarrierName(tdb, packet.carrierName));
    const format = number
      ? carrierFormatEvidence(
          number,
          namedCarrier ? [namedCarrier.name, ...namedCarrier.aliases] : [],
        )
      : null;
    const advisory =
      format?.outcome === "ambiguous_match"
        ? " The number format matches multiple carriers; use the retained source."
        : format?.outcome === "unsupported_format" &&
            format.sources.length &&
            namedCarrier
          ? ` This reference is outside the limited published ${namedCarrier.name} format checks; that does not exclude the carrier.`
          : "";
    const [member] = ownerId
      ? [{ id: parseEntityId("ledgerParty", ownerId) }]
      : await database
          .select({ id: ledgerParty.id })
          .from(ledgerParty)
          .where(
            and(
              eq(ledgerParty.userId, actor.userId),
              eq(ledgerParty.kind, "member"),
              notDeleted(ledgerParty),
            ),
          );
    if (member)
      await publishRunFinding(tdb, {
        runId: actor.runId ?? null,
        ledgerPartyId: member.id,
        entityKind: row
          ? "shipment"
          : capture.emailId
            ? "email"
            : "ledgerParty",
        entityId: row?.id ?? capture.emailId ?? member.id,
        kind: "shipment_identity_ambiguous",
        summary: `${ambiguity}${advisory}`,
        proposedFix: null,
        evidenceFingerprint: await sha256Hex(
          canonical({ sourceKey, packageKey, packet: submitted }),
        ),
      });
    return;
  }
  if (candidate)
    return constraintViolation(
      "The final Shipment candidate must pass source and identity checks before association.",
    );
  if (
    row &&
    !row.purchaseAssociationReviewed &&
    purchaseId &&
    row.purchaseId &&
    row.purchaseId !== purchaseId
  )
    return constraintViolation(
      "The Shipment belongs to another Purchase; explicitly reassign it.",
    );
  if (row) await assertPurchaseSourceOwner(tdb, row.purchaseId, ownerId);
  const acceptedPurchaseId = row
    ? await automaticPurchaseAssociation(tdb, row, purchaseId)
    : purchaseId;
  const assignment = row
    ? { kind: "update" as const, row }
    : {
        kind: "create" as const,
        values: {
          name:
            [suggestion.primary.carrier?.name ?? "Package", number]
              .filter(Boolean)
              .join(" · ") || "Package",
          purchaseId,
          carrierId: carrier.id,
          trackingNumber: number,
          extraTrackingNumbers: await deduplicateShipmentTrackingReferences(
            tdb,
            {
              trackingNumber: number,
              carrierId: carrier.id,
              extraTrackingNumbers,
            },
          ),
          purpose:
            packet.purpose === "unknown" && input.source.kind === "sms_export"
              ? ("incoming" as const)
              : packet.purpose,
        },
      };
  const shipmentPlan = planShipmentWrite({
    assignment,
    purchaseId: acceptedPurchaseId,
    projection,
    binding,
    sourceKey,
    packageKey,
  });
  const applied = await applyShipmentWrite(tdb, actor, shipmentPlan);
  row = applied.row;
  const sourcePackage = applied.sourcePackage;
  shipmentIds.push(parseShortcodeFor("shipment", row.shortcode));
  for (const {
    observation,
    fingerprint,
    literalFingerprint,
    occurrenceKey,
    revisesFromSameCapture,
  } of identified) {
    const eventHint = await withoutDeliveryFieldCarrier(
      tdb,
      {
        carrierId: observation.carrierId,
        carrierName: observation.carrierName,
      },
      deliveryCodes,
    );
    const eventCarrier = await carrierReference(
      tdb,
      eventHint.carrierId,
      eventHint.carrierName,
    );
    const event = {
      ...observation,
      ...eventHint,
      carrierId: eventCarrier.code,
    };
    const { current, versions } = await loadObservationRevision(
      tdb,
      sourcePackage.id,
      occurrenceKey,
    );
    const plan = planObservationWrite({
      versions,
      current,
      fingerprint,
      literalFingerprint,
      observedAt,
      revisesFromSameCapture,
      event,
      shipmentId: row.id,
      sourceCaptureId: capture.id,
      sourcePackageId: sourcePackage.id,
      sourceKey,
      occurrenceKey,
    });
    await applyObservationWrite(tdb, plan);
    if (plan.kind === "repeat") state.repeatedObservations++;
    else state.insertedObservations++;
  }
  await recordChange(tdb, { kind: "source", categories: ["shipment"] });
}
