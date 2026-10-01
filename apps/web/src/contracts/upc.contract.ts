import { defineContract, query } from "~/contracts/define";
import {
  productLookupResponseSchema,
  upcLookupInput,
} from "~/contracts/upc.schemas";

export const upcContract = defineContract("upc", {
  lookup: query({
    native: "Capture barcode lookup",
    input: upcLookupInput,
    output: productLookupResponseSchema.nullable(),
  }),
});
