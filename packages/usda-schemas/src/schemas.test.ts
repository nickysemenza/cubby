import { describe, expect, it } from "vitest";
import { ndb, upc } from "./schemas";

// Only the schemas with real format/range rules are tested. The plain enums
// (nutrient_unit_name, dataTypeEnum, branded_food_serving_size_unit) were just
// re-listing their own members — change-detector noise, not behavior — so they
// aren't covered here.

describe("UPC validation", () => {
  it.each([
    ["12345678", "12345678"],
    ["123456789012", "123456789012"],
    ["1234567890123", "1234567890123"],
    ["12345678901234", "12345678901234"],
    [" 123456789012 ", "123456789012"],
  ])("accepts %s", (input, expected) => {
    expect(upc.parse(input)).toBe(expected);
  });

  it.each([
    "",
    "1234567",
    "123456789",
    "1234567890",
    "12345678901",
    "123456789012345",
    "ABCDEFGHIJKL",
    "12345678901A",
  ])("rejects %s", (input) => {
    expect(() => upc.parse(input)).toThrow();
  });
});

describe("NDB number validation", () => {
  it("accepts NDB numbers within range", () => {
    expect(() => ndb.parse(12345)).not.toThrow();
    expect(() => ndb.parse(1000)).not.toThrow();
    expect(() => ndb.parse(99999)).not.toThrow();
  });

  it("rejects NDB numbers outside range", () => {
    expect(() => ndb.parse(999)).toThrow();
    expect(() => ndb.parse(100000)).toThrow();
    expect(() => ndb.parse(-1)).toThrow();
  });
});
