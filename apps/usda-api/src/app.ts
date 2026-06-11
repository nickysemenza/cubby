import { Hono } from "hono";
import type { Context, MiddlewareHandler, Next } from "hono";
import { apiReference } from "@scalar/hono-api-reference";
import { countsSchema, errorSchema } from "@cubby/usda-contract";
import { openApiDocument } from "./openapi.js";
import { createFoodRoutes } from "./routes/foods.js";
import type { USDADataSource } from "./data/types.js";

interface CreateUsdaAppOptions {
  middleware?: MiddlewareHandler[];
  logRequests?: boolean;
}

const httpLogger = async (c: Context, next: Next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  await next();

  const duration = Date.now() - start;
  const method = c.req.method;
  const url = c.req.url;
  const status = c.res.status;
  const userAgent = c.req.header("User-Agent") || "Unknown";

  console.log(
    `${timestamp} [${method}] ${url} - Status: ${status} - Duration: ${duration}ms - UA: ${userAgent}`,
  );
};

export function createUsdaApp(
  dataSource: USDADataSource,
  options: CreateUsdaAppOptions = {},
) {
  const app = new Hono();

  for (const middleware of options.middleware ?? []) {
    app.use("*", middleware);
  }

  if (options.logRequests) {
    app.use("*", httpLogger);
  }

  app.get("/counts", async (c) => {
    try {
      return c.json(countsSchema.parse(await dataSource.getCounts()), 200);
    } catch (e) {
      console.error("Error getting counts:", e);
      return c.json(
        errorSchema.parse({ error: "Failed to retrieve counts" }),
        500,
      );
    }
  });

  app.get("/openapi.json", (c) => {
    return c.json(openApiDocument);
  });

  app.get(
    "/",
    apiReference({
      content: openApiDocument,
      theme: "default",
      layout: "modern",
      darkMode: true,
    }),
  );

  app.route("/", createFoodRoutes(dataSource));

  return app;
}
