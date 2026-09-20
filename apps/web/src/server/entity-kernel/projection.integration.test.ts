import type { SearchableEntity } from "@cubby/schemas/entity-manifest";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq } from "drizzle-orm";
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
import { createIngredient } from "~/server/repo/ingredient";
import { createLocation } from "~/server/repo/location";
import { makeLocationInput } from "~/server/repo/repo.fixtures";
import { getSearchDocumentEmbeddingText } from "~/server/repo/search-document";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTestRequestContext } from "~/server/testing/request-context";

/** The raw projected title, for assertions the semantic embedding text alone
 * cannot make (a rename that changes the title but not the embedded body). */
const searchDocumentTitle = async (
  db: Database,
  entityType: SearchableEntity,
  entityId: string,
): Promise<string | null> => {
  const rows = await getDb(db)
    .select({ title: searchDocument.title })
    .from(searchDocument)
    .where(
      and(
        eq(searchDocument.entityType, entityType),
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
  it("projects a planting by its crop name and re-projects it when the ingredient is renamed", async () => {
    const cropIngredient = await createIngredient(
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
        ingredientId: cropIngredient.id,
        locationId: bed.id,
        status: "growing",
        sourceProductId: null,
        taskId: null,
        variety: null,
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
      entity: "ingredient",
      id: parseShortcodeFor("ingredient", cropIngredient.id),
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
        note: "Projected garden entry note",
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
});
