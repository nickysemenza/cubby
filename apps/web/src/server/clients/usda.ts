import { trace } from "@opentelemetry/api";
import {
  BrandedFoodInfo,
  FoodLookupParam,
  FoodSummary,
} from "@recipehub/usda-schemas";
import {
  usdaContract,
  type CompleteFoodResponse,
} from "@recipehub/usda-contract";
import { initClient } from "@ts-rest/core";
import { type SortParams, type PaginationParams } from "~/schemas/pagination";

export class USDAClient {
  private client: any;
  constructor(private baseUrl: string) {
    this.client = initClient(usdaContract, {
      baseUrl: this.baseUrl,
    });
  }

  // Transport helpers
  private async traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const tracer = trace.getTracer("usda-api");
    const span = tracer.startSpan(name);
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
  }

  // Raw calls via ts-rest client
  private async fetchGetFood(
    fdcId: number,
  ): Promise<CompleteFoodResponse | null> {
    return this.traced("tsClient.getFood", async () => {
      const res = await this.client.getFood({ params: { fdc_id: fdcId } });
      if (res.status !== 200) return null;
      return res.body;
    });
  }

  private async fetchFindByLookup(
    lookup: FoodLookupParam,
  ): Promise<CompleteFoodResponse | null> {
    return this.traced("client.findByLookup", async () => {
      const res = await this.client.findByLookup({ body: lookup });
      if (res.status !== 200) return null;
      return res.body;
    });
  }

  private async fetchListFoods(params: {
    nameFilter?: string;
    dataTypeFilter?: string;
    orderBy?: "description" | "data_type" | "fdc_id";
    direction?: "asc" | "desc";
    pageIndex?: number | null;
    pageSize?: number | null;
  }): Promise<{ data: CompleteFoodResponse[]; count: number }> {
    return this.traced("client.listFoods", async () => {
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

  // Domain mapping
  private transformCompleteFoodToFoodSummary(
    completeFood: CompleteFoodResponse,
  ): FoodSummary {
    return {
      ...completeFood,
      portionInfo: {
        raw: completeFood.portionInfo.raw,
        parsed: [],
      },
    };
  }

  async getBrandedFoodByID(fdc_id: number): Promise<BrandedFoodInfo | null> {
    const data = await this.fetchGetFood(fdc_id);
    return data?.brandedFoodInfo ?? null;
  }

  async findFood(lookup: FoodLookupParam): Promise<FoodSummary | null> {
    const data = await this.traced(
      "USDA API: POST /api/foods/search",
      async () => {
        const res = await this.client.findByLookup({ body: lookup });
        if (res.status !== 200) return null;
        return res.body;
      },
    );
    if (!data) return null;
    return this.transformCompleteFoodToFoodSummary(data);
  }

  async getFoodSummaryByID(fdc_id: number): Promise<FoodSummary | null> {
    const data = await this.fetchGetFood(fdc_id);
    if (!data) return null;
    return this.transformCompleteFoodToFoodSummary(data);
  }

  async listFoods(
    nameFilter: string | undefined,
    dataTypeFilter: string | undefined,
    sort: SortParams,
    pagination: PaginationParams,
  ) {
    const data = await this.fetchListFoods({
      nameFilter,
      dataTypeFilter,
      orderBy: sort.orderBy as "description" | "data_type" | "fdc_id",
      direction: sort.direction,
      pageIndex: pagination.pageIndex,
      pageSize: pagination.pageSize,
    });

    const foodSummaries: FoodSummary[] = data.data.map((food) =>
      this.transformCompleteFoodToFoodSummary(food),
    );
    return { data: foodSummaries, count: data.count };
  }
}
