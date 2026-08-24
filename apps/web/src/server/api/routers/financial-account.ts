import {
  financialAccountFiltersSchema,
  financialAccountOptionsOut,
  financialAccountSortableFields,
} from "@cubby/schemas/financial-account";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
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
    ...ENTITY_BINDINGS.financialAccount.crud,
    filters: financialAccountFiltersSchema,
    sort: {
      sortableFields: financialAccountSortableFields,
      defaultSort: "name",
    },
  },
  repository: {
    getByShortcode: (services, id) =>
      getFinancialAccountByShortcode(services.db, id),
    create: (services, data) =>
      createFinancialAccount(services.db, data, services.actorContext),
    update: (services, id, data) =>
      updateFinancialAccount(services.db, id, data, services.actorContext),
    list: (services, filters, sorts, pagination) =>
      listFinancialAccounts(services.db, filters, sorts, pagination),
    delete: (services, ids) =>
      deleteFinancialAccounts(services.db, ids, services.actorContext),
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
