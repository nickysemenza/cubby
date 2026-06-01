import { parse_scraped_recipe } from "@cubby/recipebridge";
import { describe, expect, it } from "vitest";
import { WCompactToCompact } from "./scraper";

// Regression coverage for the section-aware scrape boundary. A live HTTP scrape
// is intentionally NOT exercised here — the scrape mutation fetches the URL
// server-side, so a real fetch would be network-dependent and flaky in CI. This
// instead feeds fixture HTML through the WASM scraper and the WCompactToCompact
// transform, which is exactly the layer that breaks when the upstream
// ingredient-parser recipe schema changes shape.

const recipeHtml = (jsonLd: object) =>
  `<!DOCTYPE html><html><head><script type="application/ld+json">${JSON.stringify(
    jsonLd,
  )}</script></head><body></body></html>`;

describe("parse_scraped_recipe → WCompactToCompact", () => {
  it("maps a single-section recipe into compact sections with parsed amounts", () => {
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

    const compact = WCompactToCompact(
      parse_scraped_recipe(html, "https://example.com/pancakes"),
    );

    expect(compact.name).toBe("Test Pancakes");
    expect(compact.sections).toHaveLength(1);
    expect(compact.sections[0]?.ingredients).toEqual([
      "2 cups flour",
      "1 cup milk",
    ]);
    expect(compact.sections[0]?.instructions).toHaveLength(2);
    // Unnamed main section.
    expect(compact.sections[0]?.name).toBeNull();
    // Image is passed through for auto-import.
    expect(compact.image).toBe("https://example.com/pancakes.jpg");
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
    ) as unknown as Record<string, unknown>;

    expect(raw.sections).toBeDefined();
    expect(raw.ingredients).toBeUndefined();
    expect(raw.instructions).toBeUndefined();
  });
});
