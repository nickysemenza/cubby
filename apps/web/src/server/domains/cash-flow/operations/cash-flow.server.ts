import { cashFlowContract } from "~/contracts/finance.contract";
import { cashFlowProjection } from "~/server/domains/cash-flow/repo/projection";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const cashFlowHandlers = implementOperationDomain(cashFlowContract, {
  projection: (context, input) => cashFlowProjection(context.db, input),
});
