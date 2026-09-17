import { describe, expect, it } from "vitest";

import { filterOptionsInput } from "./filter-options";

describe("filterOptionsInput", () => {
  it("keeps the existing scoped-roster wire shape valid", () => {
    expect(filterOptionsInput.parse({ kind: "project" })).toMatchObject({
      kind: "project",
      search: "",
      selectedIds: [],
      limit: 25,
    });
  });

  it("accepts generic sources only for shortcode-backed entities", () => {
    expect(
      filterOptionsInput.parse({ source: "entity", entity: "ingredient" }),
    ).toMatchObject({ source: "entity", entity: "ingredient" });
    expect(() =>
      filterOptionsInput.parse({ source: "entity", entity: "usda-food" }),
    ).toThrow("must identify an entity with public shortcodes");
  });
});
