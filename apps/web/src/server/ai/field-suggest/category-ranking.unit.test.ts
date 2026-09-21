import { describe, expect, it } from "vitest";

import { rankCategoryCandidates } from "./category-ranking";

describe("classification candidate ranking", () => {
  it("uses aliases and descriptions while retaining broad and unrelated choices", () => {
    const root = { name: "Apparel", path: [{ name: "Apparel" }] };
    const unrelated = { name: "Books", path: [{ name: "Books" }] };
    const relevant = {
      name: "Jackets",
      aliases: ["rain shell"],
      description: "Waterproof outer layer",
      path: [{ name: "Apparel" }, { name: "Clothes" }, { name: "Jackets" }],
    };
    expect(
      rankCategoryCandidates([root, unrelated, relevant], {
        name: "Waterproof rain shell",
      }),
    ).toEqual([relevant, root, unrelated]);
  });
});
