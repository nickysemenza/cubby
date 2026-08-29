import {
  financialAccount,
  financialTransaction,
  ledgerParty,
} from "~/app/finance/finance.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  financialAccountOptionsWorkflow,
  financialTransactionSourceOptionsWorkflow,
  ledgerPartyOptionsWorkflow,
  merchantVendorInferenceWorkflow,
} from "~/server/workflows/finance.server";

export const financialAccountHandlers = implementOperationDomain(
  financialAccount,
  {
    options: (context) => financialAccountOptionsWorkflow(context.readDb),
  },
);

export const ledgerPartyHandlers = implementOperationDomain(ledgerParty, {
  options: (context) => ledgerPartyOptionsWorkflow(context.readDb),
});

export const financialTransactionHandlers = implementOperationDomain(
  financialTransaction,
  {
    sourceOptions: (context) =>
      financialTransactionSourceOptionsWorkflow(context.readDb),
    vendorInference: (context, input) =>
      merchantVendorInferenceWorkflow(context.readDb, input),
  },
);
