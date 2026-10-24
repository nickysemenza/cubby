import { sourceTransactionRecordContract } from "~/contracts/source-transaction-record.contract";
import { withSnapshotWriteDatabase } from "~/server/db/helpers";
import {
  previewProviderIdBackfill,
  backfillProviderId,
} from "~/server/domains/transaction-import/repo/provider-id-backfill";
import {
  findSourceTransactionRecordDrift,
  getSourceTransactionRecordSummary,
  recordSourceTransactionRecords,
} from "~/server/domains/transaction-import/repo/source-transaction-record";
import { previewStatementSuggestion } from "~/server/domains/transaction-import/repo/statement-suggestion-preview";
import { scheduleStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-generation";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
export const sourceTransactionRecordHandlers = implementOperationDomain(
  sourceTransactionRecordContract,
  {
    previewProviderIdBackfill: (context, input) =>
      previewProviderIdBackfill(context.db, input),
    backfillProviderId: (context, input) =>
      backfillProviderId(context.db, input, context.actorContext),
    previewSuggestion: (context, input) =>
      previewStatementSuggestion(context.db, input),
    record: (context, input) =>
      withSnapshotWriteDatabase(
        context.db,
        async (db) => {
          const result = await recordSourceTransactionRecords(
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
          if (!result.batchId) return { ...result, batchId: null };
          const imports = await lookupEntityReferences(
            db,
            "transactionImport",
            [result.batchId],
          );
          const retainedImport = imports.get(result.batchId);
          if (!retainedImport)
            throw new Error(
              `Retained transaction import ${result.batchId} could not be resolved`,
            );
          return { ...result, batchId: retainedImport.id };
        },
        { isolationLevel: "serializable" },
      ),
    summary: (context, input) =>
      getSourceTransactionRecordSummary(context.db, input.filters ?? {}),
    drift: (context, input) =>
      findSourceTransactionRecordDrift(context.db, input),
  },
);
