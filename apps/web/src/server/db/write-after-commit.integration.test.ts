import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { BackgroundTaskMessage } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import {
  recordCommittedChanges,
  withTransactionDatabase,
} from "~/server/db/helpers/core";
import { job } from "~/server/db/schema";
import {
  createLocation,
  getLocationById,
  updateLocationAiDescription,
} from "~/server/domains/location/repo/crud";
import { getPlantByShortcode } from "~/server/domains/plant/repo/plant";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  createImageFixture,
  createPlantFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

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

  it("publishes one outer-commit change set and drops rolled-back savepoint changes", async () => {
    const messages: string[][] = [];
    setCfEnv(
      fromPartial<Env>({
        DB_FRESHNESS: {
          getByName: () => ({
            publishChanges: async (categories: string[]) => {
              messages.push(categories);
            },
          }),
        },
      }),
    );
    await withTransactionDatabase(ctx.db, async (outer) => {
      await recordCommittedChanges(outer, ["task"]);
      await withTransactionDatabase(outer, async (inner) => {
        await recordCommittedChanges(inner, ["task", "project"]);
      });
      await expect(
        withTransactionDatabase(outer, async (inner) => {
          await recordCommittedChanges(inner, ["product"]);
          throw new Error("Synthetic savepoint rollback");
        }),
      ).rejects.toThrow("Synthetic savepoint rollback");
      expect(messages).toEqual([]);
    });
    expect(messages).toEqual([["task", "project"]]);
    await expect(
      withTransactionDatabase(ctx.db, async (outer) => {
        await recordCommittedChanges(outer, ["product"]);
        throw new Error("Synthetic transaction rollback");
      }),
    ).rejects.toThrow("Synthetic transaction rollback");
    expect(messages).toEqual([["task", "project"]]);
  });

  const recordingQueue = (observe: () => Promise<void> = async () => {}) => {
    const published: BackgroundTaskMessage[] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          send: async () => {},
          sendBatch: async (
            messages: Iterable<{ body: BackgroundTaskMessage }>,
          ) => {
            for (const { body } of messages) {
              published.push(body);
              await observe();
            }
          },
        },
      }),
    );
    return published;
  };

  it("bulk-updates plants and publishes durable refresh wakeups after commit", async () => {
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
    const verdictsAtPublish: (string | null | undefined)[][] = [];
    const published = recordingQueue(async () => {
      verdictsAtPublish.push(
        await Promise.all(
          [first, second].map(
            async (plant) =>
              (await getPlantByShortcode(ctx.db, plant.id))?.verdict,
          ),
        ),
      );
    });

    await executeEntity(context(), {
      action: "bulkUpdate",
      entity: "plant",
      ids: [first.id, second.id].map((id) => parseShortcodeFor("plant", id)),
      data: { verdict: "no" },
    });

    expect(published).toContainEqual(
      expect.objectContaining({ queueType: "background" }),
    );
    expect(verdictsAtPublish).toEqual(expect.arrayContaining([["no", "no"]]));
    expect(
      verdictsAtPublish.every((values) =>
        values.every((value) => value === "no"),
      ),
    ).toBe(true);
    expect(
      await getDb(ctx.db)
        .select({ state: job.state })
        .from(job)
        .where(eq(job.key, "refresh:search")),
    ).toEqual([{ state: "queued" }]);
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
    recordingQueue(async () => {
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
    expect(updated.item).toMatchObject({ id: created.id });
    expect(await getLocationById(ctx.db, locationId)).toMatchObject({
      aiDescription: null,
      images: [],
    });
    expect(seenAtRefresh).toContainEqual({ images: 0, aiDescription: null });
    expect(
      seenAtRefresh.every(
        (value) => value.images === 0 && value.aiDescription === null,
      ),
    ).toBe(true);
  });
});
