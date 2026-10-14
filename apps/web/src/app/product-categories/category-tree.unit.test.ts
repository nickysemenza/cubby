import { describe, expect, it } from "vitest";

import { buildCategoryHierarchy } from "./category-tree";

type Cat = Parameters<typeof buildCategoryHierarchy>[0][number];
const cat = (
  id: string,
  feature: Cat["feature"] = null,
  children?: Cat[],
): Cat => ({
  id,
  name: id,
  feature,
  ...(children ? { subRows: children } : {}),
});

describe("buildCategoryHierarchy", () => {
  it("rolls direct counts up and inherits the closest feature", () => {
    const root = buildCategoryHierarchy(
      [cat("tools", "tools", [cat("hw", null, [cat("screws")])])],
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
