import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { productRouter } from "./product";

describe("product.tagSiblings", () => {
  const ctx = withTestDb();

  it("returns sibling shortcodes as public ids", async () => {
    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Source", tags: ["shared", "source-only"] }),
      ctx.actor,
    );
    const sibling = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Sibling",
        manufacturer: "Sibling Maker",
        tags: ["shared", "sibling-only"],
      }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unrelated", tags: ["unrelated"] }),
      ctx.actor,
    );

    const caller = createTestCaller(productRouter, ctx.db);
    const result = await caller.tagSiblings(source.id);

    expect(result).toEqual([
      {
        id: sibling.id,
        name: "Sibling",
        manufacturer: "Sibling Maker",
        category: null,
        tags: ["shared", "sibling-only"],
      },
    ]);
    expect(result[0]?.id).not.toBe(sibling.entityId);
  });
});
