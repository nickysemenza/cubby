import { createSingleEntityInlineLinkColumn } from "~/app/_components/data-table/columnHelpers";
import { createCubbyColumnCollection } from "~/app/_components/data-table/table-features";
import { InventoryValuationSummary } from "~/app/_components/locations/inventory-valuation-summary";

import type { ListRenderer } from "../list-renderer-types";

// The Product a location IS ("Is a"): a bin or fixture that is itself a
// catalogued Product.
const productLink: ListRenderer<"location"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      createSingleEntityInlineLinkColumn(helper, "product", "product", {
        header: "Is a",
        className: "w-56",
        mobile: { slot: "meta", priority: 40 },
      }),
    );
  });

const valuationSummary: ListRenderer<"location"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor((row) => row.valuation?.directValuation ?? null, {
        id: "valuation",
        header: "Valuation",
        cell: (info) => (
          <InventoryValuationSummary
            valuation={info.row.original.valuation}
            variant="compact"
          />
        ),
        meta: {
          className: "w-[180px]",
          numeric: true,
          mobile: { slot: "trailing", priority: 10 },
        },
      }),
    );
  });

export const locationListRenderers = {
  "product-link": productLink,
  "valuation-summary": valuationSummary,
} as const;
