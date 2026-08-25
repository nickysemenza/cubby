import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionSourceOptionsOut,
} from "@cubby/schemas/financial-transaction";
import { previewFinancialStatementImport } from "~/server/repo/financial-statement-preview";
import { financialTransactionSourceOptions } from "~/server/repo/financial-transaction";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

/** Client-parsed Monarch rows only: this is a read-only reconciliation preview. */
const previewStatementImport = protectedProcedure
  .input(financialStatementImportPreviewInput)
  .output(strictOutput(financialStatementImportPreviewOut))
  .query(({ ctx, input }) => previewFinancialStatementImport(ctx.db, input));

/** The Source picklist, derived from the sourceRefs actually stored. */
const sourceOptions = protectedProcedure
  .output(strictOutput(financialTransactionSourceOptionsOut))
  .query(({ ctx }) => financialTransactionSourceOptions(ctx.db));

export const financialTransactionRouter = createTRPCRouter({
  previewStatementImport,
  sourceOptions,
});
