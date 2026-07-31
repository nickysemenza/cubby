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
import { z } from "zod";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
  getFinancialTransactionByShortcode,
  listFinancialTransactions,
  updateFinancialTransaction,
} from "~/server/repo/financial-transaction";
import {
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const { list } = createEntityListProcedure({
  schemas: {
    output: financialTransactionOut,
    filters: financialTransactionFiltersSchema,
    sort: {
      sortableFields: financialTransactionSortableFields,
      defaultSort: "transactionDate",
    },
  },
  repository: {
    list: (services, filters, sorts, pagination) =>
      listFinancialTransactions(services.db, filters, sorts, pagination),
  },
  entityName: "financialTransaction",
});

const crud = createEntityCrudWithoutListProcedures({
  schemas: {
    createInput: financialTransactionCreateInput,
    updateInput: financialTransactionUpdateData,
    output: financialTransactionOut,
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
  },
  entityName: "financialTransaction",
});

const deleteItem = protectedProcedure
  .input(z.object({ ids: z.array(financialTransactionShortcode).min(1) }))
  .mutation(async ({ ctx, input }) => {
    await deleteFinancialTransactions(ctx.db, input.ids, ctx.actorContext);
    return { sideEffects: { backgroundBatches: [] } };
  });

export const financialTransactionRouter = createTRPCRouter({
  ...crud,
  list,
  delete: deleteItem,
});
