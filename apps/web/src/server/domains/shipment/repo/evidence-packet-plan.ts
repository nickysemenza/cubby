import type { ShipmentEvidence } from "@cubby/schemas/shipment-evidence";
import { SHIPMENT_IDENTITY_PERIOD_DAYS } from "@cubby/schemas/shipment-fields";
import { z } from "zod";

import type { shipment, shipmentSourcePackage } from "~/server/db/schema";

export const identityCandidateSchema = z.object({
  id: z.uuid(),
  shortcode: z.string(),
  purchase_id: z.uuid().nullable(),
  first_day: z.string().nullable(),
  last_day: z.string().nullable(),
  carrier_conflict: z.boolean(),
});
export const identityWindowSchema = z.object({
  first: z.string().nullable(),
  last: z.string().nullable(),
});
export const withinIdentityPeriod = (days: readonly (string | null)[]) => {
  const dates = days
    .filter((day) => day !== null)
    .map((day) => Date.parse(day));
  return (
    dates.length > 0 &&
    Math.max(...dates) - Math.min(...dates) <=
      SHIPMENT_IDENTITY_PERIOD_DAYS * 86400000
  );
};

/** The live Shipment another retained source links to the same parcel. Each candidate
 * must fit this packet before it counts: a parcel id reused in a separate period is no
 * rival. None fits: a separate Shipment. Several fit, or any fitting Shipment lists the
 * same items under another parcel number: "ambiguous", never a guess.
 */
export function planPacketAdmission(input: {
  row: typeof shipment.$inferSelect | undefined;
  identity: {
    window: z.infer<typeof identityWindowSchema>;
    candidates: z.infer<typeof identityCandidateSchema>[];
  };
  references: readonly { number: string; carrier: string | null }[];
  packet: Pick<ShipmentEvidence, "distinctPackageEvidence">;
  purchaseId: (typeof shipment.$inferSelect)["purchaseId"];
  existingDates: z.infer<typeof identityWindowSchema> | null;
  carrierIssue: string | null;
  retainedPackageAmbiguous: boolean;
  correctingCarrier: boolean;
  projectedCollision: boolean;
}) {
  const {
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
  } = input;
  const possible = identity.candidates.filter(
    (candidate) =>
      candidate.id !== row?.id && (!row || !candidate.carrier_conflict),
  );
  const candidate = !row && possible.length === 1 ? possible[0] : undefined;
  let ambiguity: string | null =
    carrierIssue ??
    (retainedPackageAmbiguous
      ? "Retained sources cannot prove which nearby Shipment is this linked parcel; review them before associating it."
      : null);
  if (
    !row &&
    possible.length > 0 &&
    references.length &&
    packet.distinctPackageEvidence
  )
    ambiguity =
      "A separate-package claim under a tracking reference requires member review; the source is retained without creating another Shipment.";
  else if (
    references.length &&
    (!identity.window.first ||
      !withinIdentityPeriod([identity.window.first, identity.window.last]))
  )
    ambiguity =
      "Tracking identity needs non-estimated source-event dates within one 60-day period.";
  else if (
    references.length &&
    existingDates &&
    (!existingDates.first ||
      !withinIdentityPeriod([
        identity.window.first,
        identity.window.last,
        existingDates.first,
        existingDates.last,
      ]))
  )
    ambiguity =
      "The proposed evidence spans separate shipping periods; review its source-package association.";
  else if (possible.length > (row ? 0 : 1))
    ambiguity =
      "Multiple nearby Shipments share this tracking reference; review and merge the retained evidence.";
  else if (
    candidate &&
    (candidate.carrier_conflict ||
      !candidate.first_day ||
      !withinIdentityPeriod([
        identity.window.first,
        identity.window.last,
        candidate.first_day,
        candidate.last_day,
      ]) ||
      (purchaseId &&
        candidate.purchase_id &&
        candidate.purchase_id !== purchaseId))
  )
    ambiguity =
      "Nearby tracking evidence has conflicting carrier, Purchase, or shipping-period identity; review it before association.";
  if (correctingCarrier && (possible.length || projectedCollision))
    ambiguity =
      "Carrier correction collides with another Shipment identity; review without automatic merging.";
  return { candidate, ambiguity };
}

export function sourcePackageSpelling(key: string) {
  return key.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, "") || key;
}

type SourcePackage = typeof shipmentSourcePackage.$inferSelect;
export function planSourceBinding(
  sourcePackages: readonly SourcePackage[],
  packageKey: string,
) {
  const respelled = sourcePackages.filter(
    (known) =>
      sourcePackageSpelling(known.packageKey) ===
      sourcePackageSpelling(packageKey),
  );
  const binding =
    sourcePackages.find((known) => known.packageKey === packageKey) ??
    (respelled.length === 1 ? respelled[0] : undefined);
  return { binding, ambiguous: !binding && respelled.length > 1 };
}
export function planAliasBinding(
  bindings: readonly { binding: SourcePackage }[],
) {
  const unique = [
    ...new Map(bindings.map(({ binding }) => [binding.id, binding])).values(),
  ];
  return {
    binding: unique.length === 1 ? unique[0] : undefined,
    ambiguous: unique.length > 1,
  };
}
