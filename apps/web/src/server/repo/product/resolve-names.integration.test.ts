import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { resolveProductNames } from "./resolve-names";

describe("resolveProductNames", () => {
  const ctx = withTestDb();

  it("matches names and aliases exactly, falls back to a contains search, and never creates", async () => {
    const soy = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Lee Kum Kee Premium Soy Sauce, 500 ml",
        aliases: ["LKK Soy Sauce 500ml"],
      }),
      ctx.actor,
    );
    const coconut = await createProduct(
      ctx.db,
      makeProductInput({ name: "Aroy-D Coconut Milk, 14 oz" }),
      ctx.actor,
    );

    const results = await resolveProductNames(ctx.db, [
      "  lkk soy sauce 500ML ",
      "LKK Soy Sauce 500ml", // casing/whitespace twin of the line above
      "aroy-d",
      "Nothing Like This Exists",
    ]);

    expect(results).toEqual([
      {
        name: "lkk soy sauce 500ML",
        exact: true,
        candidates: [expect.objectContaining({ id: soy.id, name: soy.name })],
      },
      {
        name: "aroy-d",
        exact: false,
        candidates: [
          expect.objectContaining({ id: coconut.id, name: coconut.name }),
        ],
      },
      { name: "Nothing Like This Exists", exact: false, candidates: [] },
    ]);
  });
});
