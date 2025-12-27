import { context, propagation } from "@opentelemetry/api";
import { usdaContract } from "@recipehub/usda-contract";
import type {
  BrandedFoodInfo,
  DataType,
  FoodLookupParam,
  FoodSummary,
} from "@recipehub/usda-schemas";
import { initClient } from "@ts-rest/core";
import type { PaginationParams, SortParams } from "~/schemas/pagination";
import { getTracer, TraceNames } from "~/server/tracing";

export class USDAClient {
  private client;

  constructor(private baseUrl: string) {
    // Helper to get trace context headers for each request
    const getTraceHeaders = () => {
      const headers: Record<string, string> = {};
      propagation.inject(context.active(), headers);
      return headers;
    };

    this.client = initClient(usdaContract, {
      baseUrl: this.baseUrl,
      baseHeaders: {
        "user-agent": "recipehub",
        // Inject OpenTelemetry trace context for distributed tracing
        traceparent: () => getTraceHeaders().traceparent ?? "",
        tracestate: () => getTraceHeaders().tracestate ?? "",
      },
    });
  }

  // Transport helpers
  private async traced<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const tracer = getTracer();
    return tracer.startActiveSpan(
      TraceNames.api("usda", operation),
      async (span) => {
        try {
          const res = await fn();
          span.setStatus({ code: 1 });
          return res;
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          span.setStatus({ code: 2, message: err.message });
          throw e;
        } finally {
          span.end();
        }
      },
    );
  }

  // Raw calls via ts-rest client
  private async fetchGetFood(fdcId: number): Promise<FoodSummary | null> {
    return this.traced("getFood", async () => {
      const res = await this.client.getFood({ params: { fdc_id: fdcId } });
      if (res.status !== 200) return null;
      return res.body;
    });
  }

  private async fetchListFoods(params: {
    nameFilter?: string;
    dataTypeFilter?: DataType;
    orderBy?: "description" | "data_type" | "fdc_id";
    direction?: "asc" | "desc";
    pageIndex?: number | null;
    pageSize?: number | null;
  }): Promise<{ data: FoodSummary[]; count: number }> {
    return this.traced("listFoods", async () => {
      const res = await this.client.listFoods({
        query: {
          nameFilter: params.nameFilter,
          dataTypeFilter: params.dataTypeFilter,
          orderBy: params.orderBy,
          direction: params.direction,
          pageIndex: params.pageIndex ?? undefined,
          pageSize: params.pageSize ?? undefined,
        },
      });
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
      if (res.status !== 200) return lookups.map(() => null);
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
  ) {
    // Map generic sort fields to USDA-specific fields
    const orderByMap: Record<string, "description" | "data_type" | "fdc_id"> = {
      name: "description",
      description: "description",
      data_type: "data_type",
      fdc_id: "fdc_id",
    };
    const orderBy = orderByMap[sort.orderBy] ?? "description";

    const data = await this.fetchListFoods({
      nameFilter,
      dataTypeFilter,
      orderBy,
      direction: sort.direction,
      pageIndex: pagination.pageIndex,
      pageSize: pagination.pageSize,
    });

    return { data: data.data, count: data.count };
  }
}
