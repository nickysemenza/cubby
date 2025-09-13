import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import {
  getFoodByIdResponse,
  getLegacyFoodResponse,
  getFoodPortionsResponse,
  getNutrientSummaryResponse,
  getBrandedFoodResponse,
  findFoodByUpcResponse,
  findFoodByNdbResponse,
  listFoodsQuery,
  listFoodsResponse,
  getCompleteFoodResponse,
  errorResponse,
} from "../schemas/food.js";
import {
  getFoodById,
  getLegacyFoodById,
  getFoodPortions,
  getNutrientSummary,
  getBrandedFoodById,
  findFoodByUpc,
  findFoodByNdb,
  listFoods,
  getCompleteFoodInfo,
} from "../db/queries.js";

const app = new OpenAPIHono();

// Parameter schemas
const fdcIdParam = z.object({
  fdc_id: z.string().transform((val) => parseInt(val, 10)),
});

const gtinUpcParam = z.object({
  gtin_upc: z.string(),
});

const ndbNumberParam = z.object({
  ndb_number: z.string().transform((val) => parseInt(val, 10)),
});

// 1. Get Complete Food by FDC ID
const getFoodRoute = createRoute({
  method: "get",
  path: "/api/foods/{fdc_id}",
  summary: "Get complete food information by FDC ID",
  description: "Retrieve all available information for a food item by FDC ID",
  request: {
    params: fdcIdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: getCompleteFoodResponse,
        },
      },
      description: "Complete food information retrieved successfully",
    },
    404: {
      content: {
        "application/json": {
          schema: errorResponse,
        },
      },
      description: "Food not found",
    },
  },
});

app.openapi(getFoodRoute, (c) => {
  const { fdc_id } = c.req.valid("param");
  const completeFood = getCompleteFoodInfo(fdc_id);

  if (!completeFood) {
    return c.json(
      {
        error: "Food not found",
        message: `No food found with FDC ID ${fdc_id}`,
      },
      404
    );
  }

  return c.json(completeFood, 200);
});

// 2. Find Food by UPC
const findFoodByUpcRoute = createRoute({
  method: "get",
  path: "/api/foods/search/upc/{gtin_upc}",
  summary: "Find food by UPC code",
  description:
    "Find a food item by its UPC/GTIN code and return complete food information",
  request: {
    params: gtinUpcParam,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: findFoodByUpcResponse,
        },
      },
      description: "Complete food information found by UPC (null if not found)",
    },
  },
});

app.openapi(findFoodByUpcRoute, (c) => {
  const { gtin_upc } = c.req.valid("param");
  const food = findFoodByUpc(gtin_upc);

  return c.json(food, 200);
});

// 3. Find Food by NDB Number
const findFoodByNdbRoute = createRoute({
  method: "get",
  path: "/api/foods/search/ndb/{ndb_number}",
  summary: "Find food by NDB number",
  description:
    "Find a food item by its legacy NDB number and return complete food information",
  request: {
    params: ndbNumberParam,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: findFoodByNdbResponse,
        },
      },
      description:
        "Complete food information found by NDB number (null if not found)",
    },
  },
});

app.openapi(findFoodByNdbRoute, (c) => {
  const { ndb_number } = c.req.valid("param");
  const food = findFoodByNdb(ndb_number);

  return c.json(food, 200);
});

// 4. List Foods with Pagination and Filtering
const listFoodsRoute = createRoute({
  method: "get",
  path: "/api/foods",
  summary: "List foods with pagination and filtering",
  description:
    "Retrieve a paginated list of foods with optional name and data type filtering",
  request: {
    query: listFoodsQuery,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: listFoodsResponse,
        },
      },
      description: "Foods list retrieved successfully",
    },
  },
});

app.openapi(listFoodsRoute, (c) => {
  const query = c.req.valid("query");
  const result = listFoods(query);

  return c.json(result, 200);
});

export default app;
