import { upc } from "~/lib/upc.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { lookupUpcWorkflow } from "~/server/workflows/upc.server";

export const upcHandlers = implementOperationDomain(upc, {
  lookup: lookupUpcWorkflow,
});
