import {
  productLookupResponseSchema,
  upcLookupInput,
} from "@cubby/upc-contract";

import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const upc = defineOperationDomain("upc", {
  lookup: query({
    input: upcLookupInput,
    output: productLookupResponseSchema.nullable(),
    tags: [["upc", "lookup"]],
  }),
});
