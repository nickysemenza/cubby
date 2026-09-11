import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";

import {
  createFinancialAccount,
  deleteFinancialAccounts,
  FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY,
  getFinancialAccountByShortcode,
  listFinancialAccounts,
  updateFinancialAccount,
} from "./financial-account";

export const financialAccountEntityAdapter = defineEntityAdapter({
  entity: "financialAccount",
  lifecycle: { delete: FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getFinancialAccountByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listFinancialAccounts(ctx.db, filters, sorts, pagination),
    create: (ctx, data) =>
      createFinancialAccount(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateFinancialAccount(ctx.db, id, data, ctx.actorContext),
    delete: async (ctx, ids) => {
      await deleteFinancialAccounts(ctx.db, ids, ctx.actorContext);
      return {
        deletedReferences: entityMutationReferences("financialAccount", ids),
      };
    },
  },
});
