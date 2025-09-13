import { serve } from "@hono/node-server";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { z } from "zod";
import {
  countUsdaFood,
  countUsdaBrandedFood,
  countUsdaNutrient,
  countUsdaFoodNutrient,
  countUsdaMeasureUnit,
  countUsdaFoodPortion,
  countUsdaSrLegacyFood,
  sqlite,
  closeAllConnections,
} from "./db/client";
import foodRoutes from "./routes/foods";

const app = new OpenAPIHono();

const CountsSchema = z.object({
  usda_food: z.number().int().min(0),
  usda_branded_food: z.number().int().min(0),
  usda_nutrient: z.number().int().min(0),
  usda_food_nutrient: z.number().int().min(0),
  usda_measure_unit: z.number().int().min(0),
  usda_food_portion: z.number().int().min(0),
  usda_sr_legacy_food: z.number().int().min(0),
});

const ErrorSchema = z.object({
  error: z.string(),
});

const countsRoute = createRoute({
  method: "get",
  path: "/",
  summary: "Get database table counts",
  description: "Returns the number of records in each USDA database table",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CountsSchema,
        },
      },
      description: "Successful response with table counts",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

app.openapi(countsRoute, (c) => {
  try {
    const counts = {
      usda_food: countUsdaFood(),
      usda_branded_food: countUsdaBrandedFood(),
      usda_nutrient: countUsdaNutrient(),
      usda_food_nutrient: countUsdaFoodNutrient(),
      usda_measure_unit: countUsdaMeasureUnit(),
      usda_food_portion: countUsdaFoodPortion(),
      usda_sr_legacy_food: countUsdaSrLegacyFood(),
    };
    return c.json(counts, 200);
  } catch (error) {
    console.error("Error getting counts:", error);
    return c.json({ error: "Failed to retrieve counts" }, 500);
  }
});

// Mount food routes
app.route("/", foodRoutes);

app.doc("/doc", {
  openapi: "3.0.0",
  info: {
    version: "1.0.0",
    title: "USDA Database API",
    description:
      "API for accessing USDA FoodData Central database with comprehensive food information, nutrients, and search capabilities",
  },
});

app.get("/ui", swaggerUI({ url: "/doc" }));

// Validate FTS table exists on startup (lightweight)
function validateFtsTable(): void {
  try {
    const exists = sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='food_search'",
      )
      .get();
    if (!exists) {
      console.warn(
        'FTS table "food_search" not found; search routes may be limited.',
      );
    } else {
      console.log("FTS search table present");
    }
  } catch (error) {
    console.warn("FTS validation skipped:", error);
  }
}

const port = Number(process.env.PORT || 8080);

try {
  validateFtsTable();
  console.log(`Server listening on :${port}`);
  serve({ fetch: app.fetch, port });
} catch (error) {
  console.error("Failed to start server:", error);
  process.exit(1);
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down gracefully...");
  closeAllConnections();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down gracefully...");
  closeAllConnections();
  process.exit(0);
});
