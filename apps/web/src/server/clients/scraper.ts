import type { WScrapedRecipe } from "@cubby/recipebridge";
import { sanitizeSectionName } from "@cubby/schemas/codec";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import {
  assertResponseContentType,
  fetchExternalResponse,
  MAX_EXTERNAL_HTML_BYTES,
  readResponseWithLimit,
  validateExternalHttpUrl,
} from "@cubby/shared/external-fetch";

import { wasm } from "~/lib/wasm";

const isChefStepsHost = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === "chefsteps.com" || host === "www.chefsteps.com";
  } catch {
    return false;
  }
};

const scrapeRecipe = async (url: string) => {
  if (isChefStepsHost(url)) {
    // transform https://www.chefsteps.com/activities/rich-and-moist-cornbread
    // into https://www.chefsteps.com/api/v0/activities/rich-and-moist-cornbread
    const activityId = url.split("/").pop();
    url = `https://www.chefsteps.com/api/v0/activities/${activityId}`;
  }
  const response = await fetchExternalResponse(url, { method: "GET" });
  if (!response.ok)
    throw new Error(`Recipe source returned ${response.status}`);
  assertResponseContentType(response, [
    "text/html",
    "text/plain",
    "application/xhtml+xml",
    "application/json",
  ]);
  const html = new TextDecoder().decode(
    await readResponseWithLimit(response, MAX_EXTERNAL_HTML_BYTES),
  );
  // Note: wasm.parse_scraped_recipe already has tracing via the wasm proxy
  return wasm.parse_scraped_recipe(html, url);
};

export const scrapeToImportRecipe = async (
  url: string,
): Promise<ImportRecipe> => {
  const scraped = await scrapeRecipe(url);
  return scrapedToImportRecipe(scraped);
};

// Parse-only path for pasted HTML — skips the server fetch (which some sites
// block) and runs the same WASM parser + converter as a URL scrape. `url` is
// required: it's the source provenance kept on the recipe and is also used by
// the parser to resolve relative image/source links.
export const htmlToImportRecipe = (html: string, url: string): ImportRecipe => {
  validateExternalHttpUrl(url);
  return scrapedToImportRecipe(wasm.parse_scraped_recipe(html, url));
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
      // JSON-LD durations are ISO-8601, so the scraper always fills a count
      // alongside each prose string — unlike the EPUB path, where a count can
      // legitimately be absent while the string is present.
      times: w.times,
      equipment: w.equipment?.length ? w.equipment : undefined,
    },
    sections: w.sections.map((section) => ({
      name: sanitizeSectionName(section.name) ?? undefined,
      ingredients: section.ingredients,
      parsedIngredients: section.parsed_ingredients,
      instructions: section.instructions,
    })),
    servings: w.servings,
    image: w.image ? { kind: "url", url: w.image } : undefined,
    // Carried for provenance; the converter doesn't store it yet (see docs/todos).
    url: w.url,
  };
};
