import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  BrandedFoodInfo,
  DataType,
  FoodLookupParam,
  FoodSummary,
} from "@cubby/usda";
import type { FoodSearchArgs, FoodSearchPage } from "@cubby/usda/release";

import { TraceNames, withTrace } from "~/server/tracing";
import type { UsdaReleaseRpc } from "~/server/usda-release/rpc";

const ORDER_BY_SORT_KEY = new Map<string, FoodSearchArgs["orderBy"]>([
  ["name", "description"],
  ["description", "description"],
  ["data_type", "data_type"],
  ["fdc_id", "fdc_id"],
  ["relevance", "relevance"],
]);

/** Reads the active USDA release (ADR 0008); built once per request. */
export class USDAClient {
  // Request-scoped memo of resolved lookups, keyed by canonical lookup. It
  // stores the in-flight promise, so concurrent callers (the two coverage
  // detectors on the Problems page run under one Promise.all) share one call.
  private readonly batchMemo = new Map<string, Promise<FoodSummary | null>>();

  constructor(private readonly release: UsdaReleaseRpc) {}

  private traced<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return withTrace(TraceNames.api("usda", operation), fn);
  }

  private static lookupKey(lookup: FoodLookupParam): string {
    if (lookup.kind === "upc") return `upc:${lookup.gtin_upc}`;
    if (lookup.kind === "ndb") return `ndb:${lookup.ndb_number}`;
    return `fdc:${lookup.fdc_id}`;
  }

  /** Resolve each lookup, deduped against this request's earlier lookups. */
  async findFoodsBatch(
    lookups: FoodLookupParam[],
  ): Promise<(FoodSummary | null)[]> {
    if (lookups.length === 0) return [];
    const keys = lookups.map((lookup) => USDAClient.lookupKey(lookup));
    // A memoized null is a known miss, so it is not asked again either.
    const missing = new Map<string, FoodLookupParam>();
    keys.forEach((key, i) => {
      if (!this.batchMemo.has(key)) missing.set(key, lookups[i]!);
    });
    if (missing.size > 0) {
      const missKeys = [...missing.keys()];
      const batch = this.traced("lookupBatch", () =>
        this.release.lookupBatch([...missing.values()]),
      );
      missKeys.forEach((key, i) => {
        this.batchMemo.set(
          key,
          batch.then((results) => results[i] ?? null),
        );
      });
    }
    return Promise.all(
      keys.map((key) => this.batchMemo.get(key) ?? Promise.resolve(null)),
    );
  }

  async findFood(lookup: FoodLookupParam): Promise<FoodSummary | null> {
    const [food] = await this.findFoodsBatch([lookup]);
    return food ?? null;
  }

  getFoodSummaryByID(fdc_id: number): Promise<FoodSummary | null> {
    return this.findFood({ kind: "fdc", fdc_id });
  }

  async getBrandedFoodByID(fdc_id: number): Promise<BrandedFoodInfo | null> {
    return (await this.getFoodSummaryByID(fdc_id))?.brandedFoodInfo ?? null;
  }

  /** The active release's id and foods per data type. */
  getCounts() {
    return this.traced("counts", () => this.release.counts());
  }

  /** One page of a text search; rows omit the full nutrient table. */
  listFoods(
    nameFilter: string | undefined,
    dataTypeFilter: DataType | undefined,
    sort: SortParams,
    pagination: PaginationParams,
    foodsOnly?: boolean,
    dataTypes?: DataType[],
  ): Promise<FoodSearchPage> {
    return this.traced("search", () =>
      this.release.search({
        nameFilter,
        dataTypeFilter,
        dataTypes,
        foodsOnly,
        orderBy: ORDER_BY_SORT_KEY.get(sort.orderBy) ?? "description",
        direction: sort.direction,
        pageIndex: pagination.pageIndex,
        pageSize: pagination.pageSize,
      }),
    );
  }
}

export type UsdaFoodLookupPort = Pick<USDAClient, "findFood">;
