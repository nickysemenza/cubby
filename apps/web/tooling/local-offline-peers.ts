/** Local responses for the external service bindings; the Cubby Worker itself is the production build. */
export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);

    if (pathname === "/counts") {
      return Response.json({
        usda_food: 0,
        usda_branded_food: 0,
        usda_nutrient: 0,
        usda_food_nutrient: 0,
        usda_measure_unit: 0,
        usda_food_portion: 0,
        usda_sr_legacy_food: 0,
      });
    }
    if (pathname === "/api/foods/search/batch")
      return Response.json({ results: [] });
    if (pathname === "/api/foods/search") return Response.json(null);
    if (pathname === "/api/foods") return Response.json({ data: [], count: 0 });
    if (pathname.startsWith("/api/foods/"))
      return Response.json({ error: "Food not found" }, { status: 404 });

    return Response.json(
      { error: "External service is unavailable in this local run" },
      { status: 503 },
    );
  },
  queue(): void {},
};
