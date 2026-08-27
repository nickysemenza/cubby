import {
  financialAccount,
  financialTransaction,
} from "~/app/finance/finance.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  financialAccountOptionsWorkflow,
  financialTransactionSourceOptionsWorkflow,
} from "~/server/workflows/finance.server";

export const financialAccountHandlers = implementOperationDomain(
  financialAccount,
  {
    options: (context) => financialAccountOptionsWorkflow(context.readDb),
  },
);

export const financialTransactionHandlers = implementOperationDomain(
  financialTransaction,
  {
    sourceOptions: (context) =>
      financialTransactionSourceOptionsWorkflow(context.readDb),
  },
);
