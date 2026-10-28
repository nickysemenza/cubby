import { readSchemas as definitionSchemas } from "./entity-definitions/24-device.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawDeviceOut = definitionSchemas.output;
export type RawDeviceOut = z.output<typeof rawDeviceOut>;
