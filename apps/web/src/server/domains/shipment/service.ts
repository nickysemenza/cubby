import { shipmentCaptureEvidence } from "~/server/domains/shipment/repo/source-evidence";
import { defineModule } from "~/server/kernel/api";

export const shipmentKernelModule = defineModule({
  name: "shipment",
  entities: ["shipment"],
  evidence: [shipmentCaptureEvidence],
});
