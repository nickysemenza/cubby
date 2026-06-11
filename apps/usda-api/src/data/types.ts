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
  orderBy?: "description" | "data_type" | "fdc_id";
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
