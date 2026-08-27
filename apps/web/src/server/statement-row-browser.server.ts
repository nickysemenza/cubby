import { statementRow } from "~/lib/statement-row.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getStatementRowSummaryWorkflow,
  listStatementImportsWorkflow,
  listStatementRowsWorkflow,
} from "~/server/workflows/statement-row.server";

export const statementRowHandlers = implementOperationDomain(statementRow, {
  list: {
    readPolicy: "strong",
    run: (context, input) => listStatementRowsWorkflow(context.db, input),
  },
  summary: {
    readPolicy: "strong",
    run: (context, input) => getStatementRowSummaryWorkflow(context.db, input),
  },
  imports: {
    readPolicy: "strong",
    run: (context, input) => listStatementImportsWorkflow(context.db, input),
  },
});
