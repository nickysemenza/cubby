import { z } from "zod";

const jsonBodySchema = z.json();
type JsonBody = z.input<typeof jsonBodySchema>;

const json = (body: JsonBody, status = 200): Response =>
  Response.json(body, { status });

/**
 * Deterministic local replacement for the USDA service binding. It keeps E2E
 * on the production Fetcher route without shipping the auxiliary Worker's D1
 * dataset into this browser suite.
 */
export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);

    if (pathname === "/counts") {
      return json({
        usda_food: 0,
        usda_branded_food: 0,
        usda_nutrient: 0,
        usda_food_nutrient: 0,
        usda_measure_unit: 0,
        usda_food_portion: 0,
        usda_sr_legacy_food: 0,
      });
    }
    if (pathname === "/api/foods/search/batch") {
      return json({ results: [] });
    }
    if (pathname === "/api/foods/search") return json(null);
    if (pathname === "/api/foods") return json({ data: [], count: 0 });

    return json({ error: "Food not found" }, 404);
  },
};
