import type { WCompactRecipe } from "@cubby/recipebridge";
import { type CompactRecipe, sanitizeSectionName } from "@cubby/schemas/codec";
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
export const WCompactToCompact = (wCompact: WCompactRecipe): CompactRecipe => {
  return {
    name: wCompact.name ?? "",
    sections: wCompact.sections.map((section) => ({
      name: sanitizeSectionName(section.name),
      ingredients: section.ingredients,
      instructions: section.instructions,
    })),
    // Pass through yield, servings, and image from scraper (parsed by Rust)
    recipe_yield: wCompact.recipe_yield,
    servings: wCompact.servings,
    image: wCompact.image,
  };
};
