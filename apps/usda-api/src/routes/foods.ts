import { Hono } from "hono";
import {
  fdcIdParam,
  listFoodsQuery,
  listFoodsResponse,
} from "@recipehub/usda-contract";
import { foodLookupParam, foodSummary } from "@recipehub/usda-schemas";
import {
  findFoodByUpc,
  findFoodByNdb,
  listFoods,
  getCompleteFoodInfo,
} from "../db/queries.js";

const app = new Hono();

// 1. Get Complete Food by FDC ID
app.get("/api/foods/:fdc_id", (c) => {
  const params = fdcIdParam.safeParse({ fdc_id: c.req.param("fdc_id") });
  if (!params.success) {
    return c.json({ error: "Invalid FDC ID" }, 400);
  }
  const completeFood = getCompleteFoodInfo(params.data.fdc_id);
  if (!completeFood) {
    return c.json(
      {
        error: "Food not found",
        message: `No food found with FDC ID ${params.data.fdc_id}`,
      },
      404,
    );
  }
  return c.json(foodSummary.parse(completeFood), 200);
});

// 2. Consolidated: Find Food by Lookup (UPC or NDB) via POST body
app.post("/api/foods/search", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = foodLookupParam.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid lookup" }, 400);
  }
  const lookup = parsed.data;
  const food =
    lookup.kind === "upc"
      ? findFoodByUpc(lookup.gtin_upc)
      : findFoodByNdb(lookup.ndb_number);
  return c.json(food ? foodSummary.parse(food) : null, 200);
});

// 4. List Foods with Pagination and Filtering
app.get("/api/foods", (c) => {
  const queryParams = Object.fromEntries(
    new URL(c.req.url).searchParams.entries(),
  );
  const parsed = listFoodsQuery.safeParse({
    nameFilter: queryParams.nameFilter,
    dataTypeFilter: queryParams.dataTypeFilter,
    orderBy: queryParams.orderBy,
    direction: queryParams.direction,
    pageIndex: queryParams.pageIndex,
    pageSize: queryParams.pageSize,
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters" }, 400);
  }
  const result = listFoods(parsed.data);
  return c.json(listFoodsResponse.parse(result), 200);
});

export default app;
