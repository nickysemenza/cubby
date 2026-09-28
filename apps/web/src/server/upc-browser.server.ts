import { upcContract } from "~/contracts/upc.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { lookupUpcWorkflow } from "~/server/operations/upc.server";

export const upcHandlers = implementOperationDomain(upcContract, {
  lookup: lookupUpcWorkflow,
});
