import type { z } from "zod";
import type {
  ListFoodsArgs,
  ListFoodsResult,
  countsSchema,
} from "@cubby/usda-contract";
import type { FoodLookupParam, FoodSummary } from "@cubby/usda-schemas";

export type { ListFoodsArgs, ListFoodsResult };

type Counts = z.infer<typeof countsSchema>;

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
