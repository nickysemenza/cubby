import { imageId, type RunId } from "@cubby/schemas/identifiers";
import { runStepDeclaration } from "@cubby/schemas/run-fields";
import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { image, imageProcessingJob, job, run } from "~/server/db/schema";
import {
  countImagesStaleMetadata,
  createUploadedImageRecord,
  getImageMetadataExtractionRow,
} from "~/server/domains/image/repo/image";
import { applyImageMetadataExtraction } from "~/server/domains/image/repo/image-metadata";
import { extractImageMetadata } from "~/server/domains/image/service/image-metadata";
import type { ExtractImageMetadataPorts } from "~/server/domains/image/service/image-metadata-extraction.service";
import { readRunSteps } from "~/server/domains/run/repo/run-step";
import {
  advanceStepRun as advanceStepRunImplementation,
  retryRunStep,
  type StepPlan,
} from "~/server/domains/run/service/step-run";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  withJobFixtureExecution,
  captureBackgroundQueue,
} from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  maintenanceStepDrivers,
  type MaintenancePorts,
} from "./maintenance-run";
import { launchMaintenanceRun } from "./maintenance.service";

const advanceStepRun = (
  ...args: Parameters<typeof advanceStepRunImplementation>
) =>
  withJobFixtureExecution(
    args[0],
    {
      key: `run:${args[1].runId}`,
      kind: "run.execute",
      input: { runId: args[1].runId, purpose: "maintenance" },
      runId: args[1].runId,
    },
    () => advanceStepRunImplementation(...args),
  );

/** A JPEG with no APP1 segment: extraction succeeds with no metadata. */
const BARE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

/** Storage stand-in keyed by object key: bytes, a 404, or a thrown read. */
function storage(objects: Map<string, Uint8Array | null | Error>) {
  const reads: string[] = [];
  const ports: ExtractImageMetadataPorts = {
    getRow: getImageMetadataExtractionRow,
    getBytes: async (key) => {
      reads.push(key);
      const object = objects.get(key);
      if (object instanceof Error) throw object;
      return object === undefined ? BARE_JPEG : object;
    },
    extract: extractImageMetadata,
    apply: applyImageMetadataExtraction,
  };
  return { ports, reads };
}

describe("maintenance Run", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => {
    queue.restore();
  });

  const attemptOf = async (id: RunId) =>
    z
      .object({ attempt: z.number() })
      .parse(
        (await getDb(ctx.db).select().from(run).where(eq(run.id, id)))[0]
          ?.progress,
      ).attempt;

  const readRun = async (id: RunId) =>
    (await getDb(ctx.db).select().from(run).where(eq(run.id, id)))[0];

  const runIdOf = async (shortcode: string) => {
    const [row] = await getDb(ctx.db)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.shortcode, shortcode));
    if (!row) throw new Error(`No Run ${shortcode}`);
    return row.id;
  };

  async function startPass() {
    const launched = await launchMaintenanceRun(ctx.db, ctx.actor, "manual");
    return runIdOf(launched.runId);
  }

  async function drive(id: RunId, drivers: StepPlan, limit = 30) {
    const params = { runId: id, attempt: await attemptOf(id) };
    const kinds: string[] = [];
    for (let page = 0; page < limit; page++) {
      const advance = await advanceStepRun(ctx.db, params, drivers);
      kinds.push(advance.kind);
      if (advance.kind !== "continue") break;
    }
    return kinds;
  }

  const only = (
    key: keyof ReturnType<typeof maintenanceStepDrivers>,
    ports: MaintenancePorts,
  ): StepPlan => [
    {
      declaration: runStepDeclaration("maintenance", key)!,
      driver: maintenanceStepDrivers(ports)[key],
    },
  ];

  const seedImage = async (name: string, sha256?: string) => {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/maintenance/${name}-${crypto.randomUUID()}.jpg`,
      filename: `${name}.jpg`,
      contentType: "image/jpeg",
      size: 512,
    });
    if (sha256)
      await getDb(ctx.db)
        .update(image)
        .set({ sha256 })
        .where(eq(image.id, row.id));
    return { id: imageId.parse(row.id), key: row.key };
  };

  const imageRow = async (id: string) =>
    (
      await getDb(ctx.db)
        .select()
        .from(image)
        .where(eq(image.id, imageId.parse(id)))
    )[0];

  it("gives an EXIF 404 a terminal outcome so the next row proceeds", async () => {
    const missing = await seedImage("missing");
    const present = await seedImage("present");
    const { ports } = storage(new Map([[missing.key, null]]));
    const id = await startPass();

    await drive(id, only("exif", { metadata: ports, pageSize: { exif: 1 } }));

    expect(await imageRow(missing.id)).toMatchObject({
      metadataOutcome: "original_missing",
      metadataError: `R2 object not found: ${missing.key} (404)`,
      metadataRevision: null,
    });
    expect((await imageRow(present.id))?.metadataRevision).not.toBeNull();
    expect(await countImagesStaleMetadata(ctx.db)).toBe(0);
    const [step] = await readRunSteps(ctx.db, id);
    expect(step).toMatchObject({
      state: "failed",
      done: 1,
      failed: 1,
      left: 0,
    });
    expect(step?.errors).toEqual([
      expect.objectContaining({
        message: `R2 object not found: ${missing.key} (404)`,
        ref: `image:${missing.id}`,
      }),
    ]);
    expect(await readRun(id)).toMatchObject({ status: "needs_review" });
  });

  // Documents of records removed before their derived triggers existed get
  // no mark; the daily step retires them (the retired refresh pass did).
  it("retires search documents whose record no longer exists", async () => {
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic orphaned search item" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", item.entityId);
    await getDb(ctx.db).execute(sql`
      UPDATE "Product" SET "deletedAt" = now() WHERE id = ${item.entityId}::uuid`);
    await getDb(ctx.db).execute(sql`
      UPDATE "Entity" SET "deletedAt" = now() WHERE id = ${item.entityId}::uuid`);
    // As if the removal predated the triggers: nothing is marked.
    await getDb(ctx.db).execute(sql`DELETE FROM "WorkItem"`);
    const id = await startPass();
    await drive(id, only("derived-refresh", {}));
    const [document] = (
      await getDb(ctx.db).execute(sql`
        SELECT "deletedAt" IS NOT NULL AS retired FROM "SearchDocument"
         WHERE "entityId" = ${item.entityId}::uuid`)
    ).rows;
    expect(document).toEqual({ retired: true });
  });

  it("returns the active pass instead of starting a second one", async () => {
    const first = await launchMaintenanceRun(ctx.db, ctx.actor, "manual");
    const [again, concurrent] = await Promise.all([
      launchMaintenanceRun(ctx.db, ctx.actor, "scheduled"),
      launchMaintenanceRun(ctx.db, ctx.actor, "manual"),
    ]);
    expect(first.existing).toBe(false);
    expect(again).toEqual({ runId: first.runId, existing: true });
    expect(concurrent).toEqual({ runId: first.runId, existing: true });
    const passes = await getDb(ctx.db)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.purpose, "maintenance"));
    expect(passes).toHaveLength(1);
  });

  // Image provider capacity belongs to child Jobs; the maintenance pass only
  // admits bounded pages, so it cannot retain a second paid-work scheduler.
  it("admits image work in bounded pages without waiting for provider execution", async () => {
    for (const [index, name] of ["one", "two", "three"].entries())
      await seedImage(name, String(index + 1).repeat(64));
    const id = await startPass();
    await drive(id, only("image-backfill", { pageSize: { imageBackfill: 2 } }));
    const payloads = await getDb(ctx.db).select().from(imageProcessingJob);
    expect(payloads.length).toBeGreaterThanOrEqual(3);
    expect(payloads.every((payload) => payload.attemptId === null)).toBe(true);
    const admitted = await getDb(ctx.db)
      .select()
      .from(job)
      .where(inArray(job.kind, ["image.cloud", "image.device"]));
    expect(admitted).toHaveLength(payloads.length);
    expect(admitted.every((execution) => execution.state === "queued")).toBe(
      true,
    );
    expect(await readRun(id)).toMatchObject({ status: "completed" });
    expect((await readRunSteps(ctx.db, id))[0]).toMatchObject({
      state: "done",
      done: 3,
      failed: 0,
      left: null,
    });
  });

  it("retries only the failed EXIF refs a step recorded", async () => {
    const missing = await seedImage("retry-missing");
    const broken = await seedImage("retry-broken");
    const fine = await seedImage("retry-fine");
    const objects = new Map<string, Uint8Array | null | Error>([
      [missing.key, null],
      [broken.key, new Error("R2 read failed: 503 Service Unavailable")],
    ]);
    const { ports, reads } = storage(objects);
    const id = await startPass();
    const drivers = only("exif", { metadata: ports });
    await drive(id, drivers);

    expect(await imageRow(broken.id)).toMatchObject({
      metadataOutcome: "extraction_failed",
    });
    expect((await imageRow(broken.id))?.metadataError).toContain(
      "R2 read failed: 503 Service Unavailable",
    );
    // Bounded: three attempts, then terminal.
    expect(reads.filter((key) => key === broken.key)).toHaveLength(3);
    expect((await readRunSteps(ctx.db, id))[0]).toMatchObject({
      state: "failed",
      done: 1,
      failed: 2,
    });

    // A new upload after the pass is not part of this step's retry.
    const later = await seedImage("retry-later");
    objects.clear();
    reads.length = 0;
    await retryRunStep(ctx.db, id, "exif");
    await drive(id, drivers);

    expect([...reads].sort()).toEqual([missing.key, broken.key].sort());
    for (const repaired of [missing, broken])
      expect(await imageRow(repaired.id)).toMatchObject({
        metadataOutcome: null,
        metadataError: null,
      });
    expect((await imageRow(fine.id))?.metadataRevision).not.toBeNull();
    expect((await imageRow(later.id))?.metadataRevision).toBeNull();
    const [step] = await readRunSteps(ctx.db, id);
    expect(step).toMatchObject({ state: "done", done: 3, failed: 0 });
    expect(step?.meta?.retryRefs).toEqual([]);
    expect(await readRun(id)).toMatchObject({ status: "completed" });
  });

  // Failure mode (review): a pass parked on the AI budget held the one-active
  // slot, so no nightly pass drained the free backlogs while it waited.
  it("ends a budget-paused pass when the nightly launch starts a fresh one", async () => {
    const first = await launchMaintenanceRun(ctx.db, ctx.actor, "manual");
    const firstId = await resolveOrThrow(ctx.db, "run", first.runId);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused_auth", failureCode: "execution_limit" })
      .where(eq(run.id, firstId));
    // A member's Run now still sees the paused pass.
    expect(await launchMaintenanceRun(ctx.db, ctx.actor, "manual")).toEqual({
      runId: first.runId,
      existing: true,
    });
    const nightly = await launchMaintenanceRun(ctx.db, ctx.actor, "scheduled");
    expect(nightly.existing).toBe(false);
    expect(nightly.runId).not.toBe(first.runId);
    const [ended] = await getDb(ctx.db)
      .select({ status: run.status, failureCode: run.failureCode })
      .from(run)
      .where(eq(run.id, firstId));
    expect(ended).toEqual({
      status: "needs_review",
      failureCode: "superseded_by_next_pass",
    });
  });
});
