import type { shipment, shipmentSourcePackage } from "~/server/db/schema";

type Shipment = typeof shipment.$inferSelect;
type Binding = typeof shipmentSourcePackage.$inferSelect;
type Projection = Pick<
  Shipment,
  "carrierId" | "trackingNumber" | "extraTrackingNumbers"
>;
type Create = Pick<
  typeof shipment.$inferInsert,
  | "name"
  | "purchaseId"
  | "carrierId"
  | "trackingNumber"
  | "extraTrackingNumbers"
  | "purpose"
>;

export function planShipmentWrite(input: {
  assignment:
    | { kind: "create"; values: Create }
    | { kind: "update"; row: Shipment };
  purchaseId: Shipment["purchaseId"];
  projection: Projection | null;
  binding: Binding | undefined;
  sourceKey: string;
  packageKey: string;
}) {
  const assignment =
    input.assignment.kind === "update"
      ? {
          kind: "update" as const,
          row: input.assignment.row,
          purchaseId: input.purchaseId,
          projection: input.projection,
        }
      : input.assignment;
  return {
    assignment,
    binding: input.binding,
    sourceKey: input.sourceKey,
    packageKey: input.packageKey,
  };
}
export type ShipmentWritePlan = ReturnType<typeof planShipmentWrite>;
