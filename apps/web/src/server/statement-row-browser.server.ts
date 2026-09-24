import { statementRowContract } from "~/contracts/statement-row.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getStatementRowSummaryWorkflow,
  listStatementImportsWorkflow,
  listStatementRowsWorkflow,
  recordStatementRowsWorkflow,
} from "~/server/workflows/statement-row.server";

export const statementRowHandlers = implementOperationDomain(
  statementRowContract,
  {
    record: (context, input) =>
      recordStatementRowsWorkflow(context.db, context.actorContext, input),
    list: {
      run: (context, input) => listStatementRowsWorkflow(context.db, input),
    },
    summary: {
      run: (context, input) =>
        getStatementRowSummaryWorkflow(context.db, input),
    },
    imports: {
      run: (context, input) => listStatementImportsWorkflow(context.db, input),
    },
  },
);
