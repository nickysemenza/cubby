import { entityReportOut } from "@cubby/schemas/entity-report";
import { testUserId } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { buildEntityReport } from "~/server/repo/entity-report";
import { findOrCreateIngredient } from "~/server/repo/ingredient/crud";
import { ingredientRef, makeRecipeInput } from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { reparseRecipeLine } from "./recipe-line-reparse";

/**
 * Re-parsing a stored recipe line is one server rule: parse the source line with the current
 * parser, compare it to what is stored, resolve a drifted name through find-or-create, and write
 * only what changed. Web's table and native's report row both send `{recipeId, lineId}` and
 * nothing else, so neither client re-implements the parse, the drift check or the write.
 */
describe("reparseRecipeLine", () => {
  const ctx = withTestDb();

  const setup = async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const flour = await findOrCreateIngredient(ctx.db, "reparse flour");
    const created = await executeEntity(entityKernel, {
      action: "create",
      entity: "recipe",
      data: makeRecipeInput({
        name: "Reparse tart",
        sections: [
          {
            name: "Crust",
            ingredients: [
              // The stored amount is stale: today's parser reads this line as 2 cup.
              ingredientRef(flour!.shortcode, {
                amounts: [{ value: 999, unit: "g" }],
                rawLine: "2 cups reparse flour",
              }),
              // No source line: nothing to re-parse, and no command is offered for it.
              ingredientRef(flour!.shortcode, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
            instructions: [{ instruction: "Mix." }],
          },
        ],
      }),
    });
    return { entityKernel, flour: flour!, recipe: created.item };
  };

  const usagesReport = async (flourCode: string) => {
    const out = entityReportOut.parse(
      await buildEntityReport(
        ctx.db,
        { slot: "ingredient.recipe-usages", id: flourCode },
        async () => null,
        ctx.actor,
      ),
    );
    const block = out.blocks[0];
    if (block?.kind !== "records") throw new Error("not a records block");
    return block;
  };

  it("offers a re-parse only on a drifted line, and applies exactly the fresh parse", async () => {
    const { entityKernel, flour, recipe } = await setup();
    const line = recipe.sections[0]!.ingredients[0]!;

    const before = await usagesReport(flour.shortcode);
    const drifted = before.rows.filter((row) => (row.commands ?? []).length);
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toMatchObject({
      badges: ["Re-parse changes amount"],
      commands: [
        {
          label: "Re-parse",
          prominent: false,
          request: {
            kind: "reparse-line",
            recipeId: recipe.id,
            lineId: line.id,
          },
        },
      ],
    });
    // It writes the recipe, so native asks first.
    expect(drifted[0]!.commands![0]!.confirm).toMatch(/current parser/);

    const result = await reparseRecipeLine(entityKernel, {
      recipeId: recipe.id,
      lineId: line.id,
    });
    expect(result).toEqual({
      recipeId: recipe.id,
      status: "updated",
      changed: ["amount"],
    });
    const after = await executeEntity(entityKernel, {
      action: "get",
      entity: "recipe",
      id: recipe.id,
      missing: "error",
    });
    expect(after.item!.sections[0]!.ingredients[0]).toMatchObject({
      id: line.id,
      amounts: [{ value: 2, unit: "cup" }],
      rawLine: "2 cups reparse flour",
    });

    // Nothing drifts any more: no command, and a second run changes nothing.
    const settled = await usagesReport(flour.shortcode);
    expect(settled.rows.flatMap((row) => row.commands ?? [])).toEqual([]);
    expect(
      await reparseRecipeLine(entityKernel, {
        recipeId: recipe.id,
        lineId: line.id,
      }),
    ).toEqual({ recipeId: recipe.id, status: "unchanged", changed: [] });
  });

  it("refuses a line with no source text to parse", async () => {
    const { entityKernel, recipe } = await setup();
    await expect(
      reparseRecipeLine(entityKernel, {
        recipeId: recipe.id,
        lineId: recipe.sections[0]!.ingredients[1]!.id,
      }),
    ).rejects.toThrow(/no source line/i);
  });
});
