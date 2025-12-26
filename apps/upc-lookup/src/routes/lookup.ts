import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { createDb, schema } from "../db";
import { lookupExternalProduct } from "../api";
import { storeImage, getImageUrl } from "../storage/images";
import type {
  ProductLookupResponse,
  ProductNotFoundResponse,
} from "../schemas/product";

const lookup = new Hono<{ Bindings: Env }>();

// UPC validation regex (8, 12, 13, or 14 digits)
const UPC_REGEX = /^\d{8}$|^\d{12,14}$/;

lookup.get("/:upc", async (c) => {
  const upc = c.req.param("upc");
  const baseUrl = new URL(c.req.url).origin;

  // Validate UPC format
  if (!UPC_REGEX.test(upc)) {
    return c.json(
      {
        error: "Invalid UPC format. Must be 8, 12, 13, or 14 digits.",
        code: "INVALID_UPC",
      },
      400,
    );
  }

  const db = createDb(c.env.DB);

  // Check D1 cache first
  const cached = await db.query.products.findFirst({
    where: eq(schema.products.upc, upc),
  });

  if (cached) {
    const response: ProductLookupResponse = {
      upc: cached.upc,
      name: cached.name,
      manufacturer: cached.manufacturer,
      brand: cached.brand,
      category: cached.category,
      description: cached.description,
      priceDollars: cached.priceDollars,
      imageUrl: cached.imageKey ? getImageUrl(cached.imageKey, baseUrl) : null,
      source: cached.source as "upcitemdb",
      cached: true,
    };
    return c.json(response);
  }

  // Cache miss - lookup from external APIs
  const externalData = await lookupExternalProduct(upc);

  if (!externalData) {
    const notFound: ProductNotFoundResponse = { found: false, upc };
    return c.json(notFound, 404);
  }

  // Store image in R2 (non-blocking failure)
  let imageKey: string | null = null;
  if (externalData.imageUrl) {
    imageKey = await storeImage(upc, externalData.imageUrl, c.env);
  }

  // Store in D1 cache
  await db.insert(schema.products).values({
    upc,
    name: externalData.name,
    manufacturer: externalData.manufacturer,
    brand: externalData.brand,
    category: externalData.category,
    description: externalData.description,
    priceDollars: externalData.priceDollars,
    imageKey,
    source: externalData.source,
    sourceData: externalData.sourceData,
  });

  const response: ProductLookupResponse = {
    upc,
    name: externalData.name,
    manufacturer: externalData.manufacturer,
    brand: externalData.brand,
    category: externalData.category,
    description: externalData.description,
    priceDollars: externalData.priceDollars,
    imageUrl: imageKey ? getImageUrl(imageKey, baseUrl) : null,
    source: externalData.source,
    cached: false,
  };

  return c.json(response);
});

export { lookup };
