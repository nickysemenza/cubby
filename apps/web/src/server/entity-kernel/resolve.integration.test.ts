import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { ingredient } from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntity,
  resolveEntity,
} from "~/server/entity-kernel";
import { getDb } from "~/server/repo/database-helpers";
import { resolveOrCreatePlants } from "~/server/repo/plant";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * The declared `capabilities.resolve` is one kernel action for every
 * resolvable entity. Failure modes it guards:
 * - an alias match is missed and a duplicate row is created;
 * - two spellings of one miss in the same call create two rows;
 * - `create: true` writes a Product, whose declaration says it never creates;
 * - blank names produce rows, or results come back out of request order.
 */
describe("entity kernel resolve", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  it("matches an ingredient by alias and creates one row per distinct miss", async () => {
    const created = await executeEntity(context(), {
      action: "create",
      entity: "ingredient",
      data: {
        name: "Scallion",
        aliases: ["green onion"],
        naKinds: [],
        usuallyOnHand: false,
      },
    });
    if (created.action !== "create") throw new Error("expected create");

    const resolved = await resolveEntity(context(), {
      action: "resolve",
      entity: "ingredient",
      names: ["GREEN ONION", " scallion", "Shallot", "shallot ", "   "],
      create: true,
    });

    expect(resolved.items).toHaveLength(4);
    const [alias, name, miss, missTwin] = resolved.items;
    expect(alias).toMatchObject({
      name: "GREEN ONION",
      id: created.item.id,
      matched: true,
      created: false,
    });
    expect(name).toMatchObject({ id: created.item.id, matched: true });
    expect(miss).toMatchObject({ name: "Shallot", matched: false });
    expect(miss?.created).toBe(true);
    expect(missTwin?.id).toBe(miss?.id);

    const shallots = await getDb(ctx.db)
      .select({ id: ingredient.id })
      .from(ingredient)
      .where(sql`lower(${ingredient.name}) = 'shallot'`);
    expect(shallots).toHaveLength(1);
  });

  it("scopes a plant match to its crop and links a created plant's ingredient", async () => {
    const first = await resolveOrCreatePlants(
      ctx.db,
      {
        plants: [
          {
            name: "Synthetic Cherry",
            gardenGuideKey: "tomato",
            ingredientName: "Synthetic cherry tomato",
          },
        ],
      },
      ctx.actor,
    );
    const again = await resolveOrCreatePlants(
      ctx.db,
      {
        plants: [
          { name: "synthetic cherry", gardenGuideKey: "tomato" },
          { name: "Synthetic Cherry", gardenGuideKey: "pepper" },
        ],
      },
      ctx.actor,
    );
    expect(first.plants[0]).toMatchObject({ created: true });
    expect(again.plants[0]).toEqual({
      name: "synthetic cherry",
      id: first.plants[0]?.id,
      created: false,
    });
    expect(again.plants[1]).toMatchObject({ created: true });
    expect(again.plants[1]?.id).not.toBe(first.plants[0]?.id);

    const plant = await executeEntity(context(), {
      action: "get",
      entity: "plant",
      id: first.plants[0]!.id,
      missing: "error",
    });
    if (plant.action !== "get") throw new Error("expected get");
    expect(plant.item).toMatchObject({
      gardenGuideKey: "tomato",
      ingredientName: "Synthetic cherry tomato",
    });
  });

  it("resolves without creating when create is omitted", async () => {
    const resolved = await resolveEntity(context(), {
      action: "resolve",
      entity: "ingredient",
      names: ["Never-created fennel pollen"],
    });
    expect(resolved.items).toEqual([
      {
        name: "Never-created fennel pollen",
        id: null,
        matched: false,
        created: false,
        candidates: [],
      },
    ]);
  });

  it("refuses to create a product and offers candidates for a miss", async () => {
    const soy = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic Soy Sauce, 500 ml",
        aliases: ["SSS 500ml"],
      }),
      ctx.actor,
    );

    await expect(
      resolveEntity(context(), {
        action: "resolve",
        entity: "product",
        names: ["Unknown pantry item"],
        create: true,
      }),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });

    const resolved = await resolveEntity(context(), {
      action: "resolve",
      entity: "product",
      names: ["sss 500ML", "soy sauce"],
    });
    expect(resolved.items).toEqual([
      {
        name: "sss 500ML",
        id: soy.id,
        matched: true,
        created: false,
        candidates: [],
      },
      {
        name: "soy sauce",
        id: null,
        matched: false,
        created: false,
        candidates: [{ id: soy.id, name: soy.name }],
      },
    ]);
  });
});
