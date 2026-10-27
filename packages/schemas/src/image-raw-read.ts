/** Repository/compiler projections. Public entity reads use generated field envelopes. */
import imageDefinition from "./entity-definitions/18-image.entity";
import { z } from "zod";

export const rawImageOutput = imageDefinition.readSchemas.output;
export const rawImageList = imageDefinition.readSchemas.list;
export const rawImageDetail = imageDefinition.readSchemas.detail;

export type RawImageOutput = z.output<typeof rawImageOutput>;
export type RawImageList = z.output<typeof rawImageList>;
export type RawImageDetail = z.output<typeof rawImageDetail>;
