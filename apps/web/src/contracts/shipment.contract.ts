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
    native: "Correct retained shipment observations from the CLI",
    nativeModels: { input: "json", output: "json" },
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
    native: "Record source-backed shipment evidence from the CLI",
    nativeModels: { input: "json", output: "json" },
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
    native: "Verify retained shipment evidence from the CLI",
    nativeModels: { output: "json" },
    input: shipmentTimelineInput,
    output: shipmentTimelineOut,
    readPolicy: "strong",
    cache: { tags: [["shipment.timeline"]] },
  }),
});
