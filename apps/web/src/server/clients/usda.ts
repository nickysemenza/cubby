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

// Per-request abort ceiling for usda-api fetches. Generous for caller-side
// transport overhead (not handler work): the fetch itself resolves in ~150ms now
// that usda-api caches resolved foods in D1. (Was briefly bumped to 33s while
// chasing the recompute slowdown — that was a wasm_tracing CPU-starvation
// artifact mis-timed by workerd's frozen clock, since fixed; 15s is ample.)
const USDA_FETCH_TIMEOUT_MS = 15_000;

interface FoodCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

interface CloudflareCacheStorage extends CacheStorage {
  default: FoodCache;
}

const hasDefaultCache = (
  storage: CacheStorage | undefined,
): storage is CloudflareCacheStorage =>
  storage !== undefined && "default" in storage;

type UsdaOrderField = "description" | "data_type" | "fdc_id" | "relevance";

export class USDAClient {
  private client;
  private fetcher: typeof fetch;
  private cache: FoodCache | null;
  // Request-scoped memo of batch-resolved foods, keyed by canonical lookup. The
  // client is built per-request in ctx (see buildCrudServices), so this can't
  // serve cross-request stale data; it just stops the same product being
  // re-POSTed when several queries in one request enrich overlapping products.
  //
  // Stores the in-flight *promise*, not the resolved value, so concurrent
  // callers (e.g. the two coverage detectors on the Problems page, which run
  // under one Promise.all) coalesce onto a single POST instead of each firing
  // their own before the other has settled.
  private readonly batchMemo = new Map<string, Promise<FoodSummary | null>>();

  constructor(
    private baseUrl: string,
    fetcher?: typeof fetch,
    runtime?: { cache: FoodCache | null },
  ) {
    // Service binding fetch in prod, global fetch (public URL) in dev
    this.fetcher = fetcher ?? fetch;
    const cacheStorage = globalThis.caches;
    this.cache = runtime
      ? runtime.cache
      : hasDefaultCache(cacheStorage)
        ? cacheStorage.default
        : null;
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
        // The food lookup and dataset counts are stable enough for an edge hit.
        const cache = this.cache;
        const isGetFood =
          args.method === "GET" && args.path.includes("/api/foods/");
        const isCounts = args.method === "GET" && args.path.endsWith("/counts");
        const isCacheableGet = isGetFood || isCounts;

        if (cache && isCacheableGet) {
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
            // usda-api's internal work is ~500ms–1s, but caller-side fetch time
            // through the service binding has been observed up to ~5s (platform
            // transport/queue overhead we're now tracing via usda.request). A 5s
            // ceiling aborted those genuinely-in-flight responses, surfacing as
            // hard errors on the homepage. Until enrichment moves off the
            // critical path, give slow-but-real responses room to land.
            signal: AbortSignal.timeout(USDA_FETCH_TIMEOUT_MS),
          });

          // Cache successful food and count responses for 24 hours.
          if (
            cache &&
            isCacheableGet &&
            response.ok &&
            (!isCounts || response.status === 200)
          ) {
            try {
              const body = await response.clone().text();
              await cache.put(
                args.path,
                new Response(body, {
                  status: response.status,
                  headers: {
                    "Content-Type": "application/json",
                    "Cache-Control": "public, max-age=86400",
                  },
                }),
              );
            } catch (error) {
              // SILENT: a cache-write failure must not turn a successful USDA
              // response into an application error — the response below is
              // already the real result; this `Cache.put` was only a
              // best-effort warm for the next 24h.
              console.warn(
                `[USDA] Cache write failed for ${args.path}:`,
                error,
              );
            }
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
            console.warn(
              `[USDA] Timeout after ${USDA_FETCH_TIMEOUT_MS}ms for ${args.path}`,
            );
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

  /**
   * Dataset row counts from the usda-api `/counts` manifest endpoint — a single
   * cheap manifest read (no list query, no per-food enrichment). Used by the
   * dashboard's USDA count card instead of a `listFoods` count(*) over ~2M D1
   * rows. Returns null on a non-200 (manifest unavailable).
   */
  async getCounts() {
    return this.traced("counts", async () => {
      const res = await this.client.counts();
      USDAClient.assertNot5xx(res.status, "counts");
      if (res.status !== 200) return null;
      return res.body;
    });
  }

  async findFood(lookup: FoodLookupParam): Promise<FoodSummary | null> {
    return await this.traced("findByLookup", async () => {
      const res = await this.client.findByLookup({ body: lookup });
      USDAClient.assertNot5xx(res.status, "findByLookup");
      if (res.status !== 200) return null;
      return res.body;
    });
  }

  private static lookupKey(lookup: FoodLookupParam): string {
    if (lookup.kind === "upc") return `upc:${lookup.gtin_upc}`;
    if (lookup.kind === "ndb") return `ndb:${lookup.ndb_number}`;
    return `fdc:${lookup.fdc_id}`;
  }

  async findFoodsBatch(
    lookups: FoodLookupParam[],
  ): Promise<(FoodSummary | null)[]> {
    if (lookups.length === 0) return [];

    const keys = lookups.map((l) => USDAClient.lookupKey(l));
    // Fetch only lookups not already in-flight or resolved earlier in this
    // request, deduped. A memo'd null is a known miss — don't re-POST it either.
    const missing = new Map<string, FoodLookupParam>();
    keys.forEach((key, i) => {
      if (!this.batchMemo.has(key)) missing.set(key, lookups[i]!);
    });

    if (missing.size > 0) {
      const missKeys = [...missing.keys()];
      const missLookups = [...missing.values()];
      const batch = this.traced("findByLookupBatch", async () => {
        const res = await this.client.findByLookupBatch({
          body: { lookups: missLookups },
        });
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
      // Register each key's slice of the shared POST in the memo *before*
      // awaiting, so a concurrent caller requesting an overlapping key awaits
      // this same batch instead of issuing a second POST.
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
    const orderByBySortKey = new Map<string, UsdaOrderField>([
      ["name", "description"],
      ["description", "description"],
      ["data_type", "data_type"],
      ["fdc_id", "fdc_id"],
      ["relevance", "relevance"],
    ]);
    const orderBy = orderByBySortKey.get(sort.orderBy) ?? "description";

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

export type UsdaFoodLookupPort = Pick<USDAClient, "findFood">;
