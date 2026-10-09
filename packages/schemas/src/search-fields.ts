import { z } from "zod";
import { searchableEntities } from "./entity-index";

// The Search route's `type` filter, apart from `./search`, whose request and
// result schemas a route's eager search validation must not load.
export const searchTypeOptions = ["all", ...searchableEntities] as const;
export const searchTypeSchema = z.enum(searchTypeOptions);
export type SearchType = z.infer<typeof searchTypeSchema>;
