import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor, type VendorId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import { shipment, vendor } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";

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
    const updated = row.extraTrackingNumbers.map((reference) =>
      reference.carrierId && codes.includes(reference.carrierId)
        ? {
            ...reference,
            carrierId: parseShortcodeFor("vendor", keeper.shortcode),
          }
        : reference,
    );
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
