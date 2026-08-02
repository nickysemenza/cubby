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
import {
  createFinancialAccount,
  deleteFinancialAccounts,
  getFinancialAccountByShortcode,
  listFinancialAccounts,
  updateFinancialAccount,
} from "~/server/repo/financial-account";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter } from "../trpc";

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
      await deleteFinancialAccounts(
        services.db,
        ids.map(unsafeFinancialAccountShortcode),
        services.actorContext,
      );
      return [];
    },
  },
  entityName: "financialAccount",
});

export const financialAccountRouter = createTRPCRouter(procedures);
