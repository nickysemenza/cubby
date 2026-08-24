import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionFiltersSchema,
  financialTransactionSortableFields,
  financialTransactionSourceOptionsOut,
} from "@cubby/schemas/financial-transaction";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
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
    ...ENTITY_BINDINGS.financialTransaction.crud,
    filters: financialTransactionFiltersSchema,
    sort: {
      sortableFields: financialTransactionSortableFields,
      defaultSort: "transactionDate",
    },
  },
  repository: {
    getByShortcode: (services, id) =>
      getFinancialTransactionByShortcode(services.db, id),
    create: (services, data) =>
      createFinancialTransaction(services.db, data, services.actorContext),
    update: (services, id, data) =>
      updateFinancialTransaction(services.db, id, data, services.actorContext),
    list: (services, filters, sorts, pagination) =>
      listFinancialTransactions(services.db, filters, sorts, pagination),
    delete: (services, ids) =>
      deleteFinancialTransactions(services.db, ids, services.actorContext),
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
