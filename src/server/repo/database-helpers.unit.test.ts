import { describe, it, expect } from "vitest";
import {
  formatSearchTerm,
  getSortDirection,
} from "~/server/repo/database-helpers";

describe("formatSearchTerm", () => {
  it("should return undefined for undefined input", () => {
    expect(formatSearchTerm(undefined)).toBeUndefined();
  });

  it("should return undefined for empty string", () => {
    expect(formatSearchTerm("")).toBeUndefined();
  });

  it("should return undefined for whitespace only string", () => {
    expect(formatSearchTerm("   ")).toBeUndefined();
  });

  it("should return contains filter for valid term", () => {
    const result = formatSearchTerm("chicken");
    expect(result).toEqual({
      contains: "chicken",
      mode: "insensitive",
    });
  });

  it("should handle multi-word terms", () => {
    const result = formatSearchTerm("chicken breast");
    expect(result).toEqual({
      contains: "chicken breast",
      mode: "insensitive",
    });
  });
});

describe("getSortDirection", () => {
  it("should return direction when field matches orderBy", () => {
    const sort = { orderBy: "name", direction: "asc" as const };
    expect(getSortDirection(sort, "name")).toBe("asc");
  });

  it("should return undefined when field does not match orderBy", () => {
    const sort = { orderBy: "name", direction: "asc" as const };
    expect(getSortDirection(sort, "createdAt")).toBeUndefined();
  });

  it("should handle desc direction", () => {
    const sort = { orderBy: "createdAt", direction: "desc" as const };
    expect(getSortDirection(sort, "createdAt")).toBe("desc");
  });
});
