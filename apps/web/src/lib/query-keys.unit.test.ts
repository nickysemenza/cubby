import { describe, expect, it } from "vitest";
import { normalizeTRPCQueryKey } from "./query-keys";

describe("normalizeTRPCQueryKey", () => {
  it("wraps canonical router keys in the tRPC query-key tuple", () => {
    expect(normalizeTRPCQueryKey(["product"])).toEqual([["product"]]);
    expect(normalizeTRPCQueryKey(["inventory", "list"])).toEqual([
      ["inventory", "list"],
    ]);
  });

  it("leaves generated tRPC query keys unchanged", () => {
    const key = [["product", "list"], { input: { json: null } }];
    expect(normalizeTRPCQueryKey(key)).toBe(key);
  });
});
