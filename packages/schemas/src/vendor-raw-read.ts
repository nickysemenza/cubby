import vendorDefinition from "./entity-definitions/11-vendor.entity";
import type { z } from "zod";

/** Repository/compiler projection. Public Vendor reads use generated envelopes. */
export const rawVendorOut = vendorDefinition.readSchemas.output;
export type RawVendorOut = z.output<typeof rawVendorOut>;
