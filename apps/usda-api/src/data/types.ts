import type { z } from "zod";
import type { countsSchema } from "@cubby/usda-contract";
import type {
  DataType,
  FoodLookupParam,
  FoodSummary,
} from "@cubby/usda-schemas";

export type Counts = z.infer<typeof countsSchema>;

export interface ListFoodsArgs {
  nameFilter?: string;
  dataTypeFilter?: DataType;
  /** Restrict to the four user-facing food types; dataTypeFilter takes precedence. */
  foodsOnly?: boolean;
  /** "relevance" orders by FTS bm25 rank (only meaningful with a nameFilter). */
  orderBy?: "description" | "data_type" | "fdc_id" | "relevance";
  direction?: "asc" | "desc";
  pageIndex?: number;
  pageSize?: number;
}

export interface ListFoodsResult {
  data: FoodSummary[];
  count: number;
}

export interface USDADataSource {
  getCounts(): Promise<Counts>;
  getFoodById(fdcId: number): Promise<FoodSummary | null>;
  findFoodByUpc(gtinUpc: string): Promise<FoodSummary | null>;
  findFoodByNdb(ndbNumber: number): Promise<FoodSummary | null>;
  findFoodsByLookupBatch(
    lookups: FoodLookupParam[],
  ): Promise<Array<FoodSummary | null>>;
  listFoods(args: ListFoodsArgs): Promise<ListFoodsResult>;
}
