import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  batchLookupBody,
  fdcIdParam,
  listFoodsQuery,
} from "@cubby/usda-contract";
import { foodLookupParam } from "@cubby/usda-schemas";
import type { USDADataSource } from "../data/types.js";

export function createFoodRoutes(dataSource: USDADataSource) {
  const app = new Hono();

  app.get(
    "/api/foods/:fdc_id",
    zValidator("param", fdcIdParam, (result, c) => {
      if (result.success) return;
      return c.json({ error: "Invalid FDC ID" }, 400);
    }),
    async (c) => {
      const params = c.req.valid("param");

      const completeFood = await dataSource.getFoodById(params.fdc_id);
      if (!completeFood) {
        return c.json(
          {
            error: "Food not found",
            message: `No food found with FDC ID ${params.fdc_id}`,
          },
          404,
        );
      }

      return c.json(completeFood, 200);
    },
  );

  app.post("/api/foods/search", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = foodLookupParam.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid lookup" }, 400);
    }
    const lookup = parsed.data;

    const food =
      lookup.kind === "upc"
        ? await dataSource.findFoodByUpc(lookup.gtin_upc)
        : lookup.kind === "ndb"
          ? await dataSource.findFoodByNdb(lookup.ndb_number)
          : await dataSource.getFoodById(lookup.fdc_id);

    return c.json(food, 200);
  });

  app.post("/api/foods/search/batch", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = batchLookupBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid batch lookup" }, 400);
    }

    const results = (
      await dataSource.findFoodsByLookupBatch(parsed.data.lookups)
    ).map((food) => food ?? null);

    return c.json({ results }, 200);
  });

  app.get("/api/foods", async (c) => {
    const queryParams = Object.fromEntries(
      new URL(c.req.url).searchParams.entries(),
    );
    const parsed = listFoodsQuery.safeParse({
      nameFilter: queryParams.nameFilter,
      dataTypeFilter: queryParams.dataTypeFilter,
      dataTypes: queryParams.dataTypes,
      foodsOnly: queryParams.foodsOnly,
      orderBy: queryParams.orderBy,
      direction: queryParams.direction,
      pageIndex: queryParams.pageIndex,
      pageSize: queryParams.pageSize,
    });
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }

    const result = await dataSource.listFoods(parsed.data);
    return c.json(result, 200);
  });

  return app;
}
