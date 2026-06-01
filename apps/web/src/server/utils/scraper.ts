import type { WCompactRecipe } from "@cubby/recipebridge";
import type { CompactRecipe } from "@cubby/schemas/codec";
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

export const scrapeToCompact = async (url: string): Promise<CompactRecipe> => {
  const scraped = await scrapeRecipe(url);
  const compact: CompactRecipe = WCompactToCompact(scraped);
  return compact;
};
const WCompactToCompact = (wCompact: WCompactRecipe): CompactRecipe => {
  return {
    name: wCompact.name ?? "",
    sections: wCompact.sections.map((section) => ({
      name: section.name ?? null,
      ingredients: section.ingredients,
      instructions: section.instructions,
    })),
    // Pass through yield and servings from scraper (already parsed by Rust)
    recipe_yield: wCompact.recipe_yield,
    servings: wCompact.servings,
  };
};
