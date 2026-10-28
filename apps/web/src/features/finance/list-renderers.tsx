import { fieldValueOf } from "@cubby/schemas/field-envelope";

import { PossibleVendor } from "~/features/finance/possible-vendor";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { NoneValue } from "~/ui/primitives/none-value";

import type { ListRenderer } from "../../entity/display/list-renderer-types";

const possibleVendor: ListRenderer<"financialTransaction"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor(
        (row) => {
          const effectiveRowVendorInference = fieldValueOf(
            row.fields.vendorInference,
          );
          return effectiveRowVendorInference;
        },
        {
          id: "vendorInference",
          header: "Statement vendor",
          enableSorting: false,
          meta: { className: "w-48", mobile: { slot: "hidden" } },
          cell: (info) =>
            info.getValue() ? (
              <PossibleVendor inference={info.getValue()} compact />
            ) : (
              <NoneValue />
            ),
        },
      ),
    );
  });

export const financialTransactionListRenderers = {
  "possible-vendor": possibleVendor,
} as const;
