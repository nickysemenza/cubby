import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { recipeLineCoverage } from "~/server/domains/recipe/operations/recipe.server";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { createMcpServer } from "~/server/mcp/server";
import {
  createProductFixture,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool, kernelRequestContext } from "../testing/mcp-test-utils";
import type { ToolArguments } from "./tools/tool-registration";

const gap = z.enum(["price", "weight", "nutrients"]);
const lineCoverageSchema = z.array(
  z.object({ id: z.string(), name: z.string(), missing: z.array(gap) }),
);
const writeResult = z.object({
  item: z.object({ id: z.string() }).passthrough(),
  lineCoverage: lineCoverageSchema.optional(),
});

import { captureBackgroundQueue } from "~/server/testing/background-queue";
let backgroundQueue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  backgroundQueue = captureBackgroundQueue();
});
afterEach(() => backgroundQueue.restore());

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
    return { call, entityKernel, flour: flour!, product, recipeId };
  };

  const mapping = {
    a: { value: 1, unit: "cup" },
    b: { value: 120, unit: "g" },
    source: null,
  };

  it("keeps coverage on a separate read when a Product mapping closes a gap", async () => {
    const { call, entityKernel, product, recipeId } = await setup();
    const before = await recipeLineCoverage(entityKernel, recipeId);
    expect(before[0]?.missing).toContain("weight");
    const updated = await call("entity", {
      action: "update",
      entity: "product",
      id: product.id,
      data: { unitMappings: [mapping] },
    });
    expect(updated.isError).not.toBe(true);
    expect(updated.structuredContent).not.toHaveProperty(
      "recipeCoverageChanges",
    );
    expect(updated.structuredContent).not.toHaveProperty("lineCoverage");
    const after = await recipeLineCoverage(entityKernel, recipeId);
    expect(after[0]?.missing).not.toContain("weight");
    await call("entity", {
      action: "update",
      entity: "product",
      id: product.id,
      data: { unitMappings: [mapping] },
    });
    expect(await recipeLineCoverage(entityKernel, recipeId)).toEqual(after);
  });

  it("reports a removed mapping's gap on an explicit read", async () => {
    const { call, entityKernel, product, recipeId } = await setup();
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
    expect(removed.isError).not.toBe(true);
    expect(removed.structuredContent).not.toHaveProperty(
      "recipeCoverageChanges",
    );
    expect(
      (await recipeLineCoverage(entityKernel, recipeId))[0]?.missing,
    ).toContain("weight");
  });

  it("keeps entity.commands receipts bounded for Product and Recipe writes", async () => {
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
    expect(batch.structuredContent).not.toHaveProperty("recipeCoverageChanges");
    for (const result of results) {
      expect(result.item).not.toHaveProperty("recipeCoverageChanges");
      expect(result.item).not.toHaveProperty("lineCoverage");
      expect(result.item?.item.id).toBeDefined();
    }
  });

  it("returns lineCoverage from recipe_import writes", async () => {
    const { call } = await setup();
    const imported = await call("recipe_insights", {
      action: "create_from_text",
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
