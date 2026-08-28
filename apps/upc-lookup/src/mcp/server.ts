import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type JSONType, z } from "zod";
import type { Env } from "../types";
import { createDb } from "../db";
import type { NewProduct, Product } from "../db/schema";
import {
  getProduct,
  createProduct,
  updateProductWithImageCleanup,
  deleteProduct,
  listProducts,
} from "../db/products";
import { deleteMiss } from "../db/misses";
import { resolveProduct } from "../services/products";
import { lookupExternalProduct } from "../api";
import { getStats } from "../routes/stats";
import { storeImage, getImageUrl } from "../storage/images";
import { UPC_REGEX } from "../util/upc";

type JsonResponse = {
  content: [{ type: "text"; text: string }];
};

function json(data: JSONType): JsonResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function withErrorHandling<A>(handler: (args: A) => Promise<JsonResponse>) {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResult(message);
    }
  };
}

function productToJson(product: Product, baseUrl: string) {
  return {
    upc: product.upc,
    name: product.name,
    manufacturer: product.manufacturer,
    brand: product.brand,
    category: product.category,
    description: product.description,
    priceDollars: product.priceDollars,
    imageUrl: product.imageKey ? getImageUrl(product.imageKey, baseUrl) : null,
    source: product.source,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

/**
 * Build the upc-lookup MCP server. `env` and `baseUrl` are captured per request
 * so every tool receives the current worker bindings and request origin.
 * Every tool delegates to the same repo/service code as the REST routes and the
 * admin UI, so the three stay in lockstep.
 */
export function createMcpServer(env: Env, baseUrl: string): McpServer {
  const server = new McpServer({ name: "upc-lookup", version: "1.0.0" });
  const db = createDb(env.DB);

  server.tool(
    "lookup_upc",
    "Look up a product by UPC barcode. Returns the cached product, or fetches it from external sources and caches it. Returns found:false if no source has data.",
    { upc: z.string().describe("UPC barcode (8, 12, 13, or 14 digits)") },
    withErrorHandling(async ({ upc }) => {
      if (!UPC_REGEX.test(upc)) {
        throw new Error("Invalid UPC. Must be 8, 12, 13, or 14 digits.");
      }
      const result = await resolveProduct(db, env, upc);
      if (!result) return json({ found: false, upc });
      return json({
        ...productToJson(result.product, baseUrl),
        cached: result.cached,
      });
    }),
  );

  server.tool(
    "search_products",
    "Search cached products by name, brand, or manufacturer.",
    {
      q: z.string().describe("Search term"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Results to skip (default 0)"),
    },
    withErrorHandling(async ({ q, limit, offset }) => {
      const pageSize = limit ?? 20;
      const page = Math.floor((offset ?? 0) / pageSize) + 1;
      const { rows, total } = await listProducts(db, { q, page, pageSize });
      return json({
        products: rows.map((p) => productToJson(p, baseUrl)),
        total,
      });
    }),
  );

  server.tool(
    "get_product",
    "Get a single cached product by UPC.",
    { upc: z.string().describe("UPC barcode") },
    withErrorHandling(async ({ upc }) => {
      const product = await getProduct(db, upc);
      if (!product) return json({ found: false, upc });
      return json(productToJson(product, baseUrl));
    }),
  );

  server.tool(
    "create_product",
    "Manually create a cached product (source: manual). Use for UPCs no external source knows.",
    {
      upc: z.string().describe("UPC barcode (8, 12, 13, or 14 digits)"),
      name: z.string().describe("Product name"),
      manufacturer: z.string().nullish(),
      brand: z.string().nullish(),
      category: z.string().nullish(),
      description: z.string().nullish(),
      priceDollars: z.number().nullish().describe("Price in USD"),
      imageUrl: z
        .string()
        .url()
        .nullish()
        .describe("Image URL to fetch into storage"),
    },
    withErrorHandling(async (args) => {
      if (!UPC_REGEX.test(args.upc)) {
        throw new Error("Invalid UPC. Must be 8, 12, 13, or 14 digits.");
      }
      const existing = await getProduct(db, args.upc);
      if (existing) throw new Error(`Product ${args.upc} already exists.`);

      const imageKey = args.imageUrl
        ? await storeImage(args.upc, args.imageUrl, env)
        : null;
      const product = await createProduct(db, {
        upc: args.upc,
        name: args.name,
        manufacturer: args.manufacturer ?? null,
        brand: args.brand ?? null,
        category: args.category ?? null,
        description: args.description ?? null,
        priceDollars: args.priceDollars ?? null,
        imageKey,
        source: "manual",
        sourceData: null,
      });
      // The UPC now has data — drop it from the misses worklist if it was there.
      await deleteMiss(db, args.upc);
      return json(productToJson(product, baseUrl));
    }),
  );

  server.tool(
    "update_product",
    "Update fields on a cached product. Only provided fields are changed. Stamps updatedAt.",
    {
      upc: z.string().describe("UPC of the product to update"),
      name: z.string().optional(),
      manufacturer: z.string().nullish(),
      brand: z.string().nullish(),
      category: z.string().nullish(),
      description: z.string().nullish(),
      priceDollars: z.number().nullish().describe("Price in USD"),
      imageUrl: z
        .string()
        .url()
        .nullish()
        .describe("New image URL to fetch into storage"),
    },
    withErrorHandling(async (args) => {
      const existing = await getProduct(db, args.upc);
      if (!existing) throw new Error(`Product ${args.upc} not found.`);

      const values: Partial<Omit<NewProduct, "upc">> = {};
      if (args.name !== undefined) values.name = args.name;
      if (args.manufacturer !== undefined)
        values.manufacturer = args.manufacturer;
      if (args.brand !== undefined) values.brand = args.brand;
      if (args.category !== undefined) values.category = args.category;
      if (args.description !== undefined) values.description = args.description;
      if (args.priceDollars !== undefined)
        values.priceDollars = args.priceDollars;
      if (args.imageUrl) {
        values.imageKey =
          (await storeImage(args.upc, args.imageUrl, env)) ?? existing.imageKey;
      }

      const product = await updateProductWithImageCleanup(
        db,
        env,
        args.upc,
        values,
      );
      return json(productToJson(product!, baseUrl));
    }),
  );

  server.tool(
    "refetch_product",
    "Re-run the external lookup for a cached UPC and overwrite its fields and image with fresh data.",
    { upc: z.string().describe("UPC to re-fetch") },
    withErrorHandling(async ({ upc }) => {
      const existing = await getProduct(db, upc);
      if (!existing) throw new Error(`Product ${upc} not found.`);

      const result = await lookupExternalProduct(upc);
      if (result.status !== "found") {
        throw new Error(
          result.status === "error"
            ? `Lookup for ${upc} failed (rate limited or unavailable) — try again later.`
            : `No source had data for ${upc}.`,
        );
      }
      const data = result.data;

      const imageKey = data.imageUrl
        ? ((await storeImage(upc, data.imageUrl, env)) ?? existing.imageKey)
        : existing.imageKey;
      const product = await updateProductWithImageCleanup(db, env, upc, {
        name: data.name,
        manufacturer: data.manufacturer,
        brand: data.brand,
        category: data.category,
        description: data.description,
        priceDollars: data.priceDollars,
        imageKey,
        source: data.source,
        sourceData: data.sourceData,
      });
      return json(productToJson(product!, baseUrl));
    }),
  );

  server.tool(
    "delete_product",
    "Delete a cached product and its stored image.",
    { upc: z.string().describe("UPC to delete") },
    withErrorHandling(async ({ upc }) => {
      const deleted = await deleteProduct(db, env, upc);
      return json({ deleted, upc });
    }),
  );

  server.tool(
    "get_stats",
    "Get cache statistics: total products, per-source counts, and storage usage.",
    {},
    withErrorHandling(async () => json(await getStats(db))),
  );

  return server;
}
