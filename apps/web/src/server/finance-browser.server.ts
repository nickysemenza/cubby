import {
  financialAccountContract,
  financialTransactionContract,
  ledgerPartyContract,
} from "~/contracts/finance.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  financialAccountOptionsWorkflow,
  financialTransactionSourceOptionsWorkflow,
  ledgerPartyOptionsWorkflow,
  merchantVendorInferenceWorkflow,
} from "~/server/workflows/finance.server";

export const financialAccountHandlers = implementOperationDomain(
  financialAccountContract,
  {
    options: (context) => financialAccountOptionsWorkflow(context.readDb),
  },
);

export const ledgerPartyHandlers = implementOperationDomain(
  ledgerPartyContract,
  {
    options: (context) => ledgerPartyOptionsWorkflow(context.readDb),
  },
);

export const financialTransactionHandlers = implementOperationDomain(
  financialTransactionContract,
  {
    sourceOptions: (context) =>
      financialTransactionSourceOptionsWorkflow(context.readDb),
    vendorInference: (context, input) =>
      merchantVendorInferenceWorkflow(context.readDb, input),
  },
);
