import { recipeTagsOut } from "@cubby/schemas/recipe";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { cookbookContract } from "~/contracts/cookbook.contract";
import { query } from "~/contracts/define";
import { ingredientContract } from "~/contracts/ingredient.contract";
import { purchaseContract } from "~/contracts/purchase.contract";

import { createMcpServer } from "../server";
import {
  fromContract,
  mcpItemsEnvelope,
  mcpResultsEnvelope,
} from "./contract-envelope";
import { listDeclaredToolSchemas } from "./tool-catalog";

describe("fromContract", () => {
  it("reads a query/mutation contract member's output schema by reference", () => {
    const output = z.object({ value: z.string() });
    const op = query({ input: z.void(), output });
    expect(fromContract(op)).toBe(output);
  });
});

describe("mcpItemsEnvelope / mcpResultsEnvelope", () => {
  it("keeps the wrapped schema's own identity under `items`/`results` (envelope identity)", () => {
    const items = z.array(z.string());
    const results = z.array(z.number());
    expect(mcpItemsEnvelope(items).shape.items).toBe(items);
    expect(mcpResultsEnvelope(results).shape.results).toBe(results);
  });

  it("builds a fresh envelope object per call, with no shared closure state (closure guard)", () => {
    const a = mcpItemsEnvelope(z.string());
    const b = mcpItemsEnvelope(z.string());
    expect(a).not.toBe(b);
    // Metadata attached to one envelope must not leak into another built from
    // an unrelated call — a shared/memoized envelope would fail this.
    const described = a.describe("a's own description");
    expect(described).not.toBe(a);
    expect(b.description).toBeUndefined();
  });
});

/**
 * The seven MCP wrappers migrated off `packages/schemas` in favor of
 * `mcpItemsEnvelope(fromContract(op))` / `mcpResultsEnvelope(fromContract(op))`.
 * Each assertion is `toBe`, not `toEqual`: the point of routing through the
 * contract is that the MCP boundary validates against the EXACT SAME Zod
 * instance the HTTP contract does, not a structurally-identical copy.
 */
describe("migrated MCP envelope wrappers stay identical to their contract output", () => {
  const server = createMcpServer();
  const tools = listDeclaredToolSchemas(server);

  function requireObjectOutput(name: string): z.ZodObject {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} is not a registered MCP tool`);
    if (!(tool.outputSchema instanceof z.ZodObject)) {
      throw new Error(`${name}: expected an object output schema`);
    }
    return tool.outputSchema;
  }

  it("split_expense.items is purchase.split's own output, plus its extra fields", () => {
    const output = requireObjectOutput("split_expense");
    expect(output.shape.items).toBe(purchaseContract.ops.split.output);
    expect(Object.keys(output.shape)).toEqual(
      expect.arrayContaining(["items", "originalCost", "partsSum", "delta"]),
    );
  });

  it("list_cookbooks.items is cookbook.list's own output", () => {
    expect(requireObjectOutput("list_cookbooks").shape.items).toBe(
      cookbookContract.ops.list.output,
    );
  });

  it("get_recipe_tags.items is recipe's own `recipeTagsOut` schema", () => {
    expect(requireObjectOutput("get_recipe_tags").shape.items).toBe(
      recipeTagsOut,
    );
  });

  it("resolve_ingredients.results is ingredient.resolveOrCreate's own output", () => {
    expect(requireObjectOutput("resolve_ingredients").shape.results).toBe(
      ingredientContract.ops.resolveOrCreate.output,
    );
  });
});
