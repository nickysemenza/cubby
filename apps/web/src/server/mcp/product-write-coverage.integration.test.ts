import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { entityKernelContextSchema } from "~/server/entity-kernel";
import { createMcpServer } from "~/server/mcp/server";
import { findOrCreateIngredient } from "~/server/repo/ingredient/crud";
import {
  createProductFixture,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool, kernelRequestContext } from "./mcp-test-utils";
import type { ToolArguments } from "./tools/tool-registration";

const gap = z.enum(["price", "weight", "nutrients"]);
const changedLine = z.object({
  recipeId: z.string(),
  id: z.string(),
  name: z.string(),
  before: z.array(gap),
  after: z.array(gap),
});
const changesSchema = z.object({
  recipesChecked: z.number(),
  truncated: z.boolean(),
  closed: z.array(changedLine),
  regressed: z.array(changedLine),
});
const lineCoverageSchema = z.array(
  z.object({ id: z.string(), name: z.string(), missing: z.array(gap) }),
);
const writeResult = z.object({
  item: z.object({ id: z.string() }).passthrough(),
  recipeCoverageChanges: changesSchema.optional(),
  lineCoverage: lineCoverageSchema.optional(),
});

describe("coverage diagnostics on product and recipe writes", () => {
  const ctx = withTestDb("mcp");

  const setup = async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const call = (tool: string, args: ToolArguments) =>
      callMcpTool(
        createMcpServer(),
        tool,
        args,
        kernelRequestContext(entityKernel),
        { entityKernel },
      );
    const flour = await findOrCreateIngredient(ctx.db, "coverage flour");
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Coverage flour bag",
        ingredientId: parseShortcodeFor("ingredient", flour!.shortcode),
        price: null,
        unitMappings: [],
      }),
      ctx.actor,
    );
    const recipe = await call("entity", {
      action: "create",
      entity: "recipe",
      data: makeRecipeInput({
        name: "Coverage bread",
        sections: [
          {
            name: "Dough",
            ingredients: [
              ingredientRef(flour!.shortcode, {
                amounts: [{ value: 2, unit: "cup" }],
              }),
            ],
            instructions: [{ instruction: "Knead." }],
          },
        ],
      }),
    });
    expect(recipe.isError).not.toBe(true);
    const recipeId = writeResult.parse(recipe.structuredContent).item.id;
    return { call, flour: flour!, product, recipeId };
  };

  const mapping = {
    a: { value: 1, unit: "cup" },
    b: { value: 120, unit: "g" },
    source: null,
  };

  it("reports the recipe line a product update closed", async () => {
    const { call, product, recipeId } = await setup();

    const unrelated = await call("entity", {
      action: "update",
      entity: "product",
      id: product.id,
      data: { notes: "Stored in the pantry." },
    });
    expect(unrelated.isError).not.toBe(true);
    expect(
      writeResult.parse(unrelated.structuredContent).recipeCoverageChanges,
    ).toBeUndefined();

    const updated = await call("entity", {
      action: "update",
      entity: "product",
      id: product.id,
      data: { unitMappings: [mapping] },
    });
    expect(updated.isError).not.toBe(true);
    const changes = writeResult.parse(
      updated.structuredContent,
    ).recipeCoverageChanges;
    expect(changes).toMatchObject({
      recipesChecked: 1,
      truncated: false,
      regressed: [],
    });
    expect(changes?.closed).toHaveLength(1);
    const [line] = changes!.closed;
    expect(line).toMatchObject({ recipeId, name: "coverage flour" });
    expect(line!.before).toContain("weight");
    expect(line!.after).not.toContain("weight");

    // The same write again changes nothing, so nothing is reported closed.
    const repeat = await call("entity", {
      action: "update",
      entity: "product",
      id: product.id,
      data: { unitMappings: [mapping] },
    });
    expect(
      writeResult.parse(repeat.structuredContent).recipeCoverageChanges,
    ).toMatchObject({ recipesChecked: 1, closed: [], regressed: [] });
  });

  it("reports a regression when a product update removes the mapping", async () => {
    const { call, product } = await setup();
    await call("entity", {
      action: "update",
      entity: "product",
      id: product.id,
      data: { unitMappings: [mapping] },
    });
    const removed = await call("entity", {
      action: "update",
      entity: "product",
      id: product.id,
      data: { unitMappings: [] },
    });
    const changes = writeResult.parse(
      removed.structuredContent,
    ).recipeCoverageChanges;
    expect(changes?.closed).toEqual([]);
    expect(changes?.regressed).toHaveLength(1);
    expect(changes?.regressed[0]?.after).toContain("weight");
  });

  it("attaches the same diagnostics to entity.commands items", async () => {
    const { call, flour, product } = await setup();
    const batch = await call("entity", {
      action: "commands",
      resultDetail: "full",
      commands: [
        {
          action: "update",
          entity: "product",
          id: product.id,
          data: { unitMappings: [mapping] },
        },
        {
          action: "create",
          entity: "recipe",
          data: makeRecipeInput({
            name: "Coverage rolls",
            sections: [
              {
                name: "Dough",
                ingredients: [
                  ingredientRef(flour.shortcode, {
                    amounts: [{ value: 1, unit: "cup" }],
                  }),
                ],
                instructions: [{ instruction: "Bake." }],
              },
            ],
          }),
        },
      ],
    });
    expect(batch.isError).not.toBe(true);
    const results = z
      .object({
        results: z.array(
          z.object({ status: z.string(), item: writeResult.optional() }),
        ),
      })
      .parse(batch.structuredContent).results;
    expect(results.map((result) => result.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(results[0]?.item?.recipeCoverageChanges?.closed).toHaveLength(1);
    expect(results[1]?.item?.lineCoverage).toHaveLength(1);
  });

  it("returns lineCoverage from recipe_import writes", async () => {
    const { call } = await setup();
    const imported = await call("recipe_import", {
      action: "from_text",
      name: "Coverage flatbread",
      sections: [
        { ingredients: ["1 cup coverage flour"], instructions: ["Fry."] },
      ],
    });
    expect(imported.isError).not.toBe(true);
    const created = z
      .object({ id: z.string(), lineCoverage: lineCoverageSchema })
      .parse(imported.structuredContent);
    expect(created.lineCoverage.length).toBeGreaterThan(0);
  });
});
