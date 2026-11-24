import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { BackgroundTaskMessage } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import type { DatabaseChanges } from "~/lib/doorbell";
import { afterResponse, runWithExecutionCtx, setCfEnv } from "~/server/cf-env";
import { withMemberFreshness } from "~/server/db/freshness/member-marker";
import {
  recordCommittedChanges,
  runAfterCommit,
  withAfterCommitScope,
  withTransactionDatabase,
} from "~/server/db/helpers/core";
import {
  createLocation,
  readLocationById,
  updateLocationAiDescription,
} from "~/server/domains/location/repo/crud";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { recordChange } from "~/server/generic/changes/repo/change";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  createImageFixture,
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

  it("coalesces keyed effects across commits and released savepoints", async () => {
    const flushed: string[][] = [];
    const flush = async (_db: typeof ctx.db, items: string[]) => {
      flushed.push(items);
    };
    await withAfterCommitScope(async () => {
      await withTransactionDatabase(ctx.db, async (outer) => {
        await runAfterCommit(outer, {
          key: "example",
          items: ["outer"],
          flush,
        });
        await withTransactionDatabase(outer, async (inner) => {
          await runAfterCommit(inner, {
            key: "example",
            items: ["released"],
            flush,
          });
        });
        await expect(
          withTransactionDatabase(outer, async (inner) => {
            await runAfterCommit(inner, {
              key: "example",
              items: ["rolled back"],
              flush,
            });
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
      });
      await withTransactionDatabase(ctx.db, async (db) => {
        await runAfterCommit(db, { key: "example", items: ["second"], flush });
      });
      expect(flushed).toEqual([]);
    });
    expect(flushed).toEqual([["outer", "released", "second"]]);

    const tasks: Promise<unknown>[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await runWithExecutionCtx({ waitUntil: (task) => tasks.push(task) }, () =>
      withAfterCommitScope(
        async () => {
          await withTransactionDatabase(ctx.db, async (db) => {
            await runAfterCommit(db, {
              key: "deferred",
              items: ["later"],
              flush: async (_db, items) => {
                await gate;
                flushed.push(items);
              },
            });
          });
        },
        (flush) => afterResponse(flush()),
      ),
    );
    expect(flushed).toEqual([["outer", "released", "second"]]);
    expect(tasks).toHaveLength(1);
    release();
    await Promise.all(tasks);
    expect(flushed).toEqual([["outer", "released", "second"], ["later"]]);
  });

  it("rings for requests and for background commits a member waits on", async () => {
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
    await recordChange(ctx.db, { kind: "projection", categories: ["search"] });
    expect(messages).toEqual([]);
    await recordChange(ctx.db, {
      kind: "projection",
      categories: ["imageJob"],
      ringFromBackground: true,
    });
    await withMemberFreshness(() =>
      recordChange(ctx.db, { kind: "projection", categories: ["task"] }),
    );
    expect(messages).toEqual([{ imageJob: null }, { task: null }]);
  });

  const recordingQueue = (observe: () => Promise<void> = async () => {}) => {
    const published: BackgroundTaskMessage[] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          send: async () => {},
          sendBatch: async (
            messages: Iterable<{
              body: BackgroundTaskMessage;
              delaySeconds?: number;
            }>,
          ) => {
            for (const { body, delaySeconds } of messages) {
              published.push(body);
              if (!delaySeconds) await observe();
            }
          },
        },
      }),
    );
    return published;
  };

  it("sends no permit for source and projection writes that create no kernel work", async () => {
    const published = recordingQueue();
    await withTransactionDatabase(ctx.db, async (outer) => {
      await withTransactionDatabase(outer, async (inner) => {
        await recordChange(inner, { kind: "source", categories: ["task"] });
      });
      await recordChange(outer, { kind: "source", categories: ["project"] });
      await recordChange(outer, {
        kind: "projection",
        categories: ["image"],
      });
    });
    await recordChange(ctx.db, { kind: "source", categories: ["task"] });
    expect(published).toEqual([]);
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
