import { fieldValueOf } from "@cubby/schemas/field-envelope";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { renderOptionCell } from "~/entity/table/column-helpers";

import type { EntityDetailFieldRenderers } from "./index";

export const ledgerTransferDetailFields = {
  "ledger-transfer-classification": (transfer, queryClient) => {
    const effectiveTransferClassification = fieldValueOf(
      transfer.fields.classification,
    );
    return {
      value: renderOptionCell(
        effectiveTransferClassification,
        fieldEnumOptions(queryClient, "ledgerTransfer", "classification"),
      ),
    };
  },
} satisfies EntityDetailFieldRenderers<"ledgerTransfer">;
