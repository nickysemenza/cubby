import { readSchemas as vendorDefinitionSchemas } from "./entity-definitions/11-vendor.entity";
import type { z } from "zod";

/** Repository/compiler projection. Public Vendor reads use generated envelopes. */
export const rawVendorOut = vendorDefinitionSchemas.output;
export type RawVendorOut = z.output<typeof rawVendorOut>;
