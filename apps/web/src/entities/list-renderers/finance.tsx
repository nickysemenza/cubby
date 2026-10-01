import { createCubbyColumnCollection } from "~/app/_components/data-table/table-features";
import { PossibleVendor } from "~/app/finance/possible-vendor";
import { NoneValue } from "~/components/ui/none-value";

import type { ListRenderer } from "../list-renderer-types";

const possibleVendor: ListRenderer<"financialTransaction"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor("vendorInference", {
        id: "vendorInference",
        header: "Possible vendor",
        enableSorting: false,
        meta: { className: "w-48", mobile: { slot: "hidden" } },
        cell: (info) =>
          info.getValue() ? (
            <PossibleVendor inference={info.getValue()} compact />
          ) : (
            <NoneValue />
          ),
      }),
    );
  });

export const financialTransactionListRenderers = {
  "possible-vendor": possibleVendor,
} as const;
