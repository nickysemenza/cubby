import type { WScrapedRecipe } from "@cubby/recipebridge";
import { sanitizeSectionName } from "@cubby/schemas/codec";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import { wasm } from "~/lib/wasm";

const scrapeRecipe = async (url: string) => {
  if (url.includes("chefsteps.com")) {
    // transform https://www.chefsteps.com/activities/rich-and-moist-cornbread
    // into https://www.chefsteps.com/api/v0/activities/rich-and-moist-cornbread
    const activityId = url.split("/").pop();
    url = `https://www.chefsteps.com/api/v0/activities/${activityId}`;
  }
  const response = await fetch(url, { method: "GET" });
  const html = await response.text();
  // Note: wasm.parse_scraped_recipe already has tracing via the wasm proxy
  return wasm.parse_scraped_recipe(html, url);
};

export const scrapeToImportRecipe = async (
  url: string,
): Promise<ImportRecipe> => {
  const scraped = await scrapeRecipe(url);
  return scrapedToImportRecipe(scraped);
};

// The scraper's WASM output → the shared `ImportRecipe` carrier. Yield arrives
// already structured (`{value, unit}`) — the union's object branch; the import
// converter uses it directly without re-parsing.
export const scrapedToImportRecipe = (w: WScrapedRecipe): ImportRecipe => {
  return {
    meta: {
      title: w.name ?? "",
      description: w.description,
      recipe_yield: w.recipe_yield,
    },
    sections: w.sections.map((section) => ({
      name: sanitizeSectionName(section.name) ?? undefined,
      ingredients: section.ingredients,
      instructions: section.instructions,
    })),
    references: [],
    servings: w.servings,
    image: w.image,
    // Carried for provenance; the converter doesn't store it yet (see docs/todos).
    url: w.url,
  };
};
