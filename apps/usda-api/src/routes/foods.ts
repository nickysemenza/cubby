import { Hono } from "hono";
import { z } from "zod";
import { fdcIdParam, listFoodsQuery } from "@cubby/usda-contract";
import { foodLookupParam } from "@cubby/usda-schemas";
import type { USDADataSource } from "../data/types.js";

export function createFoodRoutes(dataSource: USDADataSource) {
  const app = new Hono();

  app.get("/api/foods/:fdc_id", async (c) => {
    const params = fdcIdParam.safeParse({ fdc_id: c.req.param("fdc_id") });
    if (!params.success) {
      return c.json({ error: "Invalid FDC ID" }, 400);
    }

    const completeFood = await dataSource.getFoodById(params.data.fdc_id);
    if (!completeFood) {
      return c.json(
        {
          error: "Food not found",
          message: `No food found with FDC ID ${params.data.fdc_id}`,
        },
        404,
      );
    }

    return c.json(completeFood, 200);
  });

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
        : await dataSource.findFoodByNdb(lookup.ndb_number);

    return c.json(food, 200);
  });

  app.post("/api/foods/search/batch", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = z
      .object({
        lookups: z.array(foodLookupParam),
      })
      .safeParse(body);
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
