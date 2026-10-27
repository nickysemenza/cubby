import { jobShortcode } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { JobSetFilter } from "~/contracts/job.contract";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { readJobQueue } from "~/server/generic/jobs/repo/job-queue";
import { retryJobSet } from "~/server/generic/jobs/repo/job-queue";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { createImageFixture } from "~/server/testing/repo.fixtures";

import { jobRepository } from "./repo";

describe("Job entity reads and scoped retry", () => {
  const ctx = withTestDb();
  it("loads Run labels and subject thumbnails and keeps internal work out of ordinary reads", async () => {
    const image = await createImageFixture(ctx.db, "synthetic-job-subject");
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      execution: false,
    });
    const work = await enqueueJob(ctx.db, {
      key: "synthetic:entity-job",
      kind: "image.device",
      input: {},
      runId,
      subjectKind: "image",
      subjectId: image.id,
    });
    const internal = await enqueueJob(ctx.db, {
      key: "synthetic:entity-wake",
      kind: "image.device.wake",
      input: {},
    });
    const page = await jobRepository.repository.list!(
      kernelCtx(ctx),
      { kind: ["image.device", "image.device.wake"] },
      [],
      { pageIndex: 0, pageSize: 25 },
    );
    expect(page.data.map((row) => row.id)).toEqual([work.shortcode]);
    expect(page.data[0]).toMatchObject({
      lane: "apple_device",
      imageId: image.shortcode,
      displayImages: [{ id: image.shortcode }],
    });
    expect(page.data[0]?.runName).toEqual(expect.any(String));
    expect(page.data[0]?.runId).toMatch(/^RUN-/);
    expect(
      await jobRepository.repository.get!(
        kernelCtx(ctx),
        jobShortcode.parse(work.shortcode),
      ),
    ).toMatchObject({ id: work.shortcode, runName: page.data[0]?.runName });
    const full = await jobRepository.repository.list!(
      kernelCtx(ctx),
      { kind: ["image.device", "image.device.wake"], includeInternal: true },
      [],
      { pageIndex: 0, pageSize: 25 },
    );
    expect(full.data.map((row) => row.id)).toEqual(
      expect.arrayContaining([work.shortcode, internal.shortcode]),
    );
    const backingOff = await enqueueJob(ctx.db, {
      key: "synthetic:entity-backoff",
      kind: "image.device",
      input: {},
      availableAt: new Date(Date.now() + 60_000),
    });
    const other = await enqueueJob(ctx.db, {
      key: "synthetic:entity-other",
      kind: "image.cloud",
      input: {},
      availableAt: new Date(Date.now() + 60_000),
    });
    expect(
      await retryJobSet(
        ctx.db,
        { entityFilters: { lane: ["apple_device"], reason: ["backing_off"] } },
        null,
      ),
    ).toEqual([backingOff.id]);
    const [retained] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.id, other.id));
    expect(retained?.availableAt.getTime()).toBeGreaterThan(Date.now());
  });
  it("keeps attention and internal-kind filters scoped to the requested population", async () => {
    const failed = await enqueueJob(ctx.db, {
      key: "synthetic:attention",
      kind: "synthetic.attention",
      input: {},
    });
    // Infinite maintenance retries cannot stay failed; use an exhaustible internal kind.
    const internal = await enqueueJob(ctx.db, {
      key: "synthetic:internal-attention",
      kind: "ai-refresh.activate",
      input: {},
    });
    for (const row of [failed, internal])
      await getDb(ctx.db)
        .update(job)
        .set({ state: "failed" })
        .where(eq(job.id, row.id));
    expect(
      await getDb(ctx.db)
        .select({ state: job.state, kind: job.kind })
        .from(job)
        .where(eq(job.id, internal.id)),
    ).toEqual([{ state: "failed", kind: "ai-refresh.activate" }]);
    const read = (includeInternal: boolean) =>
      jobRepository.repository.list!(
        kernelCtx(ctx),
        { needsAttention: true, includeInternal },
        [],
        { pageIndex: 0, pageSize: 25 },
      );
    expect((await read(false)).data.map((row) => row.id)).toEqual([
      failed.shortcode,
    ]);
    expect((await read(true)).data.map((row) => row.id)).toEqual(
      expect.arrayContaining([failed.shortcode, internal.shortcode]),
    );
    const outside = await jobRepository.repository.list!(
      kernelCtx(ctx),
      { needsAttention: true, kind: ["synthetic.absent"] },
      [],
      { pageIndex: 0, pageSize: 25 },
    );
    expect(outside.data).toEqual([]);
    expect(
      await retryJobSet(
        ctx.db,
        { entityFilters: { includeInternal: true, needsAttention: true } },
        null,
      ),
    ).toEqual(expect.arrayContaining([failed.id, internal.id]));
  });
  it("intersects mixed retry restrictions and leaves unrelated Jobs untouched", async () => {
    const owner = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      execution: false,
    });
    const future = new Date(Date.now() + 60_000);
    const selected = await enqueueJob(ctx.db, {
      key: "synthetic:mixed-selected",
      kind: "synthetic.selected",
      runId: owner,
      input: {},
      availableAt: future,
    });
    const other = await enqueueJob(ctx.db, {
      key: "synthetic:mixed-other",
      kind: "synthetic.other",
      input: {},
      availableAt: future,
    });
    expect(
      await retryJobSet(
        ctx.db,
        { entityFilters: {}, ids: [selected.id] },
        null,
      ),
    ).toEqual([selected.id]);
    expect(
      (await getDb(ctx.db).select().from(job).where(eq(job.id, other.id)))[0]
        ?.availableAt,
    ).toEqual(future);
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: future })
      .where(eq(job.id, selected.id));
    const exclusions: JobSetFilter[] = [
      { states: ["failed"] },
      { lanes: ["apple_device"] },
      { kinds: ["synthetic.absent"] },
      { reasons: ["due"] },
      { needsAttention: true },
    ];
    for (const filter of exclusions) {
      expect(
        await retryJobSet(
          ctx.db,
          { entityFilters: {}, ids: [selected.id], ...filter },
          null,
        ),
      ).toEqual([]);
    }
    expect(
      await retryJobSet(ctx.db, { entityFilters: {}, ids: [other.id] }, owner),
    ).toEqual([]);
    await getDb(ctx.db)
      .update(job)
      .set({ attempts: 5 })
      .where(eq(job.id, selected.id));
    expect(
      await retryJobSet(
        ctx.db,
        { entityFilters: {}, needsAttention: false },
        owner,
      ),
    ).toEqual([]);
    expect(await retryJobSet(ctx.db, { entityFilters: {} }, owner)).toEqual([
      selected.id,
    ]);
    expect(
      (await getDb(ctx.db).select().from(job).where(eq(job.id, other.id)))[0]
        ?.availableAt,
    ).toEqual(future);
  });

  it("keeps internal-only work out of navigable counts", async () => {
    await enqueueJob(ctx.db, {
      key: "synthetic:internal-only",
      kind: "ai-refresh.activate",
      input: {},
    });
    const queue = await readJobQueue(ctx.db, {
      filter: { entityFilters: {} },
      runId: null,
      pageIndex: 0,
      pageSize: 1,
    });
    const rows = await jobRepository.repository.list!(kernelCtx(ctx), {}, [], {
      pageIndex: 0,
      pageSize: 25,
    });
    expect(queue).toMatchObject({ total: 0, counts: [], jobs: [] });
    expect(rows.data).toEqual([]);
  });
});
