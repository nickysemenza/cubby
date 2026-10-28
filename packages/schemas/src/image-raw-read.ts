/** Repository/compiler projections. Public entity reads use generated field envelopes. */
import { readSchemas as imageDefinitionSchemas } from "./entity-definitions/18-image.entity";
import { z } from "zod";

export const rawImageOutput = imageDefinitionSchemas.output;
export const rawImageList = imageDefinitionSchemas.list;
export const rawImageDetail = imageDefinitionSchemas.detail;

export type RawImageOutput = z.output<typeof rawImageOutput>;
export type RawImageList = z.output<typeof rawImageList>;
export type RawImageDetail = z.output<typeof rawImageDetail>;
