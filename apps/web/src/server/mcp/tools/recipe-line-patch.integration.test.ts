import { testUserId } from "@cubby/schemas/testing";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { ingredientRef, makeRecipeInput } from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool } from "../mcp-test-utils";
import { registerRecipeTools } from "./recipe.tools";

describe("patch_recipe_line", () => {
  const ctx = withTestDb();

  it("changes one line and leaves every other line, section and instruction in place", async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const [onion, basil, pasta, salt] = await Promise.all(
      ["patch onion", "patch basil", "patch pasta", "patch salt"].map((name) =>
        findOrCreateIngredient(ctx.db, name),
      ),
    );
    const created = await executeEntity(entityKernel, {
      action: "create",
      entity: "recipe",
      data: makeRecipeInput({
        name: "Line patch pasta",
        sections: [
          {
            name: "Sauce",
            ingredients: [
              ingredientRef(onion!.shortcode, {
                amounts: [{ value: 1, unit: "whole" }],
                rawLine: "1 onion, diced",
                modifier: "diced",
              }),
              ingredientRef(basil!.shortcode, {
                amounts: [{ value: 1, unit: "handful" }],
              }),
            ],
            instructions: [{ instruction: "Soften the onion." }],
          },
          {
            name: "Pasta",
            ingredients: [
              ingredientRef(pasta!.shortcode, {
                amounts: [{ value: 175, unit: "g" }],
              }),
            ],
            instructions: [{ instruction: "Boil the pasta." }],
          },
        ],
      }),
    });
    const before = created.item;
    const onionLine = before.sections[0]!.ingredients[0]!;

    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerRecipeTools(server);
    const result = await callMcpTool(
      server,
      "patch_recipe_line",
      {
        recipeId: before.id,
        lineId: onionLine.id,
        patch: { amounts: [{ value: 150, unit: "g" }] },
      },
      {},
      { entityKernel },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      recipeId: before.id,
      line: {
        type: "ingredient",
        ingredientId: onion!.shortcode,
        amounts: [{ value: 150, unit: "g" }],
        rawLine: "1 onion, diced",
        modifier: "diced",
      },
    });

    const after = await executeEntity(entityKernel, {
      action: "get",
      entity: "recipe",
      id: before.id,
      missing: "error",
    });
    const lineSummary = (sections: typeof before.sections) =>
      sections.map((section) => ({
        id: section.id,
        name: section.name,
        instructions: section.instructions,
        lines: section.ingredients.map((line) => ({
          id: line.id,
          ingredientId: line.ingredient?.id,
          amounts: line.amounts,
          rawLine: line.rawLine,
          modifier: line.modifier,
        })),
      }));
    const expected = lineSummary(before.sections);
    expected[0]!.lines[0]!.amounts = [{ value: 150, unit: "g" }];
    expect(lineSummary(after.item!.sections)).toEqual(expected);

    const repointed = await callMcpTool(
      server,
      "patch_recipe_line",
      {
        recipeId: before.id,
        lineId: before.sections[1]!.ingredients[0]!.id,
        patch: { ingredientId: salt!.shortcode },
      },
      {},
      { entityKernel },
    );
    expect(repointed.isError).not.toBe(true);
    const final = await executeEntity(entityKernel, {
      action: "get",
      entity: "recipe",
      id: before.id,
      missing: "error",
    });
    expect(final.item!.sections[1]!.ingredients[0]).toMatchObject({
      id: before.sections[1]!.ingredients[0]!.id,
      ingredient: { id: salt!.shortcode },
      amounts: [{ value: 175, unit: "g" }],
    });
  });

  it("refuses a line that is not in the recipe", async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const created = await executeEntity(entityKernel, {
      action: "create",
      entity: "recipe",
      data: makeRecipeInput({ name: "Line patch empty" }),
    });
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerRecipeTools(server);
    const result = await callMcpTool(
      server,
      "patch_recipe_line",
      {
        recipeId: created.item.id,
        lineId: "00000000-0000-4000-8000-000000000000",
        patch: { amounts: [{ value: 1, unit: "g" }] },
      },
      {},
      { entityKernel },
    );
    expect(result.isError).toBe(true);
  });
});
