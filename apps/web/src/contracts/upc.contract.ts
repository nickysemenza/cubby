import {
  productLookupResponseSchema,
  upcLookupInput,
} from "@cubby/upc-contract";

import { defineContract, query } from "~/contracts/define";

export const upcContract = defineContract("upc", {
  lookup: query({
    native: "Capture barcode lookup",
    input: upcLookupInput,
    output: productLookupResponseSchema.nullable(),
  }),
});
