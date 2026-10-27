/** Private repository/compiler projections; public Cookbook reads use envelopes. */
import definition from "./entity-definitions/03-cookbook.entity";
import { z } from "zod";

export const rawCookbookOutput = definition.readSchemas.output;
export const rawCookbookList = definition.readSchemas.list;
export const rawCookbookDetail = definition.readSchemas.detail;
export type RawCookbookOutput = z.output<typeof rawCookbookOutput>;
export type RawCookbookList = z.output<typeof rawCookbookList>;
export type RawCookbookDetail = z.output<typeof rawCookbookDetail>;
