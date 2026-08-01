import {
  financialTransactionCreateInput,
  financialTransactionFiltersSchema,
  financialTransactionOut,
  financialTransactionSortableFields,
  financialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import {
  financialTransactionShortcode,
  unsafeFinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
  getFinancialTransactionByShortcode,
  listFinancialTransactions,
  updateFinancialTransaction,
} from "~/server/repo/financial-transaction";
import { createNonSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter } from "../trpc";

const procedures = createNonSearchableEntityCrudProcedures({
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
    create: async (services, data) =>
      (
        await createFinancialTransaction(
          services.db,
          data,
          services.actorContext,
        )
      ).output,
    update: async (services, id, data) =>
      (
        await updateFinancialTransaction(
          services.db,
          unsafeFinancialTransactionShortcode(id),
          data,
          services.actorContext,
        )
      ).output,
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

export const financialTransactionRouter = createTRPCRouter(procedures);
