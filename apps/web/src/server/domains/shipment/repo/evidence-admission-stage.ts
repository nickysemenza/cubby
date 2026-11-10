import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty, vendor } from "~/server/db/schema";
import { publishRunFinding } from "~/server/domains/run/repo/run-finding";
import {
  loadCarrierHistory,
  carrierClaimsConflict,
  resolveCarrierName,
  carrierFormatEvidence,
} from "~/server/domains/shipment/repo/carrier-evidence";
import { normalizeTrackingNumber } from "~/server/domains/shipment/repo/carrier-recognition";
import { constraintViolation } from "~/server/errors/app-error";

import { deduplicateShipmentTrackingReferences } from "./carrier-references";
import {
  assertPurchaseSourceOwner,
  automaticPurchaseAssociation,
  canonicalDigest,
  canonicalShipment,
  projectCarrierReferences,
  retainedPackageShipment,
} from "./evidence-internal";
import { loadIdentityCandidates } from "./evidence-packet-load";
import {
  identityWindowSchema,
  planPacketAdmission,
  planCarrierCorrection,
} from "./evidence-packet-plan";
import type { prepareShipmentPacket } from "./evidence-packet-prepare";
import type { PacketContext, PacketState } from "./evidence-packet-stage";
import type { ShipmentWritePlan } from "./evidence-shipment-application";
// oxlint-disable-next-line complexity -- Candidate locks and evidence revalidation follow the shipment transaction order.
export async function resolveShipmentAdmission(
  tdb: Database,
  context: PacketContext,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareShipmentPacket>>>,
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
    submitted,
  } = context;
  const { unresolvedPackages } = state;
  const database = getDb(tdb);
  const {
    packet,
    suggestion,
    number,
    packageKey,
    binding,
    sourceBindingAmbiguous,
    extraTrackingNumbers,
    references,
    effectiveObservations,
  } = prepared;
  let { row } = prepared;
  const { carrier } = prepared;
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
        evidenceFingerprint: await canonicalDigest({
          sourceKey,
          packageKey,
          packet: submitted,
        }),
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
  const assignment: ShipmentWritePlan["assignment"] = row
    ? { kind: "update", row, purchaseId: acceptedPurchaseId, projection }
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
  return {
    assignment,
    binding,
    sourceKey,
    packageKey,
  } satisfies ShipmentWritePlan;
}
