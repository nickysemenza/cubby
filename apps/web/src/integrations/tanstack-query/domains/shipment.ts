import { shipmentContract } from "~/contracts/shipment.contract";

import { defineOperationDomain } from "../operation-catalog";

export const shipment = /* @__PURE__ */ defineOperationDomain(shipmentContract);
