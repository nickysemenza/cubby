import {
  productLookupResponseSchema,
  upcLookupInput,
} from "@cubby/upc-contract";

import { defineContract, query } from "~/contracts/define";

export const upcContract = defineContract("upc", {
  lookup: query({
    input: upcLookupInput,
    output: productLookupResponseSchema.nullable(),
  }),
});
