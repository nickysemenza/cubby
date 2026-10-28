/** Private repository/compiler projections; public Cookbook reads use envelopes. */
import { readSchemas as definitionSchemas } from "./entity-definitions/03-cookbook.entity";
import { z } from "zod";

export const rawCookbookOutput = definitionSchemas.output;
export const rawCookbookList = definitionSchemas.list;
export const rawCookbookDetail = definitionSchemas.detail;
export type RawCookbookOutput = z.output<typeof rawCookbookOutput>;
export type RawCookbookList = z.output<typeof rawCookbookList>;
export type RawCookbookDetail = z.output<typeof rawCookbookDetail>;
