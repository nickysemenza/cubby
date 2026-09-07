import { parse_scraped_recipe } from "@cubby/recipebridge";
import { describe, expect, it } from "vitest";

import { scrapedToImportRecipe } from "./scraper";

// Regression coverage for the section-aware scrape boundary. A live HTTP scrape
// is intentionally NOT exercised here — the scrape mutation fetches the URL
// server-side, so a real fetch would be network-dependent and flaky in CI. This
// instead feeds fixture HTML through the WASM scraper and the scrapedToImportRecipe
// transform, which is exactly the layer that breaks when the upstream
// ingredient-parser recipe schema changes shape.

interface RecipeJsonLd {
  "@context": string;
  "@type": "Recipe";
  name: string;
  image?: string;
  recipeYield?: string;
  recipeIngredient: string[];
  recipeInstructions: Array<{ "@type": "HowToStep"; text: string }>;
}

const recipeHtml = (jsonLd: RecipeJsonLd) =>
  `<!DOCTYPE html><html><head><script type="application/ld+json">${JSON.stringify(
    jsonLd,
  )}</script></head><body></body></html>`;

describe("parse_scraped_recipe → scrapedToImportRecipe", () => {
  it("maps a single-section recipe into import sections with raw lines", () => {
    const html = recipeHtml({
      "@context": "https://schema.org",
      "@type": "Recipe",
      name: "Test Pancakes",
      image: "https://example.com/pancakes.jpg",
      recipeYield: "12 pancakes",
      recipeIngredient: ["2 cups flour", "1 cup milk"],
      recipeInstructions: [
        { "@type": "HowToStep", text: "Mix the dry ingredients." },
        { "@type": "HowToStep", text: "Whisk in the wet ingredients." },
      ],
    });

    const recipe = scrapedToImportRecipe(
      parse_scraped_recipe(html, "https://example.com/pancakes"),
    );

    expect(recipe.meta.title).toBe("Test Pancakes");
    expect(recipe.sections).toHaveLength(1);
    expect(recipe.sections[0]?.ingredients).toEqual([
      "2 cups flour",
      "1 cup milk",
    ]);
    expect(recipe.sections[0]?.instructions).toHaveLength(2);
    // Unnamed main section.
    expect(recipe.sections[0]?.name).toBeUndefined();
    // Image is passed through for auto-import.
    expect(recipe.image).toEqual({
      kind: "url",
      url: "https://example.com/pancakes.jpg",
    });
  });

  // End-to-end coverage that the WASM scraper (recipe-scraper crate) decodes
  // HTML entities in JSON-LD — including the double-encoding that round-trips
  // through inner_html() + store (a page's `&#39;` becomes the literal
  // `&amp;#39;`). Regression for titles stored as "The Food Lab&amp;#39;s …".
  it("decodes double-encoded HTML entities in the title", () => {
    const recipe = scrapedToImportRecipe(
      parse_scraped_recipe(
        recipeHtml({
          "@context": "https://schema.org",
          "@type": "Recipe",
          name: "The Food Lab&amp;#39;s Chocolate Chip Cookies",
          recipeIngredient: ["1 cup flour"],
          recipeInstructions: [{ "@type": "HowToStep", text: "Bake." }],
        }),
        "https://example.com/cookies",
      ),
    );

    expect(recipe.meta.title).toBe("The Food Lab's Chocolate Chip Cookies");
  });

  // The upstream clean_text loop handles single-encoding too (a page that ships
  // `&#39;` directly), not just the double-encoded round-trip above.
  it("decodes single-encoded HTML entities in the title", () => {
    const recipe = scrapedToImportRecipe(
      parse_scraped_recipe(
        recipeHtml({
          "@context": "https://schema.org",
          "@type": "Recipe",
          name: "Rosa&#39;s Cookies",
          recipeIngredient: ["1 cup flour"],
          recipeInstructions: [{ "@type": "HowToStep", text: "Bake." }],
        }),
        "https://example.com/rosas-cookies",
      ),
    );

    expect(recipe.meta.title).toBe("Rosa's Cookies");
  });

  it("does not expose the legacy flat ingredients/instructions fields", () => {
    const raw = parse_scraped_recipe(
      recipeHtml({
        "@context": "https://schema.org",
        "@type": "Recipe",
        name: "X",
        recipeIngredient: ["1 egg"],
        recipeInstructions: [{ "@type": "HowToStep", text: "Cook it." }],
      }),
      "https://example.com/x",
    );

    expect(raw.sections).toBeDefined();
    expect("ingredients" in raw).toBe(false);
    expect("instructions" in raw).toBe(false);
  });
});
