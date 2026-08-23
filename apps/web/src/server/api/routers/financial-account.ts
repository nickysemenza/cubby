import {
  financialAccountCreateInput,
  financialAccountFiltersSchema,
  financialAccountOptionsOut,
  financialAccountOut,
  financialAccountSortableFields,
  financialAccountUpdateData,
} from "@cubby/schemas/financial-account";
import {
  financialAccountShortcode,
  unsafeFinancialAccountShortcode,
} from "@cubby/schemas/identifiers";
import {
  createFinancialAccount,
  deleteFinancialAccounts,
  financialAccountOptions,
  getFinancialAccountByShortcode,
  listFinancialAccounts,
  updateFinancialAccount,
} from "~/server/repo/financial-account";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const procedures = createSearchableEntityCrudProcedures({
  schemas: {
    createInput: financialAccountCreateInput,
    updateInput: financialAccountUpdateData,
    output: financialAccountOut,
    filters: financialAccountFiltersSchema,
    sort: {
      sortableFields: financialAccountSortableFields,
      defaultSort: "name",
    },
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
    create: (services, data) =>
      createFinancialAccount(services.db, data, services.actorContext),
    update: async (services, id, data) =>
      updateFinancialAccount(
        services.db,
        unsafeFinancialAccountShortcode(id),
        data,
        services.actorContext,
      ),
    list: (services, filters, sorts, pagination) =>
      listFinancialAccounts(services.db, filters, sorts, pagination),
    delete: async (services, ids) => {
      const { deleted } = await deleteFinancialAccounts(
        services.db,
        ids.map(unsafeFinancialAccountShortcode),
        services.actorContext,
      );
      return { deleted };
    },
  },
  entityName: "financialAccount",
});

/**
 * The account picklist — feeds the transactions table's Account filter. Cheap
 * options query, same shape as `vendor.options`. The transaction form keeps its
 * own search-as-you-type combobox: that one pages the full list, this one is
 * loaded eagerly for a header control.
 */
const options = protectedProcedure
  .output(strictOutput(financialAccountOptionsOut))
  .query(({ ctx }) => financialAccountOptions(ctx.db));

export const financialAccountRouter = createTRPCRouter({
  ...procedures,
  options,
});
