import { fieldEnumOptions } from "~/entity/enum-field-display";
import { renderOptionCell } from "~/ui/data-table/columnHelpers";

import type { EntityDetailFieldRenderers } from "./index";

export const ledgerTransferDetailFields = {
  "ledger-transfer-classification": (transfer) => ({
    value: renderOptionCell(
      transfer.classification,
      fieldEnumOptions("ledgerTransfer", "classification"),
    ),
  }),
} satisfies EntityDetailFieldRenderers<"ledgerTransfer">;
