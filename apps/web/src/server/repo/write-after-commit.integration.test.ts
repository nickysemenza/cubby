import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import {
  createLocation,
  getLocationById,
  updateLocationAiDescription,
} from "~/server/repo/location/crud";
import { getPlantByShortcode } from "~/server/repo/plant";
import {
  createImageFixture,
  createPlantFixture,
  makeLocationInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTestRequestContext } from "~/server/testing/request-context";

type PublishedTask = { kind: string; entityId?: string; locationId?: string };

/**
 * Writers the kernel does not wrap in its own write transaction — plant bulk
 * patches and the location adapter (`sideEffects: false`) — own their
 * transaction and side effects. Each publication is observed from a second
 * connection at the moment it is sent: a consumer woken before the commit
 * reads the pre-write row.
 */
describe("repository writes publish after their commit", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  afterEach(() => setCfEnv(undefined));

  const recordingQueue = (
    observe: (task: PublishedTask) => Promise<void> = async () => {},
  ) => {
    const published: PublishedTask[] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          send: async () => {},
          sendBatch: async (
            messages: Iterable<{ body: { task: PublishedTask } }>,
          ) => {
            for (const { body } of messages) {
              published.push(body.task);
              await observe(body.task);
            }
          },
        },
      }),
    );
    return published;
  };

  it("bulk-updates plants in one transaction and refreshes their embeddings after it commits", async () => {
    const first = await createPlantFixture(
      ctx.db,
      { name: "Bulk verdict tomato" },
      TEST_ACTOR,
    );
    const second = await createPlantFixture(
      ctx.db,
      { name: "Bulk verdict pepper" },
      TEST_ACTOR,
    );
    const ids = await Promise.all(
      [first, second].map(async (plant) => {
        const id = await resolveLiveShortcode(ctx.db, plant.id, "plant");
        if (!id) throw new Error("plant fixture did not resolve");
        return id;
      }),
    );
    const verdictsAtPublish: (string | null | undefined)[] = [];
    const published = recordingQueue(async (task) => {
      if (task.kind !== "entity-embedding.refresh") return;
      const plant = [first, second][
        ids.findIndex((id) => id === task.entityId)
      ];
      if (plant)
        verdictsAtPublish.push(
          (await getPlantByShortcode(ctx.db, plant.id))?.verdict,
        );
    });

    await executeEntity(context(), {
      action: "bulkUpdate",
      entity: "plant",
      ids: [first.id, second.id].map((id) => parseShortcodeFor("plant", id)),
      data: { verdict: "no" },
    });

    expect(
      published
        .filter((task) => task.kind === "entity-embedding.refresh")
        .map((task) => task.entityId)
        .sort(),
    ).toEqual([...ids].sort());
    expect(verdictsAtPublish).toEqual(["no", "no"]);
  });

  it("clears a location's AI description with its last image before the vision refresh is published", async () => {
    const photo = await createImageFixture(ctx.db, "after-commit-shelf");
    const created = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "After-commit shelf",
        type: "area",
        pendingImageIds: [photo.shortcode],
      }),
      TEST_ACTOR,
    );
    const locationId = await resolveLiveShortcode(
      ctx.db,
      created.id,
      "location",
    );
    if (!locationId) throw new Error("location did not resolve");
    await updateLocationAiDescription(ctx.db, locationId, "A synthetic shelf");
    const seenAtRefresh: { images: number; aiDescription: string | null }[] =
      [];
    recordingQueue(async (task) => {
      if (task.kind !== "location-ai.description.refresh") return;
      const location = await getLocationById(ctx.db, locationId);
      seenAtRefresh.push({
        images: location.images.length,
        aiDescription: location.aiDescription,
      });
    });

    const updated = await executeEntity(context(), {
      action: "update",
      entity: "location",
      id: parseShortcodeFor("location", created.id),
      data: { removeImageIds: [photo.shortcode] },
    });

    if (updated.action !== "update") throw new Error("expected update");
    expect(updated.item).toMatchObject({ aiDescription: null, images: [] });
    expect(seenAtRefresh).toEqual([{ images: 0, aiDescription: null }]);
  });
});
