import { shipmentContract } from "~/contracts/shipment.contract";
import {
  recordShipmentEvidence,
  associateShipment,
  mergeShipment,
  reassignShipmentEvidence,
} from "~/server/domains/shipment/repo/evidence";
import { readShipmentTimeline } from "~/server/domains/shipment/repo/timeline";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const shipmentHandlers = implementOperationDomain(shipmentContract, {
  reassign: (context, input) =>
    reassignShipmentEvidence(context.db, input, context.actorContext),
  record: (context, input) =>
    recordShipmentEvidence(context.db, input, context.actorContext),
  associate: (context, input) =>
    associateShipment(context.db, input, context.actorContext),
  merge: (context, input) =>
    mergeShipment(context.db, input, context.actorContext),
  timeline: (context, input) =>
    readShipmentTimeline(context.db, input.shipmentId),
});
