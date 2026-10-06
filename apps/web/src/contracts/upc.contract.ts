import { defineContract, query } from "~/contracts/define";
import {
  productLookupResponseSchema,
  upcLookupInput,
} from "~/contracts/upc.schemas";

export const upcContract = defineContract("upc", {
  lookup: query({
    mcp: { omit: "agent_twin", twin: "product.lookupUpc" },
    native: "Capture barcode lookup",
    input: upcLookupInput,
    output: productLookupResponseSchema.nullable(),
  }),
});
