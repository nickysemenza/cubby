import type { JobId } from "@cubby/schemas/identifiers";
import { pollUntil } from "@cubby/shared/retry";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, inArray, ne, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeSearchText } from "~/lib/search-normalization";
import { readAiBudget } from "~/server/ai/budget";
import { setCfEnv } from "~/server/cf-env";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { entityEmbedding, job, aiUsage } from "~/server/db/retained-tables";
import { product, project } from "~/server/db/schema";
import { connectionRecords } from "~/server/domains/connection/repo/connection-evidence";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { embeddingTextHash } from "~/server/generic/embedding/repo/semantic/hash";
import { embeddingCleanupHandler } from "~/server/generic/embedding/service/embedding-cleanup";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { embedTexts } from "~/server/generic/embedding/service/semantic/embeddings";
import {
  productionVectorStore,
  createInMemoryVectorizeIndex,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { JOB_HEARTBEAT_MS } from "~/server/generic/jobs/limits";
import {
  claimJob,
  renewJob,
  publishJobPage,
} from "~/server/generic/jobs/repo/external-claim";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { publishCompletedJobPages } from "~/server/generic/jobs/repo/queue";
import { drainDueJobs } from "~/server/generic/jobs/service/jobs";
import { prepareSearchDocuments } from "~/server/generic/search/repo/search-document";
import {
  createProductFixture,
  makeProductInput,
  renameFixtureRaw,
} from "~/server/testing/repo.fixtures";
import {
  embeddingJobHandler,
  enqueueEmbeddingRefs,
  type EmbeddingRefreshPort,
} from "~/server/workflows/background-tasks/embedding";

// Existing single-record workflows cannot detect cross-Job poisoning, lost
// fences, or a batching lane starving a member's Run.
describe("embedding batches in the shared drain", () => {
  const ctx = withTestDb();
  afterEach(() => {
    setCfEnv(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const calls: string[][] = [];
  const port = (): EmbeddingRefreshPort => ({
    configured: () => true,
    config: getSemanticEmbeddingConfig,
    vectorStore: productionVectorStore,
    embed: vi.fn(async (texts: string[]) => {
      calls.push(texts);
      return texts.map((_, index) =>
        Array.from({ length: 1536 }, () => (index + 1) / 100),
      );
    }),
  });
  async function seed(
    count: number,
    notes: string | ((index: number) => string) = "",
  ) {
    calls.length = 0;
    setCfEnv(fromPartial<Env>({ VECTORIZE: createInMemoryVectorizeIndex() }));
    const products = [];
    for (let index = 0; index < count; index++)
      products.push(
        await createProductFixture(
          ctx.db,
          makeProductInput({
            name: `Synthetic batch kettle ${index}`,
            notes: typeof notes === "string" ? notes : notes(index),
          }),
          ctx.actor,
        ),
      );
    const refs = products.map((product) => ({
      entityKind: "product" as const,
      entityId: product.entityId,
    }));
    const jobs = await enqueueEmbeddingRefs(
      ctx.db,
      await prepareSearchDocuments(ctx.db, refs),
      getSemanticEmbeddingConfig(),
    );
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(Date.now() + 60_000) })
      .where(ne(job.kind, "embedding.refresh"));
    return { products, jobs };
  }
  async function drain(embeddingPort: EmbeddingRefreshPort) {
    return drainDueJobs(
      ctx.db,
      { "embedding.refresh": embeddingJobHandler(embeddingPort) },
      256,
      20_000,
    );
  }
  async function read(ids: readonly JobId[]) {
    return getDb(ctx.db).select().from(job).where(inArray(job.id, ids));
  }

  it("locks Project before Product in embedding and connection publication", async () => {
    const { products } = await seed(1);
    const order = await createRepoEntity(ctx, "project", {
      name: "Synthetic lock order project",
    });
    const refs = [
      { entityKind: "product" as const, entityId: products[0]!.entityId },
      { entityKind: "project" as const, entityId: order.entityId },
    ];
    const jobs = await enqueueEmbeddingRefs(
      ctx.db,
      await prepareSearchDocuments(ctx.db, refs),
      getSemanticEmbeddingConfig(),
    );
    expect(jobs).toHaveLength(2);
    const handler = embeddingJobHandler(port());
    const claimAll = async () =>
      Promise.all(
        jobs.map(async (row) => {
          const claim = await claimJob(ctx.db, row.id);
          if (!claim) throw new Error("Missing synthetic mixed-kind claim");
          return claim;
        }),
      );
    const uploads = await claimAll();
    await handler.batch!.execute(ctx.db, uploads, {
      deadline: Infinity,
      checkpoint: async (results) => {
        for (const claim of uploads) {
          const result = results.get(claim.id);
          if (!result || result.status !== "fulfilled")
            throw new Error("Missing upload receipt");
          await publishJobPage(
            ctx.db,
            claim,
            result.value.page,
            result.value.publish,
          );
        }
      },
    });
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(
        inArray(
          job.id,
          jobs.map(({ id }) => id),
        ),
      );
    const claims = await claimAll();
    await handler.batch!.execute(ctx.db, claims, {
      deadline: Infinity,
      checkpoint: async (results) => {
        const group = results.get(claims[0]!.id);
        if (
          !group ||
          group.status !== "fulfilled" ||
          !group.value.publicationGroup
        )
          throw new Error("Missing mixed-kind publication");
        const publish = group.value.publicationGroup.publish;
        // A blocked Project must leave Product unlocked: otherwise the other
        // publisher can hold Project while waiting for Product, forming a cycle.
        for (const [operationIndex, operation] of [
          () =>
            withTransactionDatabase(ctx.db, (tx) =>
              publish(tx, new Set(claims.map((claim) => claim.id))),
            ),
          () =>
            withTransactionDatabase(ctx.db, (tx) =>
              connectionRecords(
                tx,
                [
                  { entityKind: "product", entityId: products[0]!.id },
                  { entityKind: "project", entityId: order.output.id },
                ],
                true,
              ),
            ),
        ].entries()) {
          let pending: Promise<unknown> | undefined;
          try {
            await withTransactionDatabase(ctx.db, async (tx) => {
              const held = await getDb(tx).execute(
                sql`SELECT id FROM ${project} WHERE ${project.id} = ${order.entityId} FOR UPDATE`,
              );
              expect(held.rows).toHaveLength(1);
              pending = operation();
              // Wait for the real lock wait, not an arbitrary timing interval.
              await pollUntil(
                async () => {
                  const result = await getDb(ctx.db).execute<{
                    waiting: boolean;
                  }>(sql`SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                  AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'

              ) AS waiting`);
                  return result.rows[0]?.waiting ? true : undefined;
                },
                {
                  label: `mixed-kind publication lock ${operationIndex}`,
                  timeoutMs: 5000,
                  intervalMs: 10,
                },
              );
              await getDb(tx).execute(
                sql`SELECT id FROM ${product} WHERE ${product.id} = ${products[0]!.entityId} FOR UPDATE NOWAIT`,
              );
            });
          } finally {
            await pending;
          }
        }
      },
    });
  });

  it(
    "publishes 1 and 100 completed selections",
    { timeout: 120_000 },
    async () => {
      for (const count of [1, 100]) {
        const { jobs } = await seed(count);
        const handler = embeddingJobHandler(port());
        const claimAll = async () => {
          const claims = [];
          for (const row of jobs) {
            const claim = await claimJob(ctx.db, row.id);
            if (!claim) throw new Error("Missing synthetic embedding claim");
            claims.push(claim);
          }
          return claims;
        };
        const uploads = await claimAll();
        await handler.batch!.execute(ctx.db, uploads, {
          deadline: Infinity,
          checkpoint: async (results) => {
            for (const claim of uploads) {
              const result = results.get(claim.id);
              if (!result || result.status !== "fulfilled")
                throw new Error("Missing upload receipt");
              await publishJobPage(
                ctx.db,
                claim,
                result.value.page,
                result.value.publish,
              );
            }
          },
        });
        await getDb(ctx.db)
          .update(job)
          .set({ availableAt: new Date(0) })
          .where(
            inArray(
              job.id,
              jobs.map(({ id }) => id),
            ),
          );
        const claims = await claimAll();
        await handler.batch!.execute(ctx.db, claims, {
          deadline: Infinity,
          checkpoint: async (results) => {
            const entries = claims.map((claim) => {
              const result = results.get(claim.id);
              if (!result || result.status !== "fulfilled")
                throw new Error("Missing visible selection");
              return { claim, prepared: result.value };
            });
            const group = entries[0]?.prepared.publicationGroup;
            if (group) {
              await publishCompletedJobPages(
                ctx.db,
                entries.map(({ claim, prepared }) => ({
                  claim,
                  page: prepared.page,
                })),
                group.publish,
              );
              return;
            }
            for (const { claim, prepared } of entries)
              await publishJobPage(
                ctx.db,
                claim,
                prepared.page,
                prepared.publish,
              );
          },
        });
        expect(
          (await read(jobs.map(({ id }) => id))).every(
            ({ state }) => state === "completed",
          ),
        ).toBe(true);
        expect(
          await getDb(ctx.db)
            .select()
            .from(entityEmbedding)
            .where(
              inArray(
                entityEmbedding.id,
                jobs.map(({ id }) => id),
              ),
            ),
        ).toHaveLength(count);
      }
    },
  );

  it.each(["changed", "removed", "data", "revoked"])(
    "isolates a %s target during page publication",
    async (failure) => {
      const { jobs, products } = await seed(3);
      const embeddingPort = port();
      await drain(embeddingPort);
      const bad = products[0]!;
      await getDb(ctx.db)
        .update(job)
        .set({ availableAt: new Date(0) })
        .where(
          inArray(
            job.id,
            jobs.map(({ id }) => id),
          ),
        );
      try {
        if (failure === "data") {
          await getDb(ctx.db)
            .execute(sql`CREATE FUNCTION synthetic_selection_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW."embeddingText" LIKE '%synthetic batch kettle 0%' THEN
            RAISE EXCEPTION 'Synthetic rejected selection' USING ERRCODE='23514';
          END IF; RETURN NEW; END $$`);
          await getDb(ctx.db).execute(
            sql`CREATE TRIGGER synthetic_selection_failure BEFORE INSERT ON "EntityEmbedding" FOR EACH ROW EXECUTE FUNCTION synthetic_selection_failure()`,
          );
        }
        await drain({
          ...embeddingPort,
          vectorStore: {
            ...embeddingPort.vectorStore,
            getByIds: async (ids) => {
              const vectors = await embeddingPort.vectorStore.getByIds(ids);
              if (failure === "changed")
                await renameFixtureRaw(
                  ctx.db,
                  "product",
                  bad.entityId,
                  "Synthetic changed source",
                );
              if (failure === "revoked")
                await getDb(ctx.db)
                  .update(job)
                  .set({
                    state: "cancelled",
                    leaseToken: null,
                    leaseExpiresAt: null,
                  })
                  .where(eq(job.subjectId, bad.entityId));
              if (failure === "removed")
                await getDb(ctx.db).execute(
                  sql`UPDATE "Product" SET "deletedAt"=now() WHERE id=${bad.entityId}`,
                );
              return vectors;
            },
          },
        });
        const rows = await read(jobs.map(({ id }) => id));
        expect(rows.filter(({ state }) => state === "completed")).toHaveLength(
          2,
        );
        expect(
          rows.find(({ subjectId }) => subjectId === bad.entityId),
        ).toMatchObject({
          state: failure === "revoked" ? "cancelled" : "retry_wait",
          attempts: 1,
        });
        expect(
          await getDb(ctx.db)
            .select()
            .from(entityEmbedding)
            .where(eq(entityEmbedding.artifactState, "selected")),
        ).toHaveLength(2);
      } finally {
        if (failure === "data") {
          await getDb(ctx.db).execute(
            sql`DROP TRIGGER IF EXISTS synthetic_selection_failure ON "EntityEmbedding"`,
          );
          await getDb(ctx.db).execute(
            sql`DROP FUNCTION IF EXISTS synthetic_selection_failure()`,
          );
        }
      }
    },
  );

  it("backs off visibility deadlines beyond the attempt limit and selects the late upload", async () => {
    const { jobs } = await seed(1);
    const embeddingPort = port();
    await drain(embeddingPort);
    await getDb(ctx.db)
      .update(job)
      .set({
        availableAt: new Date(0),
        attempts: 2,
        cursor: sql`jsonb_set(cursor, '{submittedAt}', '"2000-01-01T00:00:00.000Z"'::jsonb)`,
      })
      .where(eq(job.id, jobs[0]!.id));
    await drain({
      ...embeddingPort,
      vectorStore: { ...embeddingPort.vectorStore, getByIds: async () => [] },
    });
    const [waiting] = await read([jobs[0]!.id]);
    expect(waiting).toMatchObject({
      state: "retry_wait",
      attempts: 3,
      maxAttempts: 4,
    });
    expect(waiting!.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(waiting!.error).toContain("visibility deadline");
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, jobs[0]!.id));
    await drain(embeddingPort);
    expect((await read([jobs[0]!.id]))[0]).toMatchObject({
      state: "completed",
      attempts: 0,
    });
    expect(embeddingPort.embed).toHaveBeenCalledTimes(1);
  });

  it("backs off Vectorize cleanup rate limits beyond the attempt limit", async () => {
    const artifactId = crypto.randomUUID();
    const index = createInMemoryVectorizeIndex();
    let limited = true;
    setCfEnv(
      fromPartial<Env>({
        VECTORIZE: {
          ...index,
          deleteByIds: async (ids: string[]) => {
            if (limited)
              throw new Error(
                "VECTOR_DELETE_ERROR (code = 40041): Too Many Requests",
              );
            return index.deleteByIds(ids);
          },
        },
      }),
    );
    const cleanup = await enqueueJob(ctx.db, {
      key: `embedding-cleanup:${artifactId}`,
      kind: "embedding.cleanup",
      input: { artifactId },
    });
    await getDb(ctx.db)
      .update(job)
      .set({ attempts: 2 })
      .where(eq(job.id, cleanup.id));
    const handlers = { "embedding.cleanup": embeddingCleanupHandler() };
    await drainDueJobs(ctx.db, handlers);
    const [waiting] = await read([cleanup.id]);
    expect(waiting).toMatchObject({
      state: "retry_wait",
      attempts: 3,
      maxAttempts: 4,
    });
    expect(waiting!.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(waiting!.error).toContain("Too Many Requests");
    limited = false;
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, cleanup.id));
    await drainDueJobs(ctx.db, handlers);
    expect((await read([cleanup.id]))[0]?.state).toBe("completed");
  });

  it(
    "embeds 101 Jobs in full pages and selects each vector under its own claim",
    { timeout: 120_000 },
    async () => {
      const { jobs } = await seed(101);
      const embeddingPort = port();
      // A wake's time budget can end after the full page and before its tail.
      for (let wake = 0; wake < 3; wake++) {
        await drain(embeddingPort);
        if (
          (await read(jobs.map((row) => row.id))).every(
            (row) => row.state === "completed" || row.cursor !== null,
          )
        )
          break;
      }
      expect(calls.map((texts) => texts.length)).toEqual([100, 1]);
      expect(
        (await read(jobs.map((row) => row.id))).every(
          (row) =>
            row.state === "completed" ||
            (row.state === "queued" && row.cursor !== null),
        ),
      ).toBe(true);
      await getDb(ctx.db)
        .update(job)
        .set({ availableAt: new Date(0) })
        .where(eq(job.kind, "embedding.refresh"));
      for (let wake = 0; wake < 3; wake++) {
        await drain(embeddingPort);
        if (
          (await read(jobs.map((row) => row.id))).every(
            (row) => row.state === "completed",
          )
        )
          break;
      }
      expect(calls).toHaveLength(2);
      expect(
        (await read(jobs.map((row) => row.id))).every(
          (row) => row.state === "completed",
        ),
      ).toBe(true);
      const selected = await getDb(ctx.db)
        .select()
        .from(entityEmbedding)
        .where(
          inArray(
            entityEmbedding.id,
            jobs.map((row) => row.id),
          ),
        );
      expect(selected).toHaveLength(101);
      expect(selected.every((row) => row.artifactState === "selected")).toBe(
        true,
      );
      setCfEnv(undefined);
    },
  );

  it("settles a stale source alone while the other Jobs upload", async () => {
    const { products, jobs } = await seed(3);
    const stale = products[1]!;
    await renameFixtureRaw(
      ctx.db,
      "product",
      stale.entityId,
      "Synthetic changed kettle",
    );
    await drain(port());
    expect(calls.map((texts) => texts.length)).toEqual([2]);
    const rows = await read(jobs.map((row) => row.id));
    expect(rows.find((row) => row.subjectId === stale.entityId)).toMatchObject({
      state: "completed",
      result: { outcome: "obsolete" },
    });
    expect(
      rows
        .filter((row) => row.subjectId !== stale.entityId)
        .every((row) => row.state === "queued" && row.error === null),
    ).toBe(true);
    setCfEnv(undefined);
  });

  it("retries a failed provider chunk without charging attempts to run-owned work", async () => {
    const { jobs } = await seed(3);
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const owned = await enqueueJob(ctx.db, {
      key: "synthetic.run-owned",
      kind: "synthetic.member",
      input: {},
      runId,
    });
    const events: string[] = [];
    const embeddingPort = port();
    const failing = {
      ...embeddingPort,
      embed: vi.fn(async () => {
        events.push("embedding");
        throw new Error("Synthetic provider failure");
      }),
    };
    await drainDueJobs(
      ctx.db,
      {
        "embedding.refresh": embeddingJobHandler(failing),
        "synthetic.member": {
          prepare: async () => {
            events.push("member");
            return { page: { done: true } };
          },
        },
      },
      4,
      20_000,
      1,
    );
    // With one test lane, the reservation runs first. The three-lane fairness
    // regression owns Run priority in the remaining execution capacity.
    expect(events).toEqual(["embedding", "member"]);
    expect(failing.embed).toHaveBeenCalledTimes(1);
    const rows = await read(jobs.map((row) => row.id));
    expect(
      rows.every(
        (row) =>
          row.state === "retry_wait" &&
          row.attempts === 1 &&
          row.error?.includes("Synthetic provider failure"),
      ),
    ).toBe(true);
    expect((await read([owned.id]))[0]).toMatchObject({
      state: "completed",
      attempts: 0,
      error: null,
    });
    setCfEnv(undefined);
  });
  it("keeps Run-owned and background embedding pages separate while serving another Run", async () => {
    const { jobs } = await seed(4);
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    await getDb(ctx.db)
      .update(job)
      .set({ runId, priority: 100 })
      .where(eq(job.id, jobs[0]!.id));
    const owned = await enqueueJob(ctx.db, {
      key: "synthetic.member-turn",
      kind: "synthetic.member",
      input: {},
      runId,
    });
    const events: string[] = [];
    const embeddingPort = port();
    await drainDueJobs(
      ctx.db,
      {
        "embedding.refresh": embeddingJobHandler({
          ...embeddingPort,
          embed: async (texts, opts) => {
            events.push(`embedding:${texts.length}`);
            return embeddingPort.embed(texts, opts);
          },
        }),
        "synthetic.member": {
          prepare: async () => {
            events.push("member");
            return { page: { done: true } };
          },
        },
      },
      5,
      20_000,
      1,
    );
    expect(events).toEqual(["embedding:1", "embedding:3", "member"]);
    expect((await read([owned.id]))[0]).toMatchObject({
      state: "completed",
      error: null,
    });
  });

  it("keeps a superseded claim out of publication while its siblings finish", async () => {
    const { jobs } = await seed(3);
    const stopped = jobs[1]!;
    const embeddingPort = port();
    await drain({
      ...embeddingPort,
      embed: async (texts, opts) => {
        await getDb(ctx.db)
          .update(job)
          .set({ state: "cancelled", leaseToken: null, leaseExpiresAt: null })
          .where(eq(job.id, stopped.id));
        return embeddingPort.embed(texts, opts);
      },
    });
    expect((await read([stopped.id]))[0]).toMatchObject({
      state: "cancelled",
      cursor: null,
    });
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.kind, "embedding.refresh"));
    await drain(embeddingPort);
    expect(
      (
        await read(
          jobs.filter((row) => row.id !== stopped.id).map((row) => row.id),
        )
      ).every((row) => row.state === "completed"),
    ).toBe(true);
    expect(
      await getDb(ctx.db)
        .select()
        .from(entityEmbedding)
        .where(eq(entityEmbedding.id, stopped.id)),
    ).toEqual([]);
  });

  it(
    "chunks the aggregate token bound and isolates long inputs",
    { timeout: 60_000 },
    async () => {
      await seed(39, "é".repeat(3900));
      await drain(port());
      expect(calls).toHaveLength(2);
      expect(calls.flat()).toHaveLength(39);
      expect(
        calls.every(
          (texts) =>
            texts.reduce(
              (sum, text) => sum + new TextEncoder().encode(text).length,
              0,
            ) <= 300_000,
        ),
      ).toBe(true);
    },
  );

  it("isolates a provider-rejected long input from ordinary neighbors", async () => {
    const { jobs } = await seed(3, (index) =>
      index === 1 ? "é".repeat(5000) : "",
    );
    const embeddingPort = port();
    const seen: number[] = [];
    await drain({
      ...embeddingPort,
      embed: async (texts, opts) => {
        seen.push(texts.length);
        if (texts.some((text) => new TextEncoder().encode(text).length > 8192))
          throw new Error("Synthetic oversized input");
        return embeddingPort.embed(texts, opts);
      },
    });
    expect(seen.reduce((sum, count) => sum + count, 0)).toBe(3);
    const rows = await read(jobs.map((row) => row.id));
    expect(rows.filter((row) => row.state === "retry_wait")).toHaveLength(1);
    expect(
      rows.filter((row) => row.state === "queued" && row.cursor !== null),
    ).toHaveLength(2);
  });

  it("checkpoints slow chunks, releases unstarted claims at the budget, and serves a new Run in the next wake", async () => {
    const { jobs } = await seed(6, "é".repeat(5000));
    const embeddingPort = port();
    const now = Date.now();
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now + elapsed);
    const uploaded: JobId[] = [];
    const checkpoints: boolean[] = [];
    const events: string[] = [];
    let member: Awaited<ReturnType<typeof enqueueJob>> | undefined;
    const measured: EmbeddingRefreshPort = {
      ...embeddingPort,
      vectorStore: {
        ...embeddingPort.vectorStore,
        upsert: async (vectors) => {
          uploaded.push(
            ...jobs
              .filter((row) => vectors.some((vector) => vector.id === row.id))
              .map((row) => row.id),
          );
          return embeddingPort.vectorStore.upsert(vectors);
        },
      },
      embed: async (texts, opts) => {
        if (uploaded.length)
          checkpoints.push(
            (await read(uploaded)).every(
              (row) => row.state === "queued" && row.cursor !== null,
            ),
          );
        events.push("embedding");
        elapsed += 8_000;
        if (!member) {
          const runId = await ensureRun(ctx.db, ctx.actor, {
            purpose: "ai_suggest",
            trigger: "manual",
            execution: false,
          });
          member = await enqueueJob(ctx.db, {
            key: "synthetic.mid-batch-member",
            kind: "synthetic.member",
            input: {},
            runId,
          });
          await getDb(ctx.db)
            .update(job)
            .set({ availableAt: new Date(now + 60_000) })
            .where(ne(job.kind, "embedding.refresh"));
          await getDb(ctx.db)
            .update(job)
            .set({ availableAt: new Date(0) })
            .where(eq(job.id, member.id));
        }
        return embeddingPort.embed(texts, opts);
      },
    };
    const handlers = {
      "embedding.refresh": embeddingJobHandler(measured),
      "synthetic.member": {
        prepare: async () => {
          events.push("member");
          return { page: { done: true } };
        },
      },
    };
    const outcomes = await drainDueJobs(ctx.db, handlers, 64, 20_000, 1);
    expect(calls).toHaveLength(3);
    expect(elapsed).toBe(24_000); // One in-flight chunk can cross the deadline.
    expect(checkpoints).toEqual([true, true]);
    expect(outcomes.filter((outcome) => outcome === "released")).toHaveLength(
      3,
    );
    const rows = await read(jobs.map((row) => row.id));
    expect(rows.filter((row) => row.cursor !== null)).toHaveLength(3);
    expect(
      rows
        .filter((row) => row.cursor === null)
        .every(
          (row) =>
            row.state === "queued" &&
            row.attempts === 0 &&
            row.leaseToken === null,
        ),
    ).toBe(true);
    const firstWakeEvents = events.length;
    await drainDueJobs(ctx.db, handlers, 2, 20_000, 1);
    expect(events.slice(firstWakeEvents)).toEqual(["embedding", "member"]);
    if (!member) throw new Error("Missing synthetic member Job");
    expect((await read([member.id]))[0]?.state).toBe("completed");
  });

  it.each(["error", "locked"])(
    "renews healthy batch siblings despite one %s, then fences its expired reclaimed claim",
    async (failure) => {
      const { jobs } = await seed(3);
      const bad = jobs[0]!;
      const healthy = jobs.slice(1);
      await getDb(ctx.db)
        .update(job)
        .set({ key: "synthetic.renewal-failure", priority: 100 })
        .where(eq(job.id, bad.id));
      const setRealInterval = globalThis.setInterval;
      let heartbeat: (() => void) | undefined;
      vi.spyOn(globalThis, "setInterval").mockImplementation(
        (callback, delay, ...args) => {
          if (delay === JOB_HEARTBEAT_MS && typeof callback === "function")
            heartbeat = () => callback(...args);
          return setRealInterval(callback, delay, ...args);
        },
      );
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const unlocked = Promise.withResolvers<void>();
      const locked = Promise.withResolvers<void>();
      const embeddingPort = port();
      const draining = drainDueJobs(
        ctx.db,
        {
          "embedding.refresh": embeddingJobHandler({
            ...embeddingPort,
            embed: async (texts, opts) => {
              entered.resolve();
              await finish.promise;
              return embeddingPort.embed(texts, opts);
            },
          }),
        },
        3,
      );
      let holding: Promise<void> | undefined;
      try {
        await entered.promise;
        const expires = new Date(Date.now() + 60_000);
        await getDb(ctx.db)
          .update(job)
          .set({ leaseExpiresAt: expires })
          .where(
            inArray(
              job.id,
              jobs.map((row) => row.id),
            ),
          );
        const [prior] = await read([bad.id]);
        if (!prior?.leaseToken) throw new Error("Missing synthetic claim");
        if (failure === "error") {
          await getDb(ctx.db)
            .execute(sql`CREATE FUNCTION synthetic_renewal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.key = 'synthetic.renewal-failure' AND NEW."leaseToken" = OLD."leaseToken" AND NEW."leaseExpiresAt" > OLD."leaseExpiresAt"
          THEN RAISE EXCEPTION 'Synthetic renewal failure'; END IF; RETURN NEW; END $$`);
          await getDb(ctx.db).execute(
            sql`CREATE TRIGGER synthetic_renewal_failure BEFORE UPDATE ON "Job" FOR EACH ROW EXECUTE FUNCTION synthetic_renewal_failure()`,
          );
        } else {
          holding = withTransactionDatabase(ctx.db, async (tx) => {
            await getDb(tx)
              .select()
              .from(job)
              .where(eq(job.id, bad.id))
              .for("update");
            locked.resolve();
            await unlocked.promise;
          });
          holding.catch(locked.reject);
          await locked.promise;
        }
        if (!heartbeat) throw new Error("Missing batch heartbeat");
        heartbeat();
        await pollUntil(
          async () =>
            (await read(healthy.map((row) => row.id))).every(
              (row) => row.leaseExpiresAt && row.leaseExpiresAt > expires,
            )
              ? true
              : undefined,
          {
            label: "healthy batch lease renewals",
            timeoutMs: 5_000,
            intervalMs: 10,
          },
        );
        expect((await read([bad.id]))[0]?.leaseExpiresAt).toEqual(expires);
        unlocked.resolve();
        await holding;
        await getDb(ctx.db)
          .update(job)
          .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
          .where(eq(job.id, bad.id));
        const old = {
          id: bad.id,
          leaseToken: prior.leaseToken,
          generation: prior.generation,
        };
        expect(await renewJob(ctx.db, old)).toBe(false);
        const replacement = await claimJob(ctx.db, bad.id);
        if (!replacement) throw new Error("Expected synthetic lease reclaim");
        expect(replacement.leaseToken).not.toBe(prior.leaseToken);
        finish.resolve();
        await draining;
        expect((await read([bad.id]))[0]).toMatchObject({
          state: "running",
          leaseToken: replacement.leaseToken,
          cursor: null,
        });
        await getDb(ctx.db)
          .update(job)
          .set({ availableAt: new Date(0) })
          .where(
            inArray(
              job.id,
              healthy.map((row) => row.id),
            ),
          );
        await drain(embeddingPort);
        expect(
          (await read(healthy.map((row) => row.id))).every(
            (row) => row.state === "completed",
          ),
        ).toBe(true);
        expect(await publishJobPage(ctx.db, replacement, { done: true })).toBe(
          true,
        );
        expect((await read([bad.id]))[0]?.state).toBe("completed");
      } finally {
        unlocked.resolve();
        finish.resolve();
        try {
          await holding;
          await draining;
        } finally {
          // The file database resets rows between cases, not its catalog.
          if (failure === "error") {
            await getDb(ctx.db).execute(
              sql`DROP TRIGGER IF EXISTS synthetic_renewal_failure ON "Job"`,
            );
            await getDb(ctx.db).execute(
              sql`DROP FUNCTION IF EXISTS synthetic_renewal_failure()`,
            );
          }
        }
      }
    },
  );

  it.each([
    { model: "text-embedding-3-large" as const, dimensions: 1536 },
    { model: "text-embedding-3-small" as const, dimensions: 512 },
  ])(
    "re-admits obsolete $model/$dimensions Jobs with correct usage and provenance",
    async (previous) => {
      const { jobs, products } = await seed(3);
      const documents = await prepareSearchDocuments(
        ctx.db,
        products.map((product) => ({
          entityKind: "product" as const,
          entityId: product.entityId,
        })),
      );
      // A retired model snapshot cannot be admitted by the current producer.
      for (const row of jobs) {
        const entry = documents.entries.find(
          ({ source }) => source.entityId === row.subjectId,
        );
        if (!entry) throw new Error("Missing synthetic source document");
        const config = { provider: "openai" as const, ...previous };
        const text = normalizeSearchText(entry.body);
        const hash = await embeddingTextHash({
          entityKind: entry.source.entityKind,
          ...config,
          text,
        });
        await getDb(ctx.db)
          .update(job)
          .set({
            key: `embedding:${entry.source.entityKind}:${entry.source.entityId}:${hash}`,
            input: {
              entityKind: entry.source.entityKind,
              entityId: entry.source.entityId,
              text,
              hash,
              config,
            },
          })
          .where(eq(job.id, row.id));
      }
      const requests: { input: string[]; model: string; dimensions: number }[] =
        [];
      vi.stubGlobal("fetch", async () =>
        Response.json({
          openai: {
            models: {
              "text-embedding-3-small": { cost: { input: 0.02, output: 0 } },
            },
          },
        }),
      );
      const embeddingPort = port();
      const current = getSemanticEmbeddingConfig();
      await drain({
        ...embeddingPort,
        embed: (texts, opts) =>
          embedTexts(texts, opts, {
            configured: () => true,
            config: getSemanticEmbeddingConfig,
            vectorStore: embeddingPort.vectorStore,
            fetchFor: (_metadata, observers) => async (_url, init) => {
              const request = JSON.parse(String(init?.body));
              requests.push(request);
              observers.onTransport("gateway");
              return Response.json({
                data: request.input.map((_: string, index: number) => ({
                  index,
                  embedding: Array.from(
                    { length: request.dimensions },
                    () => 0.5,
                  ),
                })),
                usage: { prompt_tokens: 12, total_tokens: 12 },
              });
            },
          }),
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: current.model,
        dimensions: current.dimensions,
        input: expect.any(Array),
      });
      expect(requests[0]?.input).toHaveLength(3);
      const usage = await getDb(ctx.db).select().from(aiUsage);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        feature: "entity_embedding",
        model: current.model,
        inputTokens: 12,
        attempt: 1,
        entityKind: null,
        entityId: null,
      });
      expect((await readAiBudget(ctx.db)).paid.spentUsd).toBe(0);
      await getDb(ctx.db)
        .update(job)
        .set({ availableAt: new Date(0) })
        .where(eq(job.kind, "embedding.refresh"));
      await drain(embeddingPort);
      const selected = await getDb(ctx.db)
        .select()
        .from(entityEmbedding)
        .where(eq(entityEmbedding.artifactState, "selected"));
      expect(selected).toHaveLength(3);
      expect(
        selected.every(
          (row) => !jobs.some((previous) => previous.id === row.id),
        ),
      ).toBe(true);
      expect(
        (await read(jobs.map((row) => row.id))).every(
          (row) =>
            row.state === "completed" &&
            row.result &&
            typeof row.result === "object" &&
            "outcome" in row.result &&
            row.result.outcome === "obsolete",
        ),
      ).toBe(true);
      expect(
        selected.every(
          (row) =>
            row.model === current.model &&
            row.dimensions === current.dimensions,
        ),
      ).toBe(true);
    },
  );
});
