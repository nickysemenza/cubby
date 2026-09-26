import {
  imageId as parseImageId,
  runEntityId as parseRunId,
  runShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { imageProcessingJob } from "~/server/db/image-processing-schema";
import { aiUsage, image, run as runTable, runTarget } from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { callMcpTool } from "~/server/mcp/mcp-test-utils";
import { registerPhotoImportTools } from "~/server/mcp/tools/photo-import.tools";
import { getDb } from "~/server/repo/database-helpers";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { getRunByShortcode } from "~/server/repo/run";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { productionPhotoImportCommitPorts } from "~/server/services/photo-import-commit.service";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  controlRun,
  finalizePhotoRun,
  loadRunDetail,
  startPhotoInventoryCoordinator,
  startPhotoInventoryRun,
} from "./run-service";

describe("photo import finalize", () => {
  const ctx = withTestDb();

  beforeEach(async () => {
    // A finalized image is immediately UPLOADED and processing-eligible; keep
    // the shared wakeup queue from actually leasing and running a job inline
    // during the test.
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: true,
    });
  });

  const createMember = () =>
    insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Finalize test member",
      kind: "member",
      userId: ctx.actor.userId,
    });

  const startRun = async () => {
    await createMember();
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    return { ...run, publicId: runShortcode.parse(run.publicId) };
  };

  it("gives the agent a bounded run and owner read through MCP", async () => {
    const run = await startRun();
    const server = new McpServer({ name: "photo-test", version: "1.0.0" });
    registerPhotoImportTools(server);
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const response = await callMcpTool(
      server,
      "get_photo_run_context",
      { runId: run.publicId },
      {},
      { entityKernel },
    );

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      runId: run.publicId,
      images: [],
      ledgerPartyId: expect.stringMatching(/^LPY-/),
    });
  });

  // Every page stays in the coordinator's context for the rest of the run, so
  // a large run must be readable in bounded pages without URLs or timings.
  it("pages the agent's photo context in shot order", async () => {
    const run = await startRun();
    for (const position of [0, 1, 2]) {
      const photo = await createImageFixture(ctx.db, `page-${position}`, {
        status: "UPLOADED",
        sha256: String(position).repeat(64),
      });
      await getDb(ctx.db)
        .insert(runTarget)
        .values({
          runId: run.id,
          imageId: parseImageId.parse(photo.id),
          position,
          state: "pending",
          targetFingerprint: String(position).repeat(64),
        });
    }
    const server = new McpServer({ name: "photo-test", version: "1.0.0" });
    registerPhotoImportTools(server);
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const page = async (cursor: number) => {
      const response = await callMcpTool(
        server,
        "get_photo_run_context",
        { runId: run.publicId, limit: 2, cursor },
        {},
        { entityKernel },
      );
      expect(response.isError).not.toBe(true);
      return z
        .object({
          totalImages: z.number(),
          nextCursor: z.number().nullable(),
          images: z.array(z.looseObject({ position: z.number().nullable() })),
        })
        .parse(response.structuredContent);
    };

    const first = await page(0);
    expect(first).toMatchObject({ totalImages: 3, nextCursor: 2 });
    expect(first.images.map((image) => image.position)).toEqual([0, 1]);
    expect(Object.keys(first.images[0] ?? {}).sort()).toEqual([
      "describe",
      "description",
      "id",
      "position",
      "recognizedText",
      "targetState",
    ]);
    const last = await page(2);
    expect(last).toMatchObject({ totalImages: 3, nextCursor: null });
    expect(last.images.map((image) => image.position)).toEqual([2]);
  });

  /** Bytes/hash never touch real R2 — the same seam the commit integration
   * test uses to keep `verifyStagedImages`'s PENDING branch offline. */
  const pendingImagePorts = (sha256: string, size: number) => ({
    ...productionPhotoImportCommitPorts,
    getObject: async () => new Response(new Uint8Array(size)),
    inspect: async () => ({
      contentType: "image/png",
      width: 16,
      height: 16,
      detectedContentType: "image/png",
      sha256,
      renderStatus: "verified" as const,
      storageStatus: "available" as const,
      verifiedAt: new Date(),
    }),
  });

  it("starts grouping only after a photo is finalized", async () => {
    const run = await startRun();
    await expect(
      startPhotoInventoryCoordinator(ctx.db, {
        publicId: run.publicId,
        actorUserId: ctx.actor.userId,
      }),
    ).rejects.toThrow("Upload and finalize photos");
  });

  it("starts a fresh run with the same photo inputs and independent pending targets", async () => {
    const original = await startRun();
    const photo = await createImageFixture(ctx.db, "replay-input", {
      status: "UPLOADED",
      sha256: "e".repeat(64),
    });
    await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: original.id,
        imageId: parseImageId.parse(photo.id),
        position: 0,
        state: "completed",
        targetFingerprint: "e".repeat(64),
      });
    await getDb(ctx.db)
      .update(runTable)
      .set({
        status: "completed",
        startedAt: new Date("2026-09-20T08:00:00.000Z"),
        endedAt: new Date("2026-09-20T14:38:55.500Z"),
      })
      .where(eq(runTable.id, original.id));
    expect((await getRunByShortcode(ctx.db, original.publicId))?.wallTime).toBe(
      "6h 39m",
    );
    await getDb(ctx.db).insert(aiUsage).values({
      runId: original.id,
      feature: "purchase_import_agent",
      provider: "fixture",
      model: "fixture-model",
      operation: "flue.photo_inventory",
      durationMs: 3_200,
    });
    expect((await loadRunDetail(ctx.db, original.publicId)).agentModelMs).toBe(
      3_200,
    );

    const restarted = await controlRun(ctx.db, ctx.actor, {
      runPublicId: original.publicId,
      action: "restart",
    });
    expect(restarted).toMatchObject({
      created: true,
      dispatchPurpose: "photo_inventory",
    });
    if (!("successorRunId" in restarted)) throw new Error("Missing new run");
    const [newRun] = await getDb(ctx.db)
      .select({
        predecessorRunId: runTable.predecessorRunId,
        dispatchEventId: runTable.dispatchEventId,
      })
      .from(runTable)
      .where(eq(runTable.id, parseRunId.parse(restarted.successorRunId)));
    expect(newRun?.predecessorRunId).toBe(original.id);
    expect(newRun?.dispatchEventId).toBeTruthy();
    const targets = await getDb(ctx.db)
      .select({
        runId: runTarget.runId,
        imageId: runTarget.imageId,
        state: runTarget.state,
      })
      .from(runTarget)
      .where(eq(runTarget.imageId, parseImageId.parse(photo.id)));
    expect(targets).toEqual(
      expect.arrayContaining([
        { runId: original.id, imageId: photo.id, state: "completed" },
        {
          runId: restarted.successorRunId,
          imageId: photo.id,
          state: "pending",
        },
      ]),
    );
  });

  it("finalizes a staged image: creates a target, activates it, and schedules processing", async () => {
    const run = await startRun();
    const sha256 = "a".repeat(64);
    const staged = await createImageFixture(ctx.db, "wardrobe-photo-1", {
      status: "PENDING",
      size: 16,
      sha256,
      width: 16,
      height: 16,
      renderStatus: null,
      storageStatus: "unverified",
      verifiedAt: new Date(),
    });

    const result = await finalizePhotoRun(
      ctx.db,
      {
        runId: run.publicId,
        images: [
          {
            imageId: staged.shortcode,
            position: 0,
            sha256,
            width: 16,
            height: 16,
          },
        ],
      },
      ctx.actor,
      pendingImagePorts(sha256, 16),
    );

    expect(result.finalized).toEqual([staged.shortcode]);
    expect(result.alreadyFinalized).toEqual([]);
    // A real submission id, not merely "some string" — production values
    // are minted as `'IPS-' || <hex uuid>`.
    expect(result.submissionId).toMatch(/^IPS-/);

    const [imageRow] = await getDb(ctx.db)
      .select({ status: image.status, source: image.source })
      .from(image)
      .where(eq(image.id, staged.id));
    // Activation flips PENDING -> UPLOADED; `source` was "unknown" (the
    // fixture default) and finalize claims it for the household.
    expect(imageRow).toEqual({ status: "UPLOADED", source: "own" });

    const targets = await getDb(ctx.db)
      .select({
        state: runTarget.state,
        position: runTarget.position,
        targetFingerprint: runTarget.targetFingerprint,
      })
      .from(runTarget)
      .where(eq(runTarget.imageId, parseImageId.parse(staged.id)));
    expect(targets).toEqual([
      { state: "pending", position: 0, targetFingerprint: sha256 },
    ]);

    const jobs = await getDb(ctx.db)
      .select({ kind: imageProcessingJob.kind })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.imageId, parseImageId.parse(staged.id)));
    expect(jobs.map((job) => job.kind).sort()).toEqual([
      "describe_image",
      "subject_lift",
    ]);
  });

  it("replays the same chunk as a no-op: alreadyFinalized, no duplicate target", async () => {
    const run = await startRun();
    const sha256 = "b".repeat(64);
    const staged = await createImageFixture(ctx.db, "wardrobe-photo-2", {
      status: "PENDING",
      size: 16,
      sha256,
      width: 16,
      height: 16,
      renderStatus: null,
      storageStatus: "unverified",
      verifiedAt: new Date(),
    });
    const input = {
      runId: run.publicId,
      images: [
        {
          imageId: staged.shortcode,
          position: 0,
          sha256,
          width: 16,
          height: 16,
        },
      ],
    };

    const first = await finalizePhotoRun(
      ctx.db,
      input,
      ctx.actor,
      pendingImagePorts(sha256, 16),
    );
    expect(first.finalized).toEqual([staged.shortcode]);

    const replay = await finalizePhotoRun(
      ctx.db,
      input,
      ctx.actor,
      pendingImagePorts(sha256, 16),
    );
    expect(replay.finalized).toEqual([]);
    expect(replay.alreadyFinalized).toEqual([staged.shortcode]);

    const targets = await getDb(ctx.db)
      .select({ id: runTarget.id })
      .from(runTarget)
      .where(eq(runTarget.imageId, parseImageId.parse(staged.id)));
    expect(targets).toHaveLength(1);
  });

  it("refuses a completed run", async () => {
    const run = await startRun();
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "completed" })
      .where(eq(runTable.shortcode, run.publicId));

    await expect(
      finalizePhotoRun(
        ctx.db,
        {
          runId: run.publicId,
          images: [
            {
              imageId: parseShortcodeFor("image", "IMG-4K7M"),
              position: 0,
              sha256: "c".repeat(64),
              width: 1,
              height: 1,
            },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("fenced in status completed");
  });

  it("refuses a non-photo-inventory run", async () => {
    const party = await createMember();
    const otherRun = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Finalize test actor",
      actorEmail: "finalize-test-actor@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      trigger: "manual",
      agentSessionId: "finalize-test-non-photo-run",
    });

    await expect(
      finalizePhotoRun(
        ctx.db,
        {
          runId: runShortcode.parse(otherRun.shortcode),
          images: [
            {
              imageId: parseShortcodeFor("image", "IMG-4K7M"),
              position: 0,
              sha256: "d".repeat(64),
              width: 1,
              height: 1,
            },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("not a photo-inventory run");
  });
});
