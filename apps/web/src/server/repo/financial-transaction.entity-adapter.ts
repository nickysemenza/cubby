import {
  financialTransactionFiltersSchema,
  financialTransactionSortableFields,
} from "@cubby/schemas/financial-transaction";
import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
  FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY,
  getFinancialTransactionByShortcode,
  listFinancialTransactions,
  updateFinancialTransaction,
} from "./financial-transaction";

export const financialTransactionEntityAdapter = defineEntityAdapter({
  entity: "financialTransaction",
  filters: financialTransactionFiltersSchema,
  sort: {
    fields: financialTransactionSortableFields,
    default: "transactionDate",
  },
  lifecycle: { delete: FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getFinancialTransactionByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listFinancialTransactions(ctx.db, filters, sorts, pagination),
    create: (ctx, data) =>
      createFinancialTransaction(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateFinancialTransaction(ctx.db, id, data, ctx.actorContext),
    delete: (ctx, ids) =>
      deleteFinancialTransactions(ctx.db, ids, ctx.actorContext),
  },
});
