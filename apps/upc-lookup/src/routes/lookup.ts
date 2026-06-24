import { withSpan } from "@cubby/worker-tracing";
import { Hono } from "hono";
import { uniq } from "es-toolkit";
import type { Env } from "../types";
import { createDb } from "../db";
import { getProducts } from "../db/products";
import { getFreshMisses } from "../db/misses";
import { resolveProduct, resolveProductOutcome } from "../services/products";
import { getImageUrl } from "../storage/images";
import { bulkLookupRequestSchema } from "../schemas/product";
import type {
  ProductLookupResponse,
  ProductNotFoundResponse,
} from "../schemas/product";
import type { Product } from "../db/schema";
import { UPC_REGEX } from "../util/upc";

const lookup = new Hono<{ Bindings: Env }>();

// Per-request cap on background first-try external lookups. With negative
// caching each UPC is tried at most once, so this only paces the one-time
// backlog drain against upcitemdb's ~100/day quota.
const BULK_FIRST_TRY_LIMIT = 10;

/** Map a cached product row to the public response shape (sans `cached`). */
function toResponse(
  p: Product,
  baseUrl: string,
): Omit<ProductLookupResponse, "cached"> {
  return {
    upc: p.upc,
    name: p.name,
    manufacturer: p.manufacturer,
    brand: p.brand,
    category: p.category,
    description: p.description,
    priceDollars: p.priceDollars,
    imageUrl: p.imageKey ? getImageUrl(p.imageKey, baseUrl) : null,
    source: p.source,
  };
}

/**
 * Bulk cache-read for many UPCs. Returns the cached products immediately
 * (one IN query, no external calls), then kicks off a bounded background
 * first-try for never-checked UPCs so their results land on the next call.
 * Stops the first-try loop on the first transient error (likely a 429) to
 * avoid hammering past the external quota.
 */
lookup.post("/batch", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = bulkLookupRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request body. Expected { upcs: string[] }.",
        code: "INVALID_REQUEST",
      },
      400,
    );
  }

  const baseUrl = new URL(c.req.url).origin;
  const db = createDb(c.env.DB);

  // Dedupe + drop malformed UPCs.
  const upcs = uniq(parsed.data.upcs).filter((u) => UPC_REGEX.test(u));

  // Read products and fresh misses concurrently over the full UPC set — they're
  // two independent D1 round-trips, and product PKs vs. miss PKs are effectively
  // disjoint, so querying misses for the few UPCs that turn out to be products
  // costs nothing. (Was sequential: getProducts → getFreshMisses(remaining).)
  const { found, freshMisses } = await withSpan(
    "upc.batchRead",
    async (span) => {
      const [found, freshMisses] = await Promise.all([
        getProducts(db, upcs),
        getFreshMisses(db, upcs),
      ]);
      span.setAttributes({
        upcCount: upcs.length,
        foundCount: found.length,
        missCount: freshMisses.size,
      });
      return { found, freshMisses };
    },
    { upcCount: upcs.length },
  );
  const foundSet = new Set(found.map((p) => p.upc));

  const neverChecked = upcs.filter(
    (u) => !foundSet.has(u) && !freshMisses.has(u),
  );

  const products = found.map((p) => toResponse(p, baseUrl));

  if (neverChecked.length > 0) {
    const toTry = neverChecked.slice(0, BULK_FIRST_TRY_LIMIT);
    c.executionCtx.waitUntil(runFirstTries(c.env, toTry));
  }

  return c.json({ products, pending: neverChecked.length });
});

/**
 * Resolve never-checked UPCs one at a time (recording hits as products and
 * definitive misses in `upc_misses`). Stops on the first transient error so we
 * don't keep calling upcitemdb after hitting its rate limit.
 */
async function runFirstTries(env: Env, upcs: string[]): Promise<void> {
  // Runs under waitUntil (outside the response), so trace it as its own span to
  // see how many never-checked UPCs got an external first-try and whether the
  // loop bailed on a transient error (likely a 429).
  await withSpan(
    "upc.firstTries",
    async (span) => {
      const db = createDb(env.DB);
      let tried = 0;
      let errored = false;
      for (const upc of upcs) {
        const outcome = await resolveProductOutcome(db, env, upc);
        tried += 1;
        if (outcome.status === "error") {
          errored = true;
          break;
        }
      }
      span.setAttributes({ requested: upcs.length, tried, errored });
    },
    { requested: upcs.length },
  );
}

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
    ...toResponse(product, baseUrl),
    cached,
  };
  return c.json(response);
});

export { lookup };
