import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type PurchaseId,
  type ShortcodeFor,
} from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import type { shipmentSourceCapture } from "~/server/db/schema";
import type {
  carrierCaptureEvidence,
  deliveryFieldCodes,
} from "~/server/domains/shipment/repo/carrier-evidence";
import { recordChange } from "~/server/generic/changes/repo/change";

import { resolveShipmentAdmission } from "./evidence-admission-stage";
import type { ShipmentWriterInput } from "./evidence-input";
import { writePacketObservations } from "./evidence-observation-stage";
import { prepareShipmentPacket } from "./evidence-packet-prepare";
import { applyShipmentWrite } from "./evidence-shipment-application";

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
export async function processShipmentPacket(
  tdb: Database,
  context: PacketContext,
  state: PacketState,
) {
  const { actor, capture, sourceKey } = context;
  const { shipmentIds } = state;
  const prepared = await prepareShipmentPacket(tdb, context, state);
  if (!prepared) return;
  const shipmentPlan = await resolveShipmentAdmission(
    tdb,
    context,
    prepared,
    state,
  );
  if (!shipmentPlan) return;
  const applied = await applyShipmentWrite(tdb, actor, shipmentPlan);
  const row = applied.row;
  const sourcePackage = applied.sourcePackage;
  shipmentIds.push(parseShortcodeFor("shipment", row.shortcode));
  await writePacketObservations(
    tdb,
    {
      identified: prepared.identified,
      row,
      sourcePackage,
      capture,
      sourceKey,
      observedAt: context.observedAt,
      deliveryCodes: context.deliveryCodes,
    },
    state,
  );
  await recordChange(tdb, { kind: "source", categories: ["shipment"] });
}
