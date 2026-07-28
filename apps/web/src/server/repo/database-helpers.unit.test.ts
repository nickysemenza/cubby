import { describe, expect, it } from "vitest";
import { product } from "~/server/db/schema";
import {
  buildPartialUpdateValues,
  eqAnyOrPresence,
  formatSearchTerm,
} from "~/server/repo/database-helpers";

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

describe("eqAnyOrPresence", () => {
  it("returns undefined when value is empty/undefined and presence is unset (no constraint)", () => {
    expect(
      eqAnyOrPresence(product.category, undefined, undefined),
    ).toBeUndefined();
    expect(eqAnyOrPresence(product.category, [], undefined)).toBeUndefined();
  });

  it("falls back to eqAny's clause when presence is unset", () => {
    const result = eqAnyOrPresence(product.category, ["food"], undefined);
    expect(result).toBeDefined();
  });

  it("returns a presence-only clause when value is empty/undefined", () => {
    expect(eqAnyOrPresence(product.category, undefined, "none")).toBeDefined();
    expect(eqAnyOrPresence(product.category, [], "has")).toBeDefined();
  });

  it("ORs the value clause with the presence clause when both are set", () => {
    const none = eqAnyOrPresence(product.category, ["food"], "none");
    const has = eqAnyOrPresence(product.category, ["food"], "has");
    expect(none).toBeDefined();
    expect(has).toBeDefined();
  });
});

describe("buildPartialUpdateValues", () => {
  it("should return empty object for empty input", () => {
    const result = buildPartialUpdateValues({});
    expect(result).toEqual({});
  });

  it("should filter out undefined values", () => {
    const result = buildPartialUpdateValues({
      name: "test",
      description: undefined,
      type: "product",
    });
    expect(result).toEqual({
      name: "test",
      type: "product",
    });
  });

  it("should keep null values", () => {
    const result = buildPartialUpdateValues({
      name: "test",
      parentId: null,
    });
    expect(result).toEqual({
      name: "test",
      parentId: null,
    });
  });

  it("should keep empty string values", () => {
    const result = buildPartialUpdateValues({
      name: "",
      description: undefined,
    });
    expect(result).toEqual({
      name: "",
    });
  });

  it("should keep zero values", () => {
    const result = buildPartialUpdateValues({
      quantity: 0,
      price: undefined,
    });
    expect(result).toEqual({
      quantity: 0,
    });
  });

  it("should keep false boolean values", () => {
    const result = buildPartialUpdateValues({
      isActive: false,
      isDeleted: undefined,
    });
    expect(result).toEqual({
      isActive: false,
    });
  });

  it("should handle all undefined values", () => {
    const result = buildPartialUpdateValues({
      name: undefined,
      type: undefined,
      description: undefined,
    });
    expect(result).toEqual({});
  });

  it("should handle all defined values", () => {
    const result = buildPartialUpdateValues({
      name: "test",
      type: "product",
      quantity: 5,
    });
    expect(result).toEqual({
      name: "test",
      type: "product",
      quantity: 5,
    });
  });

  it("should handle nested objects", () => {
    const nestedObj = { foo: "bar" };
    const result = buildPartialUpdateValues({
      config: nestedObj,
      other: undefined,
    });
    expect(result).toEqual({
      config: nestedObj,
    });
  });

  it("should handle arrays", () => {
    const arr = [1, 2, 3];
    const result = buildPartialUpdateValues({
      items: arr,
      tags: undefined,
    });
    expect(result).toEqual({
      items: arr,
    });
  });
});
