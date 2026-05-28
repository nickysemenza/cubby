import { describe, expect, it } from "vitest";
import { isReadOnlyTool } from "./mcp-bridge";
import { extractSources, stripNarration } from "./runtime";

describe("stripNarration", () => {
  it("removes a leading narration clause glued to the answer", () => {
    expect(
      stripNarration(
        "Now let me check what inventory is in that location.Your bathroom contains items.",
      ),
    ).toBe("Your bathroom contains items.");
  });

  it("handles colon-terminated narration", () => {
    expect(
      stripNarration(
        "Now let me get the inventory:The bathroom contains items.",
      ),
    ).toBe("The bathroom contains items.");
  });

  it("strips an 'I'll …' lead-in", () => {
    expect(
      stripNarration(
        "I'll search for fireplace rocks.Fireplace rocks are in the garage.",
      ),
    ).toBe("Fireplace rocks are in the garage.");
  });

  it("leaves a clean answer untouched", () => {
    const clean = "Your fireplace rocks are in the garage. You have 1 each.";
    expect(stripNarration(clean)).toBe(clean);
  });

  it("never strips everything — falls back to the original", () => {
    // A degenerate answer that is only narration: keep something rather than ""
    expect(stripNarration("Let me check.").length).toBeGreaterThan(0);
  });
});

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
