import {
  shipmentEvent,
  shipmentPackageEvidence,
} from "~/server/domains/shipment/repo/shipment-event";
import { shipmentCaptureEvidence } from "~/server/domains/shipment/repo/source-evidence";
import { defineModule } from "~/server/kernel/api";

export const shipmentKernelModule = defineModule({
  name: "shipment",
  entities: ["shipment"],
  evidence: [shipmentCaptureEvidence, shipmentPackageEvidence],
  reconcilers: [shipmentEvent],
  machinery: [
    { entity: "shipment", owning: "shipment", fields: false, quality: false },
  ],
});
