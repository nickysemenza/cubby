import { describe, expect, it } from "vitest";

import { product } from "./product.functions";

describe("product.kitComponentRows input", () => {
  it("accepts the empty loaded-page kit set used by the dormant products query", () => {
    expect(
      product.kitComponentRows.queryOptions({ parentProductIds: [] }).queryKey,
    ).toEqual([
      "operation",
      "product.kitComponentRows",
      { input: { parentProductIds: [] } },
    ]);
  });
});
