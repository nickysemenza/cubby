import { recipeLineAsInput } from "@cubby/schemas/recipe";
import { testUserId } from "@cubby/schemas/testing";
import vectorFile from "@cubby/shared/golden-vectors/structured-roundtrip.json";
import { stabilize, wireJson as json } from "tooling/stabilize-vector";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { findOrCreateIngredient } from "~/server/repo/ingredient/crud";
import { ingredientRef, makeRecipeInput } from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

const vectorSchema = z.object({
  read: z.json(),
  input: z.array(z.object({ ingredients: z.array(z.json()).optional() })),
});

describe("recipe sections read-to-input vector", () => {
  const ctx = withTestDb();

  it("pins the payload the server really reads, and web's adapter agrees with the vector input", async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const [flour, water] = await Promise.all(
      ["vector flour", "vector water"].map((name) =>
        findOrCreateIngredient(ctx.db, name),
      ),
    );
    const base = await executeEntity(entityKernel, {
      action: "create",
      entity: "recipe",
      data: makeRecipeInput({
        name: "Vector starter",
        sections: [
          {
            name: null,
            ingredients: [ingredientRef(flour!.shortcode)],
            instructions: [{ instruction: "Mix." }],
          },
        ],
      }),
    });
    const created = await executeEntity(entityKernel, {
      action: "create",
      entity: "recipe",
      data: makeRecipeInput({
        name: "Vector loaf",
        sections: [
          {
            name: "Dough",
            ingredients: [
              ingredientRef(flour!.shortcode, {
                amounts: [{ value: 500, unit: "g" }],
                rawLine: "500g flour, sifted",
                modifier: "sifted",
              }),
              {
                type: "recipe",
                recipeId: base.item.id,
                ingredientId: null,
                amounts: [{ value: 1, unit: "batch" }],
              },
            ],
            instructions: [{ instruction: "Knead." }],
          },
          {
            name: "Water",
            ingredients: [ingredientRef(water!.shortcode)],
          },
          { name: "Bake", instructions: [{ instruction: "Bake until done." }] },
        ],
      }),
    });
    const read = await executeEntity(entityKernel, {
      action: "get",
      entity: "recipe",
      id: created.item.id,
      missing: "error",
    });
    const sections = read.item!.sections;

    // One stabilization pass over both, so the ids they share stay equal.
    const stable = z.object({ read: z.json(), lines: z.array(z.json()) }).parse(
      stabilize({
        read: json(sections),
        lines: sections
          .flatMap((section) => section.ingredients)
          .map((line) => json(recipeLineAsInput(line))),
      }),
    );

    const vector = vectorSchema.parse(
      vectorFile.vectors.find(
        (candidate) =>
          candidate.entity === "recipe" && candidate.field === "sections",
      ),
    );
    expect(stable.read).toEqual(vector.read);
    expect(stable.lines).toEqual(
      vector.input.flatMap((section) => section.ingredients ?? []),
    );
  });
});
