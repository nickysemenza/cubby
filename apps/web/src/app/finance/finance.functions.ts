import { financialAccountOptionsOut } from "@cubby/schemas/financial-account";
import { financialTransactionSourceOptionsOut } from "@cubby/schemas/financial-transaction";
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

export const financialTransaction = defineOperationDomain(
  "financialTransaction",
  {
    sourceOptions: query({
      input: z.null(),
      output: financialTransactionSourceOptionsOut,
      tags: [["financialTransaction", "sourceOptions"]],
    }),
  },
);
