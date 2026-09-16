import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { ledgerTransferClassificationOptions } from "~/app/finance/ledger-transfer-columns";

import type { EntityDetailFieldRenderers } from "./index";

export const ledgerTransferDetailFields = {
  classification: (transfer) => ({
    value: renderOptionCell(
      transfer.classification,
      ledgerTransferClassificationOptions,
    ),
  }),
} satisfies EntityDetailFieldRenderers<"ledgerTransfer">;
