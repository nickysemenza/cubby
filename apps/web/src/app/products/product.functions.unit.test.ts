import { describe, expect, it } from "vitest";
import { product } from "./product.functions";

describe("product.relationshipRoute cache coverage", () => {
  it("is invalidated by every direct and derived relationship root", () => {
    expect(product.relationshipRoute.definition.tags).toEqual([
      ["product"],
      ["product", "relationshipRoute"],
      ["inventory"],
      ["location"],
      ["expense"],
      ["purchase"],
      ["project"],
      ["project", "resource"],
      ["task"],
      ["vendor"],
    ]);
  });
});
