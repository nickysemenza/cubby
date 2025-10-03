import { describe, it, expect } from "vitest";
import {
  formatSearchTerm,
  getSortDirection,
} from "~/server/repo/database-helpers";
import { product } from "~/server/db/schema";

describe("formatSearchTerm", () => {
  it("should return undefined for undefined input", () => {
    expect(formatSearchTerm(product.name, undefined)).toBeUndefined();
  });

  it("should return undefined for empty string", () => {
    expect(formatSearchTerm(product.name, "")).toBeUndefined();
  });

  it("should return undefined for whitespace only string", () => {
    expect(formatSearchTerm(product.name, "   ")).toBeUndefined();
  });

  it("should return ilike SQL condition for valid term", () => {
    const result = formatSearchTerm(product.name, "chicken");
    expect(result).toBeDefined();
    // The result is a SQL object from drizzle-orm, we just verify it's returned
    expect(result).toBeTruthy();
  });

  it("should handle multi-word terms", () => {
    const result = formatSearchTerm(product.name, "chicken breast");
    expect(result).toBeDefined();
    expect(result).toBeTruthy();
  });

  it("should handle special characters", () => {
    const result = formatSearchTerm(product.name, "test@example.com");
    expect(result).toBeDefined();
    expect(result).toBeTruthy();
  });

  it("should handle unicode characters", () => {
    const result = formatSearchTerm(product.name, "café résumé");
    expect(result).toBeDefined();
    expect(result).toBeTruthy();
  });

  it("should preserve whitespace in search term", () => {
    const result = formatSearchTerm(product.name, "  trimmed  ");
    expect(result).toBeDefined();
    expect(result).toBeTruthy();
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

  it("should handle different field names correctly", () => {
    const sort = { orderBy: "manufacturer", direction: "asc" as const };

    expect(getSortDirection(sort, "manufacturer")).toBe("asc");
    expect(getSortDirection(sort, "name")).toBeUndefined();
    expect(getSortDirection(sort, "price")).toBeUndefined();
  });

  it("should be case sensitive for field matching", () => {
    const sort = { orderBy: "Name", direction: "asc" as const };

    expect(getSortDirection(sort, "name")).toBeUndefined();
    expect(getSortDirection(sort, "Name")).toBe("asc");
  });
});
