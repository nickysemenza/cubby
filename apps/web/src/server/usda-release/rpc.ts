// Types only, importing nothing but schema types: the global
// worker-configuration.d.ts reaches this file through worker-bindings.ts, and
// tsc re-checks the whole program after an edit to anything it reaches
// (docs/local-check-performance.md#typechecking).
import type { FoodLookupParam, FoodSummary } from "@cubby/usda";
import type { ListFoodsArgs } from "@cubby/usda/contract";
import type {
  FoodSearchPage,
  ReleaseCounts,
  ReleaseStatus,
} from "@cubby/usda/release";

/** What callers reach through a `USDA_RELEASE` stub; one object per USDA release. */
export interface UsdaReleaseRpc {
  status(): Promise<ReleaseStatus>;
  counts(): Promise<ReleaseCounts>;
  getFood(fdcId: number): Promise<FoodSummary | null>;
  lookupBatch(lookups: FoodLookupParam[]): Promise<Array<FoodSummary | null>>;
  search(args: ListFoodsArgs): Promise<FoodSearchPage>;
}
