import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { fieldEnumOptions } from "~/entities/enum-field-display";

import type { EntityDetailFieldRenderers } from "./index";

export const ledgerTransferDetailFields = {
  "ledger-transfer-classification": (transfer) => ({
    value: renderOptionCell(
      transfer.classification,
      fieldEnumOptions("ledgerTransfer", "classification"),
    ),
  }),
} satisfies EntityDetailFieldRenderers<"ledgerTransfer">;
