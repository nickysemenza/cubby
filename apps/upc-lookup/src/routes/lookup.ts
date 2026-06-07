import { Hono } from "hono";
import type { Env } from "../types";
import { createDb } from "../db";
import { resolveProduct } from "../services/products";
import { getImageUrl } from "../storage/images";
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
  const result = await resolveProduct(db, c.env, upc);

  if (!result) {
    const notFound: ProductNotFoundResponse = { found: false, upc };
    return c.json(notFound, 404);
  }

  const { product, cached } = result;
  const response: ProductLookupResponse = {
    upc: product.upc,
    name: product.name,
    manufacturer: product.manufacturer,
    brand: product.brand,
    category: product.category,
    description: product.description,
    priceDollars: product.priceDollars,
    imageUrl: product.imageKey ? getImageUrl(product.imageKey, baseUrl) : null,
    source: product.source,
    cached,
  };
  return c.json(response);
});

export { lookup };
