import { sourceTransactionRecordContract } from "~/contracts/source-transaction-record.contract";
import {
  findSourceTransactionRecordDrift,
  getSourceTransactionRecordSummary,
  recordSourceTransactionRecords,
} from "~/server/domains/transaction-import/repo/source-transaction-record";
import { decideStatement } from "~/server/domains/transaction-import/repo/statement-decisions";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
export const sourceTransactionRecordHandlers = implementOperationDomain(
  sourceTransactionRecordContract,
  {
    apply: (context, input) =>
      decideStatement(context.db, context.actorContext, input),
    record: async (context, input) => {
      const result = await recordSourceTransactionRecords(
        context.db,
        input,
        context.actorContext,
      );
      if (!result.batchId) return { ...result, batchId: null };
      const imports = await lookupEntityReferences(
        context.db,
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
    summary: (context, input) =>
      getSourceTransactionRecordSummary(context.db, input.filters ?? {}),
    drift: (context, input) =>
      findSourceTransactionRecordDrift(context.db, input),
  },
);
