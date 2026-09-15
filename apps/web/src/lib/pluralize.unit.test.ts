import { describe, expect, it } from "vitest";

import { countLabel, pluralWord } from "./pluralize";

describe("pluralWord", () => {
  it("singular for count === 1", () => {
    expect(pluralWord("planting", 1)).toBe("planting");
  });

  it("plural for count !== 1", () => {
    expect(pluralWord("planting", 0)).toBe("plantings");
    expect(pluralWord("planting", 3)).toBe("plantings");
  });

  it("handles irregular plurals", () => {
    expect(pluralWord("box", 2)).toBe("boxes");
    expect(pluralWord("child", 2)).toBe("children");
  });
});

describe("countLabel", () => {
  it("renders '1 planting' and '3 plantings'", () => {
    expect(countLabel(1, "planting")).toBe("1 planting");
    expect(countLabel(3, "planting")).toBe("3 plantings");
  });

  it("uses formatCount's thousands separators when formatted is true", () => {
    expect(countLabel(1240, "planting", { formatted: true })).toBe(
      "1,240 plantings",
    );
  });

  it("does not add thousands separators by default", () => {
    expect(countLabel(1240, "planting")).toBe("1240 plantings");
  });
});
