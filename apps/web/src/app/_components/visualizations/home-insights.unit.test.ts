import { describe, expect, it } from "vitest";

import { productSearchSchema } from "~/entities/list-search";

import {
  LOCATION_SUNBURST_DESCRIPTION,
  LOCATION_SUNBURST_METRIC,
} from "./location-sunburst";
import { productCategoryDrilldown } from "./product-category-donut";

describe("Home insight metric and drilldown contracts", () => {
  it("describes the same item-count metric that sizes the location rings", () => {
    expect(LOCATION_SUNBURST_METRIC).toBe("itemCount");
    expect(LOCATION_SUNBURST_DESCRIPTION).toContain("item counts");
    expect(LOCATION_SUNBURST_DESCRIPTION).not.toContain("value");
  });

  it("routes the uncategorized slice to the null-category roster", () => {
    expect(productSearchSchema.parse(productCategoryDrilldown(null))).toEqual({
      category: "__none__",
    });
    expect(productCategoryDrilldown("food")).toEqual({ category: "food" });
  });
});
