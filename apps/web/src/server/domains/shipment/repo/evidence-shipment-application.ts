import type { ActorContext } from "@cubby/schemas/context";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { shipment, shipmentSourcePackage } from "~/server/db/schema";

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
  const { appendShipmentHeader } =
    await import("~/server/domains/shipment/repo/shipment-mutations");
  const row = await appendShipmentHeader(
    db,
    {
      sourceKey: plan.sourceKey,
      packageKey: plan.packageKey,
      ...(plan.assignment.kind === "create"
        ? { values: plan.assignment.values }
        : {
            shipmentId: plan.assignment.row.id,
            values: {
              purchaseId: plan.assignment.purchaseId,
              ...plan.assignment.projection,
            },
          }),
    },
    actor,
  );
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
