import { z } from "zod";

import { dataTypeEnum } from "../schemas";

const MAX_SEARCH_PAGE_SIZE = 1000;

/**
 * One text search of a USDA release. `dataTypeFilter` wins over `dataTypes`,
 * which wins over `foodsOnly` (the four user-facing food types).
 */
export const foodSearchArgs = z.object({
  nameFilter: z.string().optional(),
  dataTypeFilter: dataTypeEnum.optional(),
  dataTypes: z.array(dataTypeEnum).optional(),
  foodsOnly: z.boolean().optional(),
  orderBy: z
    .enum(["description", "data_type", "fdc_id", "relevance"])
    .default("description"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  pageIndex: z.number().int().min(0).default(0),
  pageSize: z.number().int().min(1).max(MAX_SEARCH_PAGE_SIZE).default(10),
});
export type FoodSearchArgs = z.output<typeof foodSearchArgs>;
