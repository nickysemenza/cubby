import { describe, it, expect } from "vitest";
import { toFtsQuery } from "./fts-query";

describe("toFtsQuery", () => {
  it("should handle empty or whitespace-only input", () => {
    expect(toFtsQuery("")).toBe("");
    expect(toFtsQuery("   ")).toBe("");
    expect(toFtsQuery("\t\n")).toBe("");
  });

  it("should handle single term", () => {
    expect(toFtsQuery("apple")).toBe("apple*");
  });

  it("should handle multiple terms", () => {
    expect(toFtsQuery("apple juice")).toBe("apple juice*");
    expect(toFtsQuery("red apple juice")).toBe("red apple juice*");
  });

  it("should normalize whitespace", () => {
    expect(toFtsQuery("  apple   juice  ")).toBe("apple juice*");
    expect(toFtsQuery("apple\tjuice\n")).toBe("apple juice*");
  });

  it("should escape quotes", () => {
    expect(toFtsQuery('apple "juice"')).toBe("apple juice*");
    expect(toFtsQuery("apple 'juice'")).toBe("apple juice*");
    expect(toFtsQuery('"brand name"')).toBe("brand name*");
  });

  it("should handle mixed quotes and spaces", () => {
    expect(toFtsQuery("  \"apple\"  'juice'  ")).toBe("apple juice*");
  });

  it("should add prefix wildcard only to last term", () => {
    expect(toFtsQuery("organic apple")).toBe("organic apple*");
    expect(toFtsQuery("red organic apple")).toBe("red organic apple*");
  });

  it("should handle complex real-world searches", () => {
    expect(toFtsQuery("Coca Cola Original")).toBe("Coca Cola Original*");
    expect(toFtsQuery("Kraft Mac & Cheese")).toBe("Kraft Mac & Cheese*");
    expect(toFtsQuery("Uncle Ben's Rice")).toBe("Uncle Ben s Rice*");
  });
});
