import { NoneValue } from "~/ui/text/none-value";

import type { EntityDetailFieldRenderers } from "./index";

export const shipmentDetailFields = {
  /** The order a Shipment's notice named, shown as unresolved while no Purchase holds it. */
  "shipment-order": (shipment) => {
    const orderId = shipment.orderId;
    if (!orderId) return { value: <NoneValue /> };
    return {
      value: shipment.purchaseId ? (
        <span className="font-mono break-all">{orderId}</span>
      ) : (
        <span className="min-w-0 break-words">
          Not linked — waiting on order{" "}
          <span className="font-mono break-all">{orderId}</span>
        </span>
      ),
    };
  },
} satisfies EntityDetailFieldRenderers<"shipment">;
