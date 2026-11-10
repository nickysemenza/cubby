/** Repository/compiler projections. Public entity reads use generated field envelopes. */
import { readSchemas as imageDefinitionSchemas } from "./entity-definitions/18-image.entity";
import { z } from "zod";

export const rawImageOutput = imageDefinitionSchemas.output;
export const rawImageDetail = imageDefinitionSchemas.detail;

export type RawImageDetail = z.output<typeof rawImageDetail>;
