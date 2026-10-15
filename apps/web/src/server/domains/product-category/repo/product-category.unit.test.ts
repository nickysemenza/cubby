import { describe, expect, it } from "vitest";

import { mapCategorySummary } from "./product-category";

describe("mapCategorySummary", () => {
  it("emits a root-first path and inherits the closest feature binding", () => {
    expect(
      mapCategorySummary({
        shortcode: "CAT-CCCC",
        name: "Pasta",
        feature: null,
        parent: {
          shortcode: "CAT-BBBB",
          name: "Pantry",
          feature: null,
          parent: {
            shortcode: "CAT-AAAA",
            name: "Food",
            feature: "food",
          },
        },
      }),
    ).toEqual({
      id: "CAT-CCCC",
      name: "Pasta",
      path: [
        { id: "CAT-AAAA", name: "Food" },
        { id: "CAT-BBBB", name: "Pantry" },
        { id: "CAT-CCCC", name: "Pasta" },
      ],
      feature: "food",
    });
  });
});
