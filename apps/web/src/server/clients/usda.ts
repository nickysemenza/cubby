import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { usdaContract } from "@cubby/usda-contract";
import type {
  BrandedFoodInfo,
  DataType,
  FoodLookupParam,
  FoodSummary,
} from "@cubby/usda-schemas";
import { initClient } from "@ts-rest/core";
import { injectTraceContext, TraceNames, withTrace } from "~/server/tracing";

export class USDAClient {
  private client;
  private fetcher: typeof fetch;

  constructor(
    private baseUrl: string,
    fetcher?: typeof fetch,
  ) {
    // Service binding fetch in prod, global fetch (public URL) in dev
    this.fetcher = fetcher ?? fetch;
    // Helper to get trace context headers for each request (dev only — in the
    // CF Worker the platform propagates trace context across service bindings).
    const getTraceHeaders = () => {
      const headers: Record<string, string> = {};
      injectTraceContext(headers);
      return headers;
    };

    this.client = initClient(usdaContract, {
      baseUrl: this.baseUrl,
      baseHeaders: {
        "user-agent": "cubby",
        // Inject OpenTelemetry trace context for distributed tracing
        traceparent: () => getTraceHeaders().traceparent ?? "",
        tracestate: () => getTraceHeaders().tracestate ?? "",
      },
      api: async (args) => {
        // Use CF Cache API for individual food lookups (GET /api/foods/:id)
        const cache =
          typeof caches !== "undefined"
            ? (caches as unknown as { default: Cache }).default
            : null;
        const isGetFood =
          args.method === "GET" && args.path.includes("/api/foods/");

        if (cache && isGetFood) {
          const cached = await cache.match(args.path);
          if (cached) {
            return {
              status: cached.status,
              body: await cached.json(),
              headers: cached.headers,
            };
          }
        }

        try {
          const response = await this.fetcher(args.path, {
            ...args,
            signal: AbortSignal.timeout(5_000),
          });

          // Cache successful getFood responses for 24 hours
          if (cache && isGetFood && response.ok) {
            const body = await response.clone().text();
            cache.put(
              args.path,
              new Response(body, {
                status: response.status,
                headers: {
                  "Content-Type": "application/json",
                  "Cache-Control": "public, max-age=86400",
                },
              }),
            );
          }

          return {
            status: response.status,
            body: await response.json(),
            headers: response.headers,
          };
        } catch (error) {
          // USDA now runs on Cloudflare Workers (always available), so a
          // fetch/timeout failure is a real error — not a transient miss to
          // degrade past. Re-throw so callers surface it instead of silently
          // producing null/empty results (which would masquerade as "no data").
          if (error instanceof Error && error.name === "TimeoutError") {
            console.warn(`[USDA] Timeout after 5000ms for ${args.path}`);
          } else {
            console.warn(`[USDA] Request failed for ${args.path}:`, error);
          }
          throw error;
        }
      },
    });
  }

  // Transport helpers
  private async traced<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return withTrace(TraceNames.api("usda", operation), fn);
  }

  // USDA is always-up now, so a non-200 that isn't a clean 404 is a service
  // error → throw. A 404 means the food genuinely isn't there (a permanent
  // miss), which callers represent as null. Inlined per call site (rather than a
  // helper) so ts-rest's status-discriminated `res.body` narrows to the 200 body.
  private static assertNot5xx(status: number, operation: string): void {
    if (status !== 200 && status !== 404) {
      throw new Error(`[USDA] ${operation} failed with status ${status}`);
    }
  }

  // Raw calls via ts-rest client
  private async fetchGetFood(fdcId: number): Promise<FoodSummary | null> {
    return this.traced("getFood", async () => {
      const res = await this.client.getFood({ params: { fdc_id: fdcId } });
      USDAClient.assertNot5xx(res.status, "getFood");
      if (res.status !== 200) return null;
      return res.body;
    });
  }

  private async fetchListFoods(params: {
    nameFilter?: string;
    dataTypeFilter?: DataType;
    dataTypes?: DataType[];
    foodsOnly?: boolean;
    orderBy?: "description" | "data_type" | "fdc_id" | "relevance";
    direction?: "asc" | "desc";
    pageIndex?: number | null;
    pageSize?: number | null;
  }): Promise<{ data: FoodSummary[]; count: number }> {
    return this.traced("listFoods", async () => {
      const res = await this.client.listFoods({
        query: {
          nameFilter: params.nameFilter,
          dataTypeFilter: params.dataTypeFilter,
          // Comma-join for the querystring; omit when empty.
          dataTypes: params.dataTypes?.length
            ? params.dataTypes.join(",")
            : undefined,
          // Omit when false so the querystring stays clean (and z.coerce.boolean
          // never sees a falsey-but-present value).
          foodsOnly: params.foodsOnly || undefined,
          orderBy: params.orderBy,
          direction: params.direction,
          pageIndex: params.pageIndex ?? undefined,
          pageSize: params.pageSize ?? undefined,
        },
      });
      USDAClient.assertNot5xx(res.status, "listFoods");
      if (res.status !== 200) return { data: [], count: 0 };
      return res.body;
    });
  }

  async getBrandedFoodByID(fdc_id: number): Promise<BrandedFoodInfo | null> {
    const data = await this.fetchGetFood(fdc_id);
    return data?.brandedFoodInfo ?? null;
  }

  async findFood(lookup: FoodLookupParam): Promise<FoodSummary | null> {
    return await this.traced("findByLookup", async () => {
      const res = await this.client.findByLookup({ body: lookup });
      USDAClient.assertNot5xx(res.status, "findByLookup");
      if (res.status !== 200) return null;
      return res.body;
    });
  }

  async findFoodsBatch(
    lookups: FoodLookupParam[],
  ): Promise<(FoodSummary | null)[]> {
    if (lookups.length === 0) return [];

    return await this.traced("findByLookupBatch", async () => {
      const res = await this.client.findByLookupBatch({ body: { lookups } });
      // A batch is a single POST; a non-200 is a service error (per-item
      // not-founds come back as nulls in `results`), so throw rather than
      // silently degrading every lookup to null.
      if (res.status !== 200) {
        throw new Error(
          `[USDA] findByLookupBatch failed with status ${res.status}`,
        );
      }
      return res.body.results;
    });
  }

  async getFoodSummaryByID(fdc_id: number): Promise<FoodSummary | null> {
    return await this.fetchGetFood(fdc_id);
  }

  async listFoods(
    nameFilter: string | undefined,
    dataTypeFilter: DataType | undefined,
    sort: SortParams,
    pagination: PaginationParams,
    foodsOnly?: boolean,
    dataTypes?: DataType[],
  ) {
    // Map generic sort fields to USDA-specific fields
    const orderByMap: Record<
      string,
      "description" | "data_type" | "fdc_id" | "relevance"
    > = {
      name: "description",
      description: "description",
      data_type: "data_type",
      fdc_id: "fdc_id",
      relevance: "relevance",
    };
    const orderBy = orderByMap[sort.orderBy] ?? "description";

    const data = await this.fetchListFoods({
      nameFilter,
      dataTypeFilter,
      dataTypes,
      foodsOnly,
      orderBy,
      direction: sort.direction,
      pageIndex: pagination.pageIndex,
      pageSize: pagination.pageSize,
    });

    return { data: data.data, count: data.count };
  }
}
