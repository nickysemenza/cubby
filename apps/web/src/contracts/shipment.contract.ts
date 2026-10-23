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

export const shipmentContract = defineContract(
  "shipment",
  {
    edit_observation: mutation({
      description:
        "Partially edit one retained observation using its observationId from shipments_read.timeline and current Shipment reference. Supply only changed fields in patch; omitted fields and source identity remain unchanged. Appends a reviewed revision, retains original captures and history, and protects it from source replay. A superseded observation refuses a different edit; read the current revision first. Interactive members only.",
      nativeModels: { input: "json", output: "json" },
      input: editShipmentObservationInput,
      output: shipmentReferenceOut,
      invalidates: ["shipment", "purchase"],
    }),
    reassign: mutation({
      description:
        "Explicitly move a misassociated source package and all its retained tracking observations to another Shipment. Use sourcePackageId from shipments_read.timeline; replay follows the corrected association.",
      input: reassignShipmentEvidenceInput,
      output: shipmentReferenceOut,
      invalidates: ["shipment", "purchase"],
    }),
    record: mutation({
      description:
        "Record shipment observations from an owned retained Email/checksum, an interactive tracking-page capture, or an exported SMS. Keep unmatched packages; never invent a Purchase. Carrier references are Vendors. Label creation or vendor shipped wording does not prove carrier possession. Repeated identical observations update first/last seen; all distinct sources and revisions remain retained.",
      nativeModels: { input: "json", output: "json" },
      input: recordShipmentEvidenceInput,
      output: recordShipmentEvidenceOut,
      invalidates: ["shipment", "purchase"],
    }),
    associate: mutation({
      description:
        "Explicitly attach, detach or correct a Shipment's Purchase association. No financial or inventory effects.",
      input: associateShipmentInput,
      output: shipmentReferenceOut,
      invalidates: ["shipment", "purchase"],
    }),
    merge: mutation({
      description:
        "Explicitly merge two proven duplicate packages, retaining observations and the old SHIP reference. Conflicting Purchase associations require correction first.",
      input: mergeShipmentInput,
      output: shipmentReferenceOut,
      invalidates: ["shipment", "purchase"],
    }),
    timeline: query({
      description:
        "Read every retained source observation and the deduplicated timeline. Exact durations require exact endpoints; missing or conflicting evidence remains unknown.",
      nativeModels: { output: "json" },
      input: shipmentTimelineInput,
      output: shipmentTimelineOut,
      readPolicy: "strong",
      cache: { tags: [["shipment.timeline"]] },
    }),
  },
  { exposure: "capability", mcpToolGroup: "shipments" },
);
