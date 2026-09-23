import { describe, expect, it } from "vitest";

import { buildCategoryHierarchy } from "./category-tree";

const cat = (
  id: string,
  parentId: string | null,
  feature: "tools" | "food" | null = null,
) => ({ id, parentId, name: id, feature });

describe("buildCategoryHierarchy", () => {
  it("rolls direct counts up and inherits the closest feature", () => {
    const root = buildCategoryHierarchy(
      [cat("tools", null, "tools"), cat("hw", "tools"), cat("screws", "hw")],
      new Map([
        ["hw", 2],
        ["screws", 5],
      ]),
    );
    const tools = root.children?.[0];
    const hw = tools?.children?.[0];
    expect(root.totalCount).toBe(7);
    expect(tools).toMatchObject({ directCount: 0, totalCount: 7 });
    expect(hw).toMatchObject({
      directCount: 2,
      totalCount: 7,
      feature: "tools",
    });
    expect(hw?.children?.[0]).toMatchObject({
      totalCount: 5,
      feature: "tools",
    });
  });
});
