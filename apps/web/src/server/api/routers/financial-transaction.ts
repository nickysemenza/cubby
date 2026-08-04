import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionCreateInput,
  financialTransactionFiltersSchema,
  financialTransactionOut,
  financialTransactionSortableFields,
  financialTransactionSourceOptionsOut,
  financialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import {
  financialTransactionShortcode,
  unsafeFinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import { previewFinancialStatementImport } from "~/server/repo/financial-statement-preview";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
  financialTransactionSourceOptions,
  getFinancialTransactionByShortcode,
  listFinancialTransactions,
  updateFinancialTransaction,
} from "~/server/repo/financial-transaction";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const procedures = createSearchableEntityCrudProcedures({
  schemas: {
    createInput: financialTransactionCreateInput,
    updateInput: financialTransactionUpdateData,
    output: financialTransactionOut,
    filters: financialTransactionFiltersSchema,
    sort: {
      sortableFields: financialTransactionSortableFields,
      defaultSort: "transactionDate",
    },
    idSchema: financialTransactionShortcode,
  },
  repository: {
    getByID: async (services, id) => {
      const out = await getFinancialTransactionByShortcode(services.db, id);
      if (!out) throw new Error(`Financial transaction not found: ${id}`);
      return out;
    },
    getByShortcode: (services, id) =>
      getFinancialTransactionByShortcode(services.db, id),
    create: (services, data) =>
      createFinancialTransaction(services.db, data, services.actorContext),
    update: async (services, id, data) =>
      updateFinancialTransaction(
        services.db,
        unsafeFinancialTransactionShortcode(id),
        data,
        services.actorContext,
      ),
    list: (services, filters, sorts, pagination) =>
      listFinancialTransactions(services.db, filters, sorts, pagination),
    delete: async (services, ids) => {
      await deleteFinancialTransactions(
        services.db,
        ids.map(unsafeFinancialTransactionShortcode),
        services.actorContext,
      );
      return [];
    },
  },
  entityName: "financialTransaction",
});

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
  ...procedures,
  previewStatementImport,
  sourceOptions,
});
