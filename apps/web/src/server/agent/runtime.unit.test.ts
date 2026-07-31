import { describe, expect, it } from "vitest";
import { isReadOnlyTool } from "./mcp-bridge";
import { extractSources } from "./runtime";

describe("extractSources", () => {
  const record = (tool: string, result: unknown) => ({
    tool,
    args: {},
    durationMs: 1,
    ok: true,
    result,
  });

  it("maps inventory list items, naming from the nested product + location", () => {
    const sources = extractSources([
      record("list_inventory", {
        items: [
          {
            id: "inv-1",
            product: { id: "p-1", name: "Aeropress" },
            location: { id: "l-1", name: "coffee shelf" },
          },
        ],
      }),
    ]);
    expect(sources).toEqual([
      {
        entityType: "inventory",
        id: "inv-1",
        shortcode: null,
        name: "Aeropress",
        detail: "coffee shelf",
      },
    ]);
  });

  it("maps product search results with manufacturer as detail", () => {
    const sources = extractSources([
      record("search_products", {
        items: [{ id: "p-1", name: "Welder", manufacturer: "Everlast" }],
      }),
    ]);
    expect(sources[0]).toMatchObject({
      entityType: "product",
      id: "p-1",
      name: "Welder",
      detail: "Everlast",
    });
  });

  it("dedupes the same entity seen across tools", () => {
    const sources = extractSources([
      record("search_products", { items: [{ id: "p-1", name: "Welder" }] }),
      record("get_product", { id: "p-1", name: "Welder" }),
    ]);
    expect(sources).toHaveLength(1);
  });

  it("skips failed tool calls and unparseable results", () => {
    const sources = extractSources([
      {
        tool: "list_products",
        args: {},
        durationMs: 1,
        ok: false,
        result: null,
      },
      record("list_products", "not an object"),
    ]);
    expect(sources).toEqual([]);
  });
});

describe("isReadOnlyTool", () => {
  it("allows read prefixes", () => {
    for (const name of [
      "list_inventory",
      "get_product",
      "search_products",
      "find_cookable_recipes",
    ]) {
      expect(isReadOnlyTool(name)).toBe(true);
    }
  });

  it("blocks mutating tools", () => {
    for (const name of [
      "create_inventory_entry",
      "update_product",
      "delete_inventory_entry",
    ]) {
      expect(isReadOnlyTool(name)).toBe(false);
    }
  });
});
