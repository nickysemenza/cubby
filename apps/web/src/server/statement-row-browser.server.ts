import { statementRowContract } from "~/contracts/statement-row.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getStatementRowSummary,
  listStatementImports,
  listStatementRows,
  recordStatementRows,
} from "~/server/repo/statement-row";
import {
  commitStatementCsv,
  previewStatementCsv,
} from "~/server/statement-csv-import";

export const statementRowHandlers = implementOperationDomain(
  statementRowContract,
  {
    previewCsv: (context, input) =>
      previewStatementCsv(context.readDb, context.actorContext, input),
    commitCsv: (context, input) =>
      commitStatementCsv(context.db, context.actorContext, input),
    record: (context, input) =>
      recordStatementRows(context.db, input, context.actorContext),
    list: (context, input) =>
      listStatementRows(
        context.db,
        input.filters ?? {},
        input.pagination,
        Array.isArray(input.sort) ? input.sort[0] : input.sort,
      ),
    summary: (context, input) =>
      getStatementRowSummary(context.db, input.filters ?? {}),
    imports: (context, input) => listStatementImports(context.db, input.source),
  },
);
