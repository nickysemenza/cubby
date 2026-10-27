import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { BackgroundTaskMessage } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, sql } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import type { DatabaseChanges } from "~/lib/doorbell";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import {
  recordCommittedChanges,
  withTransactionDatabase,
} from "~/server/db/helpers/core";
import { job, jobInvalidationCapture } from "~/server/db/schema";
import {
  createLocation,
  readLocationById,
  updateLocationAiDescription,
} from "~/server/domains/location/repo/crud";
import { readPlant } from "~/server/domains/plant/repo/plant";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { recordChange } from "~/server/generic/changes/repo/change";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { derivedMarkTickets } from "~/server/testing/background-queue";
import {
  createImageFixture,
  createPlantFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * Observe generic bulk saves and Location image follow-ups from a second
 * connection at the moment a wake is sent. A consumer woken before commit
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
    const messages: DatabaseChanges[] = [];
    setCfEnv(
      fromPartial<Env>({
        DB_FRESHNESS: {
          getByName: () => ({
            publishChanges: async (changes: DatabaseChanges) => {
              messages.push(changes);
            },
          }),
        },
      }),
    );
    await withTransactionDatabase(ctx.db, async (outer) => {
      await recordCommittedChanges(outer, { task: ["TSK-A3F2"] });
      await withTransactionDatabase(outer, async (inner) => {
        await recordCommittedChanges(inner, {
          task: ["TSK-B4G3"],
          project: null,
        });
      });
      await expect(
        withTransactionDatabase(outer, async (inner) => {
          await recordCommittedChanges(inner, { product: null });
          throw new Error("Synthetic savepoint rollback");
        }),
      ).rejects.toThrow("Synthetic savepoint rollback");
      expect(messages).toEqual([]);
    });
    expect(messages).toEqual([
      { task: ["TSK-A3F2", "TSK-B4G3"], project: null },
    ]);
    await expect(
      withTransactionDatabase(ctx.db, async (outer) => {
        await recordCommittedChanges(outer, { product: null });
        throw new Error("Synthetic transaction rollback");
      }),
    ).rejects.toThrow("Synthetic transaction rollback");
    expect(messages).toEqual([
      { task: ["TSK-A3F2", "TSK-B4G3"], project: null },
    ]);
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

  it("coalesces source wakes across savepoints without enrolling work from notifications", async () => {
    await recordChange(ctx.db, { kind: "source", categories: ["task"] });
    // Captures append input without changing the execution Job.
    const generations = () =>
      getDb(ctx.db)
        .select({
          key: jobInvalidationCapture.key,
          generation: sql<number>`count(*)::int`,
        })
        .from(jobInvalidationCapture)
        .groupBy(jobInvalidationCapture.key)
        .orderBy(jobInvalidationCapture.key);
    const executions = () =>
      getDb(ctx.db)
        .select({ id: job.id, generation: job.generation, state: job.state })
        .from(job)
        .where(eq(job.kind, "derived.drain"))
        .orderBy(job.id);
    const before = await generations();
    const executionsBefore = await executions();
    const published = recordingQueue();
    await withTransactionDatabase(ctx.db, async (outer) => {
      // A rolled-back first registration must not consume the deduplication key.
      await expect(
        withTransactionDatabase(outer, async (inner) => {
          await recordChange(inner, {
            kind: "source",
            categories: ["product"],
          });
          throw new Error("Synthetic savepoint rollback");
        }),
      ).rejects.toThrow("Synthetic savepoint rollback");
      await withTransactionDatabase(outer, async (inner) => {
        await recordChange(inner, { kind: "source", categories: ["task"] });
        await recordChange(inner, { kind: "source", categories: ["task"] });
      });
      await recordChange(outer, { kind: "source", categories: ["project"] });
      await recordChange(outer, {
        kind: "projection",
        categories: ["image"],
      });
      expect(published).toEqual([]);
    });
    expect(await generations()).toEqual(before);
    expect(await executions()).toEqual(executionsBefore);
    expect(published).toHaveLength(1);
    const afterSource = await generations();
    await recordChange(ctx.db, {
      kind: "projection",
      categories: ["search", "relatedData"],
    });
    expect(await generations()).toEqual(afterSource);
    expect(published).toHaveLength(1);
  });

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
            async (plant) => (await readPlant(ctx.db, plant.id))?.verdict,
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
      await derivedMarkTickets(ctx.db, "plant.searchDocument"),
    ).toHaveLength(2);
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
      const location = await readLocationById(ctx.db, locationId);
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
    expect(await readLocationById(ctx.db, locationId)).toMatchObject({
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
