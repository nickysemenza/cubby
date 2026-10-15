import { upcContract } from "~/contracts/upc.contract";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const upcHandlers = implementOperationDomain(upcContract, {
  lookup: (context, input) => context.upcLookupClient.lookup(input.upc),
});
