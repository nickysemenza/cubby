// Initialize OpenTelemetry BEFORE any other imports
import { initializeTracing } from "./instrumentation";
initializeTracing();

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { httpInstrumentationMiddleware } from "@hono/otel";
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
import { countsSchema, errorSchema } from "@cubby/usda-contract";
import { openApiDocument } from "./openapi";
import { trace, context } from "@opentelemetry/api";

const app = new Hono();

// Custom HTTP request logging middleware with trace ID
const httpLogger = async (c: Context, next: Next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  await next();

  const duration = Date.now() - start;
  const method = c.req.method;
  const url = c.req.url;
  const status = c.res.status;
  const userAgent = c.req.header("User-Agent") || "Unknown";

  // Get trace ID from current span or extracted context
  const activeContext = context.active();
  const activeSpan = trace.getSpan(activeContext);
  const spanContext =
    activeSpan?.spanContext() ?? trace.getSpanContext(activeContext);
  const traceId = spanContext?.traceId ?? "no-trace";

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
    `${timestamp} [${method}] ${url} - Status: ${statusColor}${status}\x1b[0m - Duration: ${duration}ms - TraceID: ${traceId} - UA: ${userAgent}`,
  );
};

// Apply Hono OpenTelemetry middleware, then logging
app.use(
  "*",
  httpInstrumentationMiddleware({
    serviceName: "usda-api",
    captureRequestHeaders: ["user-agent"],
  }),
);
app.use("*", httpLogger);

app.get("/counts", async (c) => {
  try {
    const counts = countsSchema.parse({
      usda_food: await countUsdaFood(),
      usda_branded_food: await countUsdaBrandedFood(),
      usda_nutrient: await countUsdaNutrient(),
      usda_food_nutrient: await countUsdaFoodNutrient(),
      usda_measure_unit: await countUsdaMeasureUnit(),
      usda_food_portion: await countUsdaFoodPortion(),
      usda_sr_legacy_food: await countUsdaSrLegacyFood(),
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
  "/",
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
