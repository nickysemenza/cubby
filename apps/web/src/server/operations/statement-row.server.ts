import { statementRowContract } from "~/contracts/statement-row.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  deleteStatementRows,
  findStatementRowDrift,
  getStatementRowSummary,
  listStatementImports,
  listStatementRows,
  recordStatementRows,
  updateStatementRows,
} from "~/server/repo/statement-row";
import {
  commitStatementCsv,
  previewStatementCsv,
} from "~/server/statement-csv-import";

export const statementRowHandlers = implementOperationDomain(
  statementRowContract,
  {
    previewCsv: (context, input) =>
      previewStatementCsv(context.db, context.actorContext, input),
    commitCsv: (context, input) =>
      commitStatementCsv(context.db, context.actorContext, input),
    record: (context, input) =>
      recordStatementRows(context.db, input, context.actorContext),
    list: (context, input) =>
      listStatementRows(
        context.db,
        input.filters ?? {},
        input.pagination,
        input.sort[0],
      ),
    summary: (context, input) =>
      getStatementRowSummary(context.db, input.filters ?? {}),
    imports: (context, input) => listStatementImports(context.db, input.source),
    drift: (context, input) => findStatementRowDrift(context.db, input),
    update: (context, input) =>
      updateStatementRows(context.db, input, context.actorContext),
    delete: (context, input) =>
      deleteStatementRows(context.db, input.selector, context.actorContext),
  },
);
