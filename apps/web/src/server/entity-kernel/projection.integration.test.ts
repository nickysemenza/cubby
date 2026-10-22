import type { SearchableEntity } from "@cubby/schemas/entity-manifest";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { BackgroundTaskMessage } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { fakerFromSeed, hashSeed } from "tooling/factories/faker";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
  captureBackgroundQueue,
  drainDerivedRefreshFrontier,
} from "~/server/testing/background-queue";
let backgroundQueue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  backgroundQueue = captureBackgroundQueue();
});
afterEach(() => backgroundQueue.restore());

import { setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { job, searchDocument } from "~/server/db/schema";
import { createLocation } from "~/server/domains/location/repo/crud";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { getSearchDocumentEmbeddingText } from "~/server/generic/search/repo/search-document";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  createPlantFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";
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
 * Writes commit durable roots without projecting synchronously. The real
 * provider-free frontier then repairs direct and dependent documents.
 */
describe("entity kernel search projections", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  afterEach(() => setCfEnv(undefined));

  const recordingQueue = () => {
    const published: BackgroundTaskMessage[] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: BackgroundTaskMessage }>,
          ) => {
            published.push(...[...messages].map((m) => m.body));
          },
        },
      }),
    );
    return published;
  };

  it("projects created and updated records through durable background work", async () => {
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
    expect(
      await getSearchDocumentEmbeddingText(ctx.db, "ingredient", entityId),
    ).toBeNull();
    await drainDerivedRefreshFrontier(ctx.db);
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
    await drainDerivedRefreshFrontier(ctx.db);
    const second = await getSearchDocumentEmbeddingText(
      ctx.db,
      "ingredient",
      entityId,
    );
    expect(second?.embeddingText).toContain("Projected turmeric");
    expect(second?.embeddingText).not.toContain("Projected saffron");

    expect(published.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(published.map((message) => message.queueType))]).toEqual(
      ["background"],
    );
  });

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

    await drainDerivedRefreshFrontier(ctx.db);
    expect(await searchDocumentTitle(ctx.db, "planting", entityId)).toBe(
      "Projected garden basil",
    );

    await executeEntity(context(), {
      action: "update",
      entity: "plant",
      id: parseShortcodeFor("plant", cropPlant.id),
      data: { name: "Projected garden thai basil" },
    });
    await drainDerivedRefreshFrontier(ctx.db);

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
    await drainDerivedRefreshFrontier(ctx.db);

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
      await drainDerivedRefreshFrontier(ctx.db);
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

    it("defers dependent projections until the background frontier runs", async () => {
      const { category, ids } = await seedCategoryFamily();
      recordingQueue();

      await rename(category.id, "Projected awnings");

      expect(await typeHints(ids)).toEqual([
        "Projected covers",
        "Projected covers",
      ]);
      await drainDerivedRefreshFrontier(ctx.db);

      expect(await typeHints(ids)).toEqual([
        "Projected awnings",
        "Projected awnings",
      ]);
    });

    it("keeps the saved edit when a background descendant projection fails", async () => {
      const { category, productId } = await seedCategoryFamily();
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
        await expect(
          rename(category.id, "Projected awnings"),
        ).resolves.toMatchObject({ action: "update" });
        await expect(drainDerivedRefreshFrontier(ctx.db)).rejects.toThrow(
          "Synthetic search publication failed",
        );
        const [failed] = await db
          .select({ error: job.error })
          .from(job)
          .where(eq(job.key, "refresh:search"));
        expect(failed?.error).toContain("synthetic projection failure");
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
      expect(after.item).toMatchObject({ name: "Projected awnings" });
      expect(await searchDocumentTitle(ctx.db, "product", productId)).toBe(
        "Projected tarp",
      );
    });
  });
});
