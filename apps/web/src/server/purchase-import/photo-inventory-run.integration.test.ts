import {
  imageId as parseImageId,
  importRunShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import { imageProcessingJob } from "~/server/db/image-processing-schema";
import { image, importRun, importRunTarget } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { productionPhotoImportCommitPorts } from "~/server/services/photo-import-commit.service";

import {
  finalizePhotoImportRun,
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
    return { ...run, publicId: importRunShortcode.parse(run.publicId) };
  };

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

    const result = await finalizePhotoImportRun(
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
        state: importRunTarget.state,
        position: importRunTarget.position,
        targetFingerprint: importRunTarget.targetFingerprint,
      })
      .from(importRunTarget)
      .where(eq(importRunTarget.imageId, parseImageId.parse(staged.id)));
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

    const first = await finalizePhotoImportRun(
      ctx.db,
      input,
      ctx.actor,
      pendingImagePorts(sha256, 16),
    );
    expect(first.finalized).toEqual([staged.shortcode]);

    const replay = await finalizePhotoImportRun(
      ctx.db,
      input,
      ctx.actor,
      pendingImagePorts(sha256, 16),
    );
    expect(replay.finalized).toEqual([]);
    expect(replay.alreadyFinalized).toEqual([staged.shortcode]);

    const targets = await getDb(ctx.db)
      .select({ id: importRunTarget.id })
      .from(importRunTarget)
      .where(eq(importRunTarget.imageId, parseImageId.parse(staged.id)));
    expect(targets).toHaveLength(1);
  });

  it("refuses a completed run", async () => {
    const run = await startRun();
    await getDb(ctx.db)
      .update(importRun)
      .set({ status: "completed" })
      .where(eq(importRun.shortcode, run.publicId));

    await expect(
      finalizePhotoImportRun(
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
    const otherRun = await insertWithShortcode(ctx.db, "importRun", {
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
      finalizePhotoImportRun(
        ctx.db,
        {
          runId: importRunShortcode.parse(otherRun.shortcode),
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
