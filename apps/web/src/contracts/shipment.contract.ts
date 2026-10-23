import {
  recordShipmentEvidenceInput,
  recordShipmentEvidenceOut,
  associateShipmentInput,
  mergeShipmentInput,
  reassignShipmentEvidenceInput,
  editShipmentObservationInput,
  shipmentReferenceOut,
  shipmentTimelineInput,
  shipmentTimelineOut,
} from "@cubby/schemas/shipment-evidence";

import { defineContract, mutation, query } from "~/contracts/define";

export const shipmentContract = defineContract("shipment", {
  edit_observation: mutation({
    input: editShipmentObservationInput,
    output: shipmentReferenceOut,
    invalidates: ["shipment", "purchase"],
  }),
  reassign: mutation({
    input: reassignShipmentEvidenceInput,
    output: shipmentReferenceOut,
    invalidates: ["shipment", "purchase"],
  }),
  record: mutation({
    input: recordShipmentEvidenceInput,
    output: recordShipmentEvidenceOut,
    invalidates: ["shipment", "purchase"],
  }),
  associate: mutation({
    input: associateShipmentInput,
    output: shipmentReferenceOut,
    invalidates: ["shipment", "purchase"],
  }),
  merge: mutation({
    input: mergeShipmentInput,
    output: shipmentReferenceOut,
    invalidates: ["shipment", "purchase"],
  }),
  timeline: query({
    input: shipmentTimelineInput,
    output: shipmentTimelineOut,
    readPolicy: "strong",
    cache: { tags: [["shipment.timeline"]] },
  }),
});
