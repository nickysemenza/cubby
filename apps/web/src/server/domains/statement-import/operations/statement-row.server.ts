import { statementRowContract } from "~/contracts/statement-row.contract";
import { withSnapshotWriteDatabase } from "~/server/db/helpers";
import {
  deleteStatementRows,
  findStatementRowDrift,
  getStatementRowSummary,
  listStatementImports,
  listStatementRows,
  recordStatementRows,
  updateStatementRows,
} from "~/server/domains/statement-import/repo/statement-row";
import { previewStatementSuggestion } from "~/server/domains/statement-import/repo/statement-suggestion-preview";
import { scheduleStatementSuggestions } from "~/server/domains/statement-import/service/statement-suggestion-generation";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
export const statementRowHandlers = implementOperationDomain(
  statementRowContract,
  {
    previewSuggestion: (context, input) =>
      previewStatementSuggestion(context.db, input),
    record: (context, input) =>
      withSnapshotWriteDatabase(
        context.db,
        async (db) => {
          const result = await recordStatementRows(
            db,
            input,
            context.actorContext,
          );
          if (
            !input.dryRun &&
            result.batchId &&
            (result.inserted ||
              result.revised ||
              result.refreshed ||
              result.withdrawn)
          )
            await scheduleStatementSuggestions(
              db,
              result.batchId,
              context.actorContext,
            );
          return result;
        },
        { isolationLevel: "serializable" },
      ),
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
