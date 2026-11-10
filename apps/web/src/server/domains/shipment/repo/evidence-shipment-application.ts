import type { ActorContext } from "@cubby/schemas/context";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { shipment, shipmentSourcePackage } from "~/server/db/schema";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

type Shipment = typeof shipment.$inferSelect;

export type ShipmentWritePlan = {
  assignment:
    | {
        kind: "create";
        values: Pick<
          typeof shipment.$inferInsert,
          | "name"
          | "purchaseId"
          | "carrierId"
          | "trackingNumber"
          | "extraTrackingNumbers"
          | "purpose"
        >;
      }
    | {
        kind: "update";
        row: Shipment;
        purchaseId: Shipment["purchaseId"];
        projection: Pick<
          Shipment,
          "carrierId" | "trackingNumber" | "extraTrackingNumbers"
        > | null;
      };
  binding: typeof shipmentSourcePackage.$inferSelect | undefined;
  sourceKey: string;
  packageKey: string;
};

export async function applyShipmentWrite(
  db: Database,
  actor: ActorContext,
  plan: ShipmentWritePlan,
) {
  const database = getDb(db);
  let row;
  if (plan.assignment.kind === "create") {
    row = await insertWithShortcode(db, "shipment", plan.assignment.values);
    await logAuditEntries(db, actor, [
      {
        entityKind: "shipment",
        entityId: row.id,
        action: "create",
        changes: {
          name: { from: null, to: row.name },
          carrierId: { from: null, to: row.carrierId },
        },
      },
    ]);
  } else {
    const { row: existing, purchaseId, projection } = plan.assignment;
    row = existing;
    await database
      .update(shipment)
      .set({ purchaseId, ...projection })
      .where(eq(shipment.id, row.id));
    if (projection && projection.carrierId !== row.carrierId)
      await logAuditEntries(db, actor, [
        {
          entityKind: "shipment",
          entityId: row.id,
          action: "update",
          changes: {
            carrierId: { from: row.carrierId, to: projection.carrierId },
          },
        },
      ]);
  }
  const sourcePackage =
    plan.binding ??
    (
      await database
        .insert(shipmentSourcePackage)
        .values({
          shipmentId: row.id,
          sourceKey: plan.sourceKey,
          packageKey: plan.packageKey,
        })
        .returning()
    )[0];
  if (!sourcePackage)
    throw new Error("Source package identity was not retained.");
  return { row, sourcePackage };
}
