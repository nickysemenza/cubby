import { shipmentTrackingReport } from "~/server/domains/shipment/repo/report-shipment";
import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";

export const reportBindings = {
  "shipment.tracking": reportBuilder(shipmentTrackingReport),
};
