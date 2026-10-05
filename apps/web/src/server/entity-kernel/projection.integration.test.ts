import type { SearchableEntity } from "@cubby/schemas/entity-manifest";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { fakerFromSeed, hashSeed } from "tooling/factories/faker";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { searchDocument } from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { getDb } from "~/server/repo/database-helpers";
import { createLocation } from "~/server/repo/location/crud";
import {
  createPlantFixture,
  makeLocationInput,
} from "~/server/repo/repo.fixtures";
import { getSearchDocumentEmbeddingText } from "~/server/repo/search-document";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTestRequestContext } from "~/server/testing/request-context";

/** The raw projected title, for assertions the semantic embedding text alone
 * cannot make (a rename that changes the title but not the embedded body). */
const searchDocumentTitle = async (
  db: Database,
  entityKind: SearchableEntity,
  entityId: string,
): Promise<string | null> => {
  const rows = await getDb(db)
    .select({ title: searchDocument.title })
    .from(searchDocument)
    .where(
      and(
        eq(searchDocument.entityKind, entityKind),
        eq(searchDocument.entityId, entityId),
      ),
    );
  return rows[0]?.title ?? null;
};

/**
 * A search document is written by the same request that writes the entity —
 * inside the kernel's transaction — never by a queue task that might not run.
 * A recording queue (nothing runs inline) proves the projection can only have
 * come from the write path itself.
 */
describe("entity kernel search projections", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  afterEach(() => setCfEnv(undefined));

  const recordingQueue = () => {
    const published: Array<{ task: { kind: string } }> = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: { task: { kind: string } } }>,
          ) => {
            published.push(...[...messages].map((m) => m.body));
          },
        },
      }),
    );
    return published;
  };

  it("projects on create and re-projects on update before responding", async () => {
    const published = recordingQueue();
    const created = await executeEntity(context(), {
      action: "create",
      entity: "ingredient",
      data: {
        name: "Projected saffron",
        aliases: [],
        naKinds: [],
        usuallyOnHand: false,
      },
    });
    if (created.action !== "create") throw new Error("expected create");
    const entityId = await resolveLiveShortcode(
      ctx.db,
      created.item.id,
      "ingredient",
    );
    if (!entityId) throw new Error("created ingredient did not resolve");
    const first = await getSearchDocumentEmbeddingText(
      ctx.db,
      "ingredient",
      entityId,
    );
    expect(first?.embeddingText).toContain("Projected saffron");

    await executeEntity(context(), {
      action: "update",
      entity: "ingredient",
      id: parseShortcodeFor("ingredient", created.item.id),
      data: { name: "Projected turmeric" },
    });
    const second = await getSearchDocumentEmbeddingText(
      ctx.db,
      "ingredient",
      entityId,
    );
    expect(second?.embeddingText).toContain("Projected turmeric");
    expect(second?.embeddingText).not.toContain("Projected saffron");

    // The embedding is the only work handed to the queue; the projection
    // was already current when the response returned.
    expect(published.map((message) => message.task.kind)).toEqual([
      "entity-embedding.refresh",
      "entity-embedding.refresh",
    ]);
  });

  // No recording queue here: publishing with no bound queue runs the
  // embedding-refresh task inline (see `publishInBackground`), which is what
  // actually re-projects the fanned-out planting document below.
  it("projects a planting by its plant name and re-projects it when the plant is renamed", async () => {
    const cropPlant = await createPlantFixture(
      ctx.db,
      { name: "Projected garden basil" },
      TEST_ACTOR,
    );
    const bed = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Projected basil bed",
        type: "bed",
      }),
      TEST_ACTOR,
    );

    const created = await executeEntity(context(), {
      action: "create",
      entity: "planting",
      data: {
        plantId: cropPlant.id,
        locationId: bed.id,
        status: "growing",
        sourceProductId: null,
        taskId: null,
        outcome: null,
        quantity: null,
        notes: null,
        plannedWindow: null,
        sowedOn: null,
        transplantedOn: null,
        finishedOn: null,
      },
    });
    if (created.action !== "create") throw new Error("expected create");
    const entityId = await resolveLiveShortcode(
      ctx.db,
      created.item.id,
      "planting",
    );
    if (!entityId) throw new Error("created planting did not resolve");

    expect(await searchDocumentTitle(ctx.db, "planting", entityId)).toBe(
      "Projected garden basil",
    );

    await executeEntity(context(), {
      action: "update",
      entity: "plant",
      id: parseShortcodeFor("plant", cropPlant.id),
      data: { name: "Projected garden thai basil" },
    });

    expect(await searchDocumentTitle(ctx.db, "planting", entityId)).toBe(
      "Projected garden thai basil",
    );
  });

  it("projects a garden entry by its area name", async () => {
    const bed = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Projected garden entry bed",
        type: "bed",
      }),
      TEST_ACTOR,
    );

    const created = await executeEntity(context(), {
      action: "create",
      entity: "gardenEntry",
      data: {
        locationId: bed.id,
        plantingIds: [],
        kind: "note",
        observedOn: "2026-05-01",
        notes: "Projected garden entry note",
        harvestAmount: null,
      },
    });
    if (created.action !== "create") throw new Error("expected create");
    const entityId = await resolveLiveShortcode(
      ctx.db,
      created.item.id,
      "gardenEntry",
    );
    if (!entityId) throw new Error("created garden entry did not resolve");

    expect(
      await searchDocumentTitle(ctx.db, "gardenEntry", entityId),
    ).toContain("Projected garden entry bed");
  });

  describe("a category edit re-projects descendant Products and Inventory", () => {
    const seedCategoryFamily = async () => {
      const faker = fakerFromSeed(hashSeed("kernel-category-projection"));
      const kernel = buildKernelContext(ctx.db, ctx.actor.userId);
      const category = await createEntity(
        kernel,
        "productCategory",
        { name: "Projected covers" },
        { faker },
      );
      const place = await createEntity(
        kernel,
        "location",
        { name: "Projected cover shed" },
        { faker },
      );
      const cover = await createEntity(
        kernel,
        "product",
        { name: "Projected tarp", categoryId: category.id },
        { faker },
      );
      const stock = await createEntity(
        kernel,
        "inventory",
        {
          productId: cover.id,
          locationId: place.id,
          amount: { value: 1, unit: "each" },
        },
        { faker },
      );
      const productId = await resolveLiveShortcode(ctx.db, cover.id, "product");
      const inventoryId = await resolveLiveShortcode(
        ctx.db,
        stock.id,
        "inventory",
      );
      if (!productId || !inventoryId) throw new Error("seed did not resolve");
      return { category, productId, ids: [productId, inventoryId] };
    };
    const typeHints = async (ids: string[]) =>
      (
        await getDb(ctx.db)
          .select({ typeHint: searchDocument.typeHint })
          .from(searchDocument)
          .where(
            and(
              inArray(searchDocument.entityId, ids),
              isNull(searchDocument.deletedAt),
            ),
          )
      ).map((row) => row.typeHint);
    const rename = (code: string, name: string) =>
      executeEntity(context(), {
        action: "update",
        entity: "productCategory",
        id: parseShortcodeFor("productCategory", code),
        data: { name },
      });

    it("inside the write, before the queue runs anything", async () => {
      const { category, ids } = await seedCategoryFamily();
      recordingQueue();

      await rename(category.id, "Projected awnings");

      expect(await typeHints(ids)).toEqual([
        "Projected awnings",
        "Projected awnings",
      ]);
    });

    // A descendant projection runs in the category's write transaction, so
    // its failure undoes the edit, as for every other search dependency.
    it("rolls the edit back when a descendant projection fails", async () => {
      const { category, productId, ids } = await seedCategoryFamily();
      recordingQueue();
      const db = getDb(ctx.db);
      await db.execute(sql`
        CREATE FUNCTION reject_projection() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic projection failure'; END $$`);
      await db.execute(
        sql.raw(`CREATE TRIGGER reject_projection
          BEFORE INSERT OR UPDATE ON "SearchDocument" FOR EACH ROW
          WHEN (NEW."entityId" = '${productId}'::uuid)
          EXECUTE FUNCTION reject_projection()`),
      );
      try {
        // The raised message rides on `cause`; the thrown error names the query.
        await expect(rename(category.id, "Projected awnings")).rejects.toThrow(
          'INSERT INTO "SearchDocument"',
        );
      } finally {
        await db.execute(
          sql`DROP TRIGGER reject_projection ON "SearchDocument"`,
        );
        await db.execute(sql`DROP FUNCTION reject_projection()`);
      }

      const after = await executeEntity(context(), {
        action: "get",
        entity: "productCategory",
        id: category.id,
        missing: "error",
      });
      if (after.action !== "get") throw new Error("expected get");
      expect(after.item).toMatchObject({ name: "Projected covers" });
      expect(await typeHints(ids)).toEqual([
        "Projected covers",
        "Projected covers",
      ]);
    });
  });
});
