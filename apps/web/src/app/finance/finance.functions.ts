import { financialAccountOptionsOut } from "@cubby/schemas/financial-account";
import {
  financialTransactionSourceOptionsOut,
  merchantVendorInference,
  merchantVendorInferenceInput,
} from "@cubby/schemas/financial-transaction";
import { ledgerPartyOptionsOut } from "@cubby/schemas/ledger-party";
import { z } from "zod";

import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const financialAccount = defineOperationDomain("financialAccount", {
  options: query({
    input: z.null(),
    output: financialAccountOptionsOut,
    tags: [["financialAccount", "options"]],
  }),
});

export const ledgerParty = defineOperationDomain("ledgerParty", {
  options: query({
    input: z.null(),
    output: ledgerPartyOptionsOut,
    tags: [["ledgerParty", "options"]],
  }),
});

export const financialTransaction = defineOperationDomain(
  "financialTransaction",
  {
    sourceOptions: query({
      input: z.null(),
      output: financialTransactionSourceOptionsOut,
      tags: [["financialTransaction", "sourceOptions"]],
    }),
    vendorInference: query({
      input: merchantVendorInferenceInput,
      output: merchantVendorInference,
      tags: [["financialTransaction"], ["purchase"], ["vendor"]],
    }),
  },
);
