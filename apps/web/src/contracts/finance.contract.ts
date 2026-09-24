import { financialAccountOptionsOut } from "@cubby/schemas/financial-account";
import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionSourceOptionsOut,
  merchantVendorInference,
  merchantVendorInferenceInput,
} from "@cubby/schemas/financial-transaction";
import { ledgerPartyOptionsOut } from "@cubby/schemas/ledger-party";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const financialAccountContract = defineContract("financialAccount", {
  options: query({
    input: z.null(),
    output: financialAccountOptionsOut,
  }),
});

export const ledgerPartyContract = defineContract("ledgerParty", {
  options: query({
    input: z.null(),
    output: ledgerPartyOptionsOut,
  }),
});

export const financialTransactionContract = defineContract(
  "financialTransaction",
  {
    previewStatementImport: query({
      input: financialStatementImportPreviewInput,
      output: financialStatementImportPreviewOut,
    }),
    sourceOptions: query({
      input: z.null(),
      output: financialTransactionSourceOptionsOut,
    }),
    vendorInference: query({
      input: merchantVendorInferenceInput,
      output: merchantVendorInference,
    }),
  },
);
