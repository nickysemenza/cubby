import { z } from "zod";

const jsonBodySchema = z.json();
type JsonBody = z.input<typeof jsonBodySchema>;

const json = (body: JsonBody, status = 200): Response =>
  Response.json(body, { status });

/**
 * Deterministic local replacement for the UPC service binding. Empty results
 * are valid provider responses, so browser tests retain the real binding path
 * without loading the production Worker's D1/R2 data.
 */
export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);

    if (pathname === "/lookup/batch") {
      return json({ products: [], pending: 0 });
    }
    if (pathname === "/search") return json({ products: [], total: 0 });
    if (pathname.startsWith("/lookup/")) {
      return json(
        { found: false, upc: pathname.slice("/lookup/".length) },
        404,
      );
    }

    return json({ products: [], total: 0 });
  },
};
