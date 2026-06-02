import { describe, expect, test } from "vitest";
import cookbookSample from "./__fixtures__/cookbook.sample.json";
import { cookbookRecipesSchema } from "./cookbook";

describe("cookbookRecipesSchema", () => {
  // Drift alarm for the unspoken syntax agreement with ../ingredient-parser.
  // `cookbook.sample.json` is a faithful `food-cli scrape-epub <book>.epub --json`
  // payload (the `recipe-epub` crate's `Vec<CookbookRecipe>`). If the Rust output
  // shape changes, regenerate the fixture and update `cookbook.ts` to match:
  //   cargo run -p food-cli -- scrape-epub <book>.epub --json > \
  //     packages/schemas/src/__fixtures__/cookbook.sample.json
  test("accepts a real food-cli cookbook JSON payload", () => {
    const result = cookbookRecipesSchema.safeParse(cookbookSample);

    expect(result.success).toBe(true);
    // Spot-check the shape survived: named sections, metadata, and a resolved
    // cross-recipe reference all round-trip.
    expect(result.data?.[0]?.meta.title).toBe("Apple Galette");
    expect(result.data?.[0]?.sections[0]?.name).toBe("For the crust");
    expect(result.data?.[0]?.references[0]?.confidence).toBe("title_match");
  });

  test("accepts a food-cli --json array (instructions default to [])", () => {
    const result = cookbookRecipesSchema.safeParse([
      {
        meta: { title: "Soup" },
        sections: [{ ingredients: ["1 onion"] }],
        source: "book.epub",
      },
    ]);

    expect(result.success).toBe(true);
    expect(result.data?.[0]?.sections[0]?.instructions).toEqual([]);
  });

  test("rejects a section missing ingredients", () => {
    const result = cookbookRecipesSchema.safeParse([
      { meta: { title: "Bad" }, sections: [{ instructions: ["step"] }] },
    ]);

    expect(result.success).toBe(false);
  });

  test("references default to [] and parse cross-recipe pointers", () => {
    const result = cookbookRecipesSchema.safeParse([
      // no references key → defaults to []
      { meta: { title: "Plain" }, sections: [{ ingredients: ["1 egg"] }] },
      {
        meta: { title: "Galette" },
        sections: [{ ingredients: ["1 recipe The Only Piecrust"] }],
        references: [
          {
            title: "The Only Piecrust",
            line: "1 recipe The Only Piecrust",
            confidence: "title_match",
          },
        ],
      },
    ]);

    expect(result.success).toBe(true);
    expect(result.data?.[0]?.references).toEqual([]);
    expect(result.data?.[1]?.references[0]?.title).toBe("The Only Piecrust");
    expect(result.data?.[1]?.references[0]?.confidence).toBe("title_match");
  });

  test("rejects an invalid reference confidence", () => {
    const result = cookbookRecipesSchema.safeParse([
      {
        meta: { title: "X" },
        sections: [{ ingredients: ["a"] }],
        references: [{ title: "Y", line: "1 Y", confidence: "guess" }],
      },
    ]);

    expect(result.success).toBe(false);
  });
});
