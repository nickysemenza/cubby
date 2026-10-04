import { recipeLineAsInput } from "@cubby/schemas/recipe";
import { testUserId } from "@cubby/schemas/testing";
import vectorFile from "@cubby/shared/golden-vectors/structured-roundtrip.json";
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

const UUID =
  /"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/giu;
const SHORTCODE = /"([A-Z]+)-[2-9A-HJKMNP-Z]{4,5}"/gu;
const INSTANT = /"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z"/gu;

/**
 * Replaces everything a database mints (ids, shortcodes, instants) with stable synthetic values,
 * numbered by first appearance per kind, so a payload read from a real recipe can be pinned in a
 * golden vector. Every other string passes through.
 */
const stabilize = (payload: z.core.util.JSONType) => {
  const seen = new Map<string, string>();
  const stable = (raw: string, kind: string, make: (n: number) => string) => {
    const key = `${kind}:${raw}`;
    if (!seen.has(key)) {
      const count = [...seen.keys()].filter((k) => k.startsWith(`${kind}:`));
      seen.set(key, make(count.length + 1));
    }
    return seen.get(key) ?? raw;
  };
  const text = JSON.stringify(payload)
    .replaceAll(UUID, (raw) =>
      stable(
        raw,
        "uuid",
        (n) => `"${String(n).padStart(8, "0")}-0000-4000-8000-000000000000"`,
      ),
    )
    // Digits 2-9 are in the shortcode alphabet, so `RCP-2222` is a valid code.
    .replaceAll(SHORTCODE, (raw, prefix: string) =>
      stable(raw, prefix, (n) => `"${prefix}-${String(n + 1).repeat(4)}"`),
    )
    .replaceAll(INSTANT, '"2026-01-01T00:00:00.000Z"');
  return z.json().parse(JSON.parse(text));
};

const json = <Value>(value: Value) =>
  z.json().parse(JSON.parse(JSON.stringify(value)));

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
