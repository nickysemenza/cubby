import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { shipment, shipmentObservation, vendor } from "~/server/db/schema";
import {
  assessCarrierPacket,
  withoutDeliveryFieldCarrier,
} from "~/server/domains/shipment/repo/carrier-evidence";
import { normalizeTrackingNumber } from "~/server/domains/shipment/repo/carrier-recognition";
import { constraintViolation } from "~/server/errors/app-error";

import {
  canonicalShipment,
  carrierReference,
  assertShipmentAssociation,
} from "./evidence-internal";
import { loadCaptureObservationIds } from "./evidence-observation-load";
import {
  planObservationRevision,
  planPacketObservationIdentities,
} from "./evidence-observation-plan";
import {
  loadSourcePackages,
  loadAliasBindings,
  loadRetiredPackage,
} from "./evidence-packet-load";
import { planSourceBinding, planAliasBinding } from "./evidence-packet-plan";
import type { PacketContext, PacketState } from "./evidence-packet-stage";
// oxlint-disable-next-line complexity -- Source bindings and carrier references are revalidated under the shipment lock.
export async function prepareShipmentPacket(
  tdb: Database,
  context: PacketContext,
  state: PacketState,
) {
  const {
    capture,
    sourceKey,
    purchaseId,
    observedAt,
    sourceEvidence,
    deliveryCodes,
    submitted,
  } = context;
  const { unresolvedPackages } = state;
  const database = getDb(tdb);
  // Keys, fingerprints and observation identities keep the submitted hints, so
  // retained extractions replay onto their existing bindings and revisions.
  const extraHints: typeof submitted.extraTrackingNumbers = [];
  for (const extra of submitted.extraTrackingNumbers)
    extraHints.push(
      await withoutDeliveryFieldCarrier(tdb, extra, deliveryCodes),
    );
  const packet = {
    ...submitted,
    ...(await withoutDeliveryFieldCarrier(
      tdb,
      {
        carrierId: submitted.carrierId,
        carrierName: submitted.carrierName,
      },
      deliveryCodes,
    )),
    extraTrackingNumbers: extraHints,
  };
  if (packet.carrierId)
    await carrierReference(tdb, packet.carrierId, packet.carrierName);
  const suggestion = await assessCarrierPacket(tdb, packet, sourceEvidence);
  // Explicit source attribution wins over extraction; normal extracted Vendor names
  // still populate a new/missing carrier without a separate proof ledger.
  let carrier = suggestion.primary.carrier
    ? await carrierReference(tdb, suggestion.primary.carrier.code, null)
    : packet.carrierClaims?.some(
          (claim) =>
            claim.role === "intermediary" &&
            normalizeTrackingNumber(claim.trackingNumber) ===
              normalizeTrackingNumber(packet.trackingNumber ?? ""),
        )
      ? { id: null, code: null }
      : await carrierReference(tdb, packet.carrierId, packet.carrierName);
  const number = packet.trackingNumber
    ? normalizeTrackingNumber(packet.trackingNumber)
    : null;
  const packageKey =
    packet.sourceShipmentKey ??
    packet.shipmentId ??
    `${submitted.carrierId ?? submitted.carrierName ?? "unknown"}:${number}`;
  let row = packet.shipmentId
    ? await canonicalShipment(tdb, packet.shipmentId)
    : undefined;
  const sourcePackages = await loadSourcePackages(tdb, sourceKey);
  const sourceBinding = planSourceBinding(sourcePackages, packageKey);
  let binding = sourceBinding.binding;
  let sourceBindingAmbiguous = sourceBinding.ambiguous;
  if (!binding && !packet.sourceShipmentKey && number) {
    const aliasBindings = await loadAliasBindings(tdb, sourceKey, number);
    const aliasBinding = planAliasBinding(aliasBindings);
    binding = aliasBinding.binding;
    sourceBindingAmbiguous ||= aliasBinding.ambiguous;
  }
  // Re-extraction can rename a retired template to any key. Tracked siblings still
  // apply; an unbound trackingless packet in this source stays visible instead.
  if (!binding && !row && !number && sourcePackages.length) {
    const retired = await loadRetiredPackage(tdb, sourcePackages);
    if (retired) {
      unresolvedPackages.push({
        sourceShipmentKey: packet.sourceShipmentKey,
        reason:
          "This source has a retired package; review this trackingless packet before creating another Shipment.",
      });
      return;
    }
  }
  if (binding) {
    const [bound] = await database
      .select()
      .from(shipment)
      .where(eq(shipment.id, binding.shipmentId));
    if (!bound)
      return constraintViolation("The source package reference is missing.");
    // Merges and reassignment move bindings, so a deleted target is a member's
    // retirement. The capture stays; sibling packets in this source still apply.
    if (bound.deletedAt && !row) {
      unresolvedPackages.push({
        sourceShipmentKey: packet.sourceShipmentKey,
        reason:
          "This source package was retired; its original source remains retained and no Shipment was restored.",
      });
      return;
    }
    const resolved = await canonicalShipment(tdb, bound.shortcode);
    if (row && row.id !== resolved.id)
      return constraintViolation(
        "This source package already belongs to another Shipment; explicitly reassign it.",
      );
    row = resolved;
  }
  if (row && purchaseId)
    await assertShipmentAssociation(tdb, row.id, purchaseId);
  const [boundCarrier] =
    row?.carrierId && binding
      ? await database
          .select({ code: vendor.shortcode, name: vendor.name })
          .from(vendor)
          .where(eq(vendor.id, row.carrierId))
      : [];
  // Replay follows the existing package assignment; an unsubstantiated re-extraction
  // cannot restore an old guess or invent an additional handoff.
  if (boundCarrier && row && !suggestion.primary.carrier)
    carrier = {
      id: row.carrierId,
      code: parseShortcodeFor("vendor", boundCarrier.code),
    };
  const extraTrackingNumbers = [];
  for (const extra of packet.extraTrackingNumbers) {
    const number = normalizeTrackingNumber(extra.trackingNumber);
    const supported = suggestion.forReference(number).carrier;
    const retained =
      binding && row
        ? [
            ...(row.trackingNumber &&
            normalizeTrackingNumber(row.trackingNumber) === number &&
            boundCarrier
              ? [
                  {
                    carrierId: parseShortcodeFor("vendor", boundCarrier.code),
                    carrierName: boundCarrier.name,
                  },
                ]
              : []),
            ...row.extraTrackingNumbers.filter(
              (ref) =>
                normalizeTrackingNumber(ref.trackingNumber) === number &&
                ref.carrierId,
            ),
          ]
        : [];
    const known = [...new Set(retained.map((ref) => ref.carrierId))];
    const intermediary = packet.carrierClaims?.some(
      (claim) =>
        claim.role === "intermediary" &&
        normalizeTrackingNumber(claim.trackingNumber) === number,
    );
    const reference = supported
      ? await carrierReference(tdb, supported.code, null)
      : retained.length
        ? { code: known.length === 1 ? (known[0] ?? null) : null }
        : intermediary
          ? { code: null }
          : await carrierReference(tdb, extra.carrierId, extra.carrierName);
    extraTrackingNumbers.push({
      carrierId: reference.code,
      carrierName:
        supported?.name ?? retained[0]?.carrierName ?? extra.carrierName,
      trackingNumber: number,
    });
  }
  const primaryCarrierCode =
    carrier.code ??
    (row?.trackingNumber &&
    normalizeTrackingNumber(row.trackingNumber) === number
      ? (boundCarrier?.code ?? null)
      : null);
  const references = [
    ...(number ? [{ number, carrier: primaryCarrierCode }] : []),
    ...extraTrackingNumbers.map((ref) => ({
      number: ref.trackingNumber,
      carrier: ref.carrierId,
    })),
  ];
  const history = binding
    ? await database
        .select()
        .from(shipmentObservation)
        .where(eq(shipmentObservation.sourcePackageId, binding.id))
    : [];
  const supported = await loadCaptureObservationIds(tdb, capture.id, history);
  const identified = await planPacketObservationIdentities(
    supported,
    packet.observations,
    history,
  );
  const effectiveObservations = [];
  for (const key of identified) {
    const { observation } = key;
    const versions = history
      .filter((version) => version.occurrenceKey === key.occurrenceKey)
      .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
    const current = versions.find((version) => !version.supersededById);
    const { keepCurrent } = planObservationRevision({
      versions,
      current,
      fingerprint: key.fingerprint,
      literalFingerprint: key.literalFingerprint,
      observedAt,
      revisesFromSameCapture: key.revisesFromSameCapture,
    });
    // Period admission uses the revision replay will retain.
    effectiveObservations.push(
      keepCurrent && current ? current.event : observation,
    );
  }
  return {
    packet,
    suggestion,
    carrier,
    number,
    packageKey,
    row,
    binding,
    sourceBindingAmbiguous,
    extraTrackingNumbers,
    references,
    identified,
    effectiveObservations,
  };
}
