import { NoneValue } from "~/components/ui/none-value";

import type { EntityDetailFieldRenderers } from "./index";

export const vendorDetailFields = {
  agentHints: (vendor) => {
    const hints = vendor.agentHints;
    const parts = [
      hints.ordersListUrl && `Orders: ${hints.ordersListUrl}`,
      hints.pagination && `Pagination: ${hints.pagination}`,
      hints.orderLinkPattern && `Order links: ${hints.orderLinkPattern}`,
      ...hints.notes,
    ].filter((part): part is string => Boolean(part));
    return {
      value:
        parts.length > 0 ? (
          <span className="whitespace-pre-wrap">{parts.join("\n")}</span>
        ) : (
          <NoneValue />
        ),
    };
  },
} satisfies EntityDetailFieldRenderers<"vendor">;
