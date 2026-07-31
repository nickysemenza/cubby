import {
  financialAccountCreateInput,
  financialAccountFiltersSchema,
  financialAccountOut,
  financialAccountSortableFields,
  financialAccountUpdateData,
} from "@cubby/schemas/financial-account";
import {
  financialAccountShortcode,
  unsafeFinancialAccountShortcode,
} from "@cubby/schemas/identifiers";
import { z } from "zod";
import {
  createFinancialAccount,
  deleteFinancialAccounts,
  getFinancialAccountByShortcode,
  listFinancialAccounts,
  updateFinancialAccount,
} from "~/server/repo/financial-account";
import {
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const { list } = createEntityListProcedure({
  schemas: {
    output: financialAccountOut,
    filters: financialAccountFiltersSchema,
    sort: {
      sortableFields: financialAccountSortableFields,
      defaultSort: "name",
    },
  },
  repository: {
    list: (services, filters, sorts, pagination) =>
      listFinancialAccounts(services.db, filters, sorts, pagination),
  },
  entityName: "financialAccount",
});

const crud = createEntityCrudWithoutListProcedures({
  schemas: {
    createInput: financialAccountCreateInput,
    updateInput: financialAccountUpdateData,
    output: financialAccountOut,
    idSchema: financialAccountShortcode,
  },
  repository: {
    getByID: async (services, id) => {
      const out = await getFinancialAccountByShortcode(services.db, id);
      if (!out) throw new Error(`Financial account not found: ${id}`);
      return out;
    },
    getByShortcode: (services, id) =>
      getFinancialAccountByShortcode(services.db, id),
    create: async (services, data) =>
      (await createFinancialAccount(services.db, data, services.actorContext))
        .output,
    update: async (services, id, data) =>
      (
        await updateFinancialAccount(
          services.db,
          unsafeFinancialAccountShortcode(id),
          data,
          services.actorContext,
        )
      ).output,
  },
  entityName: "financialAccount",
});

const deleteItem = protectedProcedure
  .input(z.object({ ids: z.array(financialAccountShortcode).min(1) }))
  .mutation(async ({ ctx, input }) => {
    await deleteFinancialAccounts(ctx.db, input.ids, ctx.actorContext);
    return { sideEffects: { backgroundBatches: [] } };
  });

export const financialAccountRouter = createTRPCRouter({
  ...crud,
  list,
  delete: deleteItem,
});
