import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { apiReference } from "@scalar/hono-api-reference";
import {
  countUsdaFood,
  countUsdaBrandedFood,
  countUsdaNutrient,
  countUsdaFoodNutrient,
  countUsdaMeasureUnit,
  countUsdaFoodPortion,
  countUsdaSrLegacyFood,
  closeAllConnections,
} from "./db/client";
import foodRoutes from "./routes/foods";
import { countsSchema, errorSchema } from "@recipehub/usda-contract";
import { openApiDocument } from "./openapi";

const app = new Hono();

// Custom HTTP request logging middleware
const httpLogger = async (c: Context, next: Next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  await next();

  const duration = Date.now() - start;
  const method = c.req.method;
  const url = c.req.url;
  const status = c.res.status;
  const userAgent = c.req.header("User-Agent") || "Unknown";

  // Color code status for better visibility
  let statusColor = "";
  if (status >= 200 && status < 300) {
    statusColor = "\x1b[32m"; // Green
  } else if (status >= 300 && status < 400) {
    statusColor = "\x1b[33m"; // Yellow
  } else if (status >= 400) {
    statusColor = "\x1b[31m"; // Red
  }

  console.log(
    `${timestamp} [${method}] ${url} - Status: ${statusColor}${status}\x1b[0m - Duration: ${duration}ms - UA: ${userAgent}`,
  );
};

// Apply logging middleware globally
app.use("*", httpLogger);

app.get("/", (c) => {
  try {
    const counts = countsSchema.parse({
      usda_food: countUsdaFood(),
      usda_branded_food: countUsdaBrandedFood(),
      usda_nutrient: countUsdaNutrient(),
      usda_food_nutrient: countUsdaFoodNutrient(),
      usda_measure_unit: countUsdaMeasureUnit(),
      usda_food_portion: countUsdaFoodPortion(),
      usda_sr_legacy_food: countUsdaSrLegacyFood(),
    });
    return c.json(counts, 200);
  } catch (e) {
    console.error("Error getting counts:", e);
    return c.json(
      errorSchema.parse({ error: "Failed to retrieve counts" }),
      500,
    );
  }
});

// OpenAPI JSON endpoint
app.get("/openapi.json", (c) => {
  return c.json(openApiDocument);
});

// Scalar API documentation
app.get(
  "/docs",
  apiReference({
    content: openApiDocument,
    theme: "default",
    layout: "modern",
    darkMode: true,
  }),
);

// Mount food routes
app.route("/", foodRoutes);

const port = Number(process.env.PORT || 8080);

try {
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
