import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { renderOptionCell } from "~/entity/table/column-helpers";

import type { EntityDetailFieldRenderers } from "./index";

export const ledgerTransferDetailFields = {
  "ledger-transfer-classification": (transfer) => ({
    value: renderOptionCell(
      transfer.classification,
      fieldEnumOptions("ledgerTransfer", "classification"),
    ),
  }),
} satisfies EntityDetailFieldRenderers<"ledgerTransfer">;
