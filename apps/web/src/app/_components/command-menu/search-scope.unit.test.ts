import { describe, expect, it } from "vitest";
import { parseCommandSearchScope } from "./search-scope";

describe("parseCommandSearchScope", () => {
  it.each([
    ["product:m18", "product"],
    ["Products:m18", "product"],
    ["recipe:soup", "recipe"],
    ["recipes:soup", "recipe"],
    ["ingredient:flour", "ingredient"],
    ["ingredients:flour", "ingredient"],
    ["cookbook:braises", "cookbook"],
    ["cookbooks:braises", "cookbook"],
    ["location:garage", "location"],
    ["locations:garage", "location"],
    [" task :paint", "task"],
    ["tasks:paint", "task"],
    ["inventory:m18", "inventory"],
    ["Inventory Item:drill", "inventory"],
    ["inventory items:saw", "inventory"],
    ["meal:supper", "meal"],
    ["meals:supper", "meal"],
    ["project:furnace", "project"],
    ["projects:furnace", "project"],
    ["expense:invoice", "expense"],
    ["expenses:invoice", "expense"],
  ] as const)("recognizes %s", (value, entityType) => {
    expect(parseCommandSearchScope(value)).toEqual({
      entityType,
      query: value.slice(value.indexOf(":") + 1).trimStart(),
    });
  });

  it("preserves additional colons in the query", () => {
    expect(parseCommandSearchScope("recipe:sauce: tomato")).toEqual({
      entityType: "recipe",
      query: "sauce: tomato",
    });
  });

  it("accepts an empty query after a recognized scope", () => {
    expect(parseCommandSearchScope("locations:")).toEqual({
      entityType: "location",
      query: "",
    });
  });

  it.each(["serial:123", "unknown:value", "plain query"])(
    "leaves %s as an unscoped query",
    (value) => {
      expect(parseCommandSearchScope(value)).toEqual({
        entityType: null,
        query: value,
      });
    },
  );
});
