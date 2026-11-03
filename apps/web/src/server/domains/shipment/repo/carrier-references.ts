import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor, type VendorId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { shipment, vendor } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";

export async function deduplicateShipmentTrackingReferences(
  db: RepositoryQueryInput,
  row: Pick<
    typeof shipment.$inferSelect,
    "trackingNumber" | "carrierId" | "extraTrackingNumbers"
  >,
) {
  const [carrier] = row.carrierId
    ? await repositoryQueries(db)
        .select({ code: vendor.shortcode })
        .from(vendor)
        .where(eq(vendor.id, row.carrierId))
    : [];
  const normalize = (number: string) =>
    number.replaceAll(/\s/g, "").toUpperCase();
  const primary = row.trackingNumber ? normalize(row.trackingNumber) : null;
  const knownNumbers = new Set(
    row.extraTrackingNumbers
      .filter((ref) => ref.carrierId)
      .map((ref) => normalize(ref.trackingNumber)),
  );
  const unique = new Map<string, (typeof row.extraTrackingNumbers)[number]>();
  for (const ref of row.extraTrackingNumbers) {
    const number = normalize(ref.trackingNumber);
    // Carrier wording is evidence, not a second reference. Distinct known carriers
    // remain separate because they can identify a real carrier handoff.
    if (
      number === primary &&
      (!ref.carrierId || ref.carrierId === carrier?.code)
    )
      continue;
    if (!ref.carrierId && knownNumbers.has(number)) continue;
    const key = JSON.stringify([number, ref.carrierId]);
    const previous = unique.get(key);
    if (!previous || (!previous.carrierName && ref.carrierName))
      unique.set(key, { ...ref, trackingNumber: number });
  }
  return [...unique.values()];
}

const references = (codes: string[]) =>
  sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${shipment.extraTrackingNumbers}) reference WHERE reference->>'carrierId' IN (${sql.join(
    codes.map((code) => sql`${code}`),
    sql`, `,
  )}))`;

export async function assertShipmentCarrierDeletionAllowed(
  tx: DrizzleTransaction,
  ids: VendorId[],
) {
  const carriers = await tx
    .select({ shortcode: vendor.shortcode })
    .from(vendor)
    .where(inArray(vendor.id, ids));
  if (!carriers.length) return;
  const [used] = await tx
    .select({ id: shipment.id })
    .from(shipment)
    .where(
      and(
        notDeleted(shipment),
        references(carriers.map((row) => row.shortcode)),
      ),
    )
    .limit(1);
  if (used)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A Shipment's extra tracking references retain this carrier Vendor.",
    );
}

export async function repointShipmentCarrierReferences(
  tx: DrizzleTransaction,
  keepId: VendorId,
  loserIds: VendorId[],
  actor: ActorContext,
) {
  const carriers = await tx
    .select({ id: vendor.id, shortcode: vendor.shortcode })
    .from(vendor)
    .where(inArray(vendor.id, [keepId, ...loserIds]));
  const keeper = carriers.find((row) => row.id === keepId);
  if (!keeper) throw new Error("Carrier merge survivor is missing.");
  const codes = carriers
    .filter((row) => row.id !== keepId)
    .map((row) => row.shortcode);
  if (!codes.length) return;
  const rows = await tx
    .select()
    .from(shipment)
    .where(and(notDeleted(shipment), references(codes)))
    .for("update");
  for (const row of rows) {
    const references = row.extraTrackingNumbers.map((reference) =>
      reference.carrierId && codes.includes(reference.carrierId)
        ? {
            ...reference,
            carrierId: parseShortcodeFor("vendor", keeper.shortcode),
          }
        : reference,
    );
    const updated = await deduplicateShipmentTrackingReferences(tx, {
      ...row,
      carrierId:
        row.carrierId && loserIds.includes(row.carrierId)
          ? keepId
          : row.carrierId,
      extraTrackingNumbers: references,
    });
    await tx
      .update(shipment)
      .set({ extraTrackingNumbers: updated })
      .where(eq(shipment.id, row.id));
    await logAuditEntries(tx, actor, [
      {
        entityKind: "shipment",
        entityId: row.id,
        action: "update",
        changes: {
          extraTrackingNumbers: { from: row.extraTrackingNumbers, to: updated },
        },
      },
    ]);
  }
}
