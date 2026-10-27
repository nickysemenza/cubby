import definition from "./entity-definitions/21-vendorAccount.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawVendorAccountOut = definition.readSchemas.output;
export type RawVendorAccountOut = z.output<typeof rawVendorAccountOut>;
