import type { AgentStreamEvent } from "@cubby/schemas/agent";
import { describe, expect, it } from "vitest";
import type { JSONType } from "zod";

import { isReadOnlyTool } from "./mcp-bridge";
import { collectAgentAnswer, extractSources } from "./runtime";

describe("collectAgentAnswer", () => {
  it("discards narration before every tool and retains final citations", async () => {
    const events: AgentStreamEvent[] = [
      { type: "delta", text: "Searching first" },
      { type: "tool", tool: "search_products" },
      { type: "delta", text: "Searching again" },
      { type: "tool", tool: "list_inventory" },
      { type: "delta", text: "  The item " },
      { type: "delta", text: "is in the pantry.  " },
      {
        type: "done",
        sources: [{ entityType: "product", id: "PRD-2ABC", name: "Item" }],
        toolCalls: [
          { tool: "list_inventory", args: {}, durationMs: 1, ok: true },
        ],
      },
    ];
    const result = await collectAgentAnswer(
      (async function* () {
        yield* events;
      })(),
    );
    expect(result).toEqual({
      answer: "The item is in the pantry.",
      sources: [{ entityType: "product", id: "PRD-2ABC", name: "Item" }],
      toolCalls: [
        { tool: "list_inventory", args: {}, durationMs: 1, ok: true },
      ],
    });
  });
});

describe("extractSources", () => {
  const record = (tool: string, result: JSONType) => ({
    tool,
    args: {},
    durationMs: 1,
    ok: true,
    result,
  });

  it("cites generic get, list and both search result sets without exposing internal ids", () => {
    const item = { id: "ING-2ABC", name: "Cumin", entityId: "private-row-id" };
    const results: JSONType[] = [
      { item },
      { items: [item] },
      { lexical: [item], semantic: { results: [item] } },
    ];
    for (const result of results) {
      expect(
        extractSources([
          {
            ...record("get_entities", result),
            args: { command: { entity: "ingredient" } },
          },
        ]),
      ).toEqual([
        {
          entityType: "ingredient",
          id: "ING-2ABC",
          name: "Cumin",
          detail: null,
        },
      ]);
    }
  });

  it("retains standalone specialized get results", () => {
    expect(
      extractSources([record("get_product", { id: "PRD-2ABC", name: "Item" })]),
    ).toEqual([
      { entityType: "product", id: "PRD-2ABC", name: "Item", detail: null },
    ]);
  });

  it("maps inventory list items, naming from the nested product + location", () => {
    const sources = extractSources([
      record("list_inventory", {
        items: [
          {
            id: "INV-2ABC",
            product: { id: "PRD-2ABC", name: "Aeropress" },
            location: { id: "LOC-2ABC", name: "coffee shelf" },
          },
        ],
      }),
    ]);
    expect(sources).toEqual([
      {
        entityType: "inventory",
        id: "INV-2ABC",
        name: "Aeropress",
        detail: "coffee shelf",
      },
    ]);
  });

  it("maps product search results with manufacturer as detail", () => {
    const sources = extractSources([
      record("search_products", {
        items: [{ id: "PRD-2ABC", name: "Welder", manufacturer: "Everlast" }],
      }),
    ]);
    expect(sources[0]).toMatchObject({
      entityType: "product",
      id: "PRD-2ABC",
      name: "Welder",
      detail: "Everlast",
    });
  });

  it("dedupes the same entity seen across tools", () => {
    const sources = extractSources([
      record("search_products", {
        items: [{ id: "PRD-2ABC", name: "Welder" }],
      }),
      record("get_product", { id: "PRD-2ABC", name: "Welder" }),
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
      "entity",
    ]) {
      expect(isReadOnlyTool(name)).toBe(false);
    }
  });
});
