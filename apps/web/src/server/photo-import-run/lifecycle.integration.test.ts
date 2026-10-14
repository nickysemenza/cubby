import { buildActorContext } from "@cubby/schemas/context";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  storedPhotoRunInput,
  type PhotoInventoryRunInput,
} from "@cubby/schemas/photo-import-run";
import { generateShortcode } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  image,
  imageProcessingJob,
  ledgerParty,
  photoGroupProposal,
  photoRunImage,
  run as runTable,
  runPushRegistration,
} from "~/server/db/schema";
import { retireSettledCoordinators } from "~/server/purchase-import/run-retirement";
import {
  finalizePhotoRun,
  startGuardedPhotoCoordinator,
  startPhotoInventoryRun,
} from "~/server/purchase-import/run-service";
import { getDb } from "~/server/repo/database-helpers";
import { IMAGE_DESCRIPTION_PROCESSOR_REVISION } from "~/server/repo/image-processing";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { productionPhotoImportCommitPorts } from "~/server/services/photo-import-commit.service";

import { startPhotoGroupingForActor } from "./grouping";
import {
  admitPhotoRunBatch,
  advancePhotoRun,
  EXCLUDED_FAILED_DESCRIPTION_REASON,
  excludeFailedPhotoRunImages,
  readPhotoRunLifecycle,
  sealPhotoRunBatch,
  setPhotoRunProcessor,
} from "./lifecycle";
import { listPhotoGroupProposals, proposePhotoGroups } from "./proposals";
import {
  endPhotoRunNotification,
  pushPhotoRunRegistrations,
  registerPhotoRunLiveActivity,
  registerPhotoRunNotification,
  type ApnsTransport,
} from "./run-push";

// Failure modes this file guards (written before the lifecycle):
// 1. Pi groups part of a batch still finalizing in 100-photo chunks.
// 2. A replayed admission inflates the batch count or shifts positions.
// 3. A failed description is grouped as a bare photo, or "continue without"
//    deletes the photo instead of keeping it as a reasoned skip.
// 4. New photos leave stale proposals, erase committed groups, or let the
//    superseded coordinator generation overwrite the regrouped Run.
// 5. An external (Claude/Codex) Run dispatches Pi.
// 6. A replayed createRun opens a second Run.
// 7. A non-initiating device registers, unchanged state is re-pushed, or an
//    APNs error stores the push token.
// 8. A settled coordinator that handed off for review still reads as grouping.
// 9. Readiness judged on one input dispatches Pi after an admission or
//    switch to external changed it.
// 10. A late finalize lands new photos in a sealed batch (or another open
//     batch's id) after grouping could start; a replay must still succeed.
// 11. Reopening a Run stopped for review leaves its photos unresolved.
// 12. A pending photo with no description job (scheduling never ran) lets
//     grouping start.
// 13. A push delivered with an old token ends a freshly registered Activity.
// 14. Opt-in alerts need a Live Activity, repeat within one phase, stop
//     after the first ready phase, mark a replaced token, or keep sending
//     after the member turns them off.
// 15. A fully approved (completed) Run cannot take a new batch, or reopens
//     with its committed work disturbed; a failed Run reopens.
// 16. A Cubby Run whose coordinator was retired accepts a batch it can never
//     group; retirement lands on a Run reopened while being disposed.
// 17. A manual Start grouping on a chosen-processor Run bypasses the
//     description barrier.
// 18. Dispatch passes on a matching input while a description is in flight.
// 19. A registration failure carries the bare push token in its error chain.
// 20. Re-registering the same token, or two overlapping advances, repeat an
//     alert already sent.
// 21. A Run stopped for review with only unresolved photos reads completed.
// 22. A push is addressed to a topic its registering app build does not own
//     (Mac Debug's `.dev` bundle), or a development build gets a Live
//     Activity it has no extension for.
// 23. A late response for an old app identity or APNs environment ends or
//     overwrites a corrected same-token registration.
// 24. A previous batch's late APNs refusal ends a new batch's subscription.

describe("photo run lifecycle", () => {
  const ctx = withTestDb();

  const seedRun = async (input: {
    processor: "cubby" | "external";
    open?: boolean;
    images?: number;
    describe?: "pending" | "failed" | "ready" | "none";
    generation?: boolean;
  }) => {
    // One member party per login; a test seeding two Runs reuses it.
    const party =
      (await getDb(ctx.db).query.ledgerParty.findFirst({
        where: and(
          eq(ledgerParty.userId, ctx.actor.userId),
          eq(ledgerParty.kind, "member"),
        ),
      })) ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Lifecycle Member",
        kind: "member" as const,
        userId: ctx.actor.userId,
      }));
    const id = parseEntityId("run", crypto.randomUUID());
    const runInput: PhotoInventoryRunInput = {
      kind: "photo_inventory",
      processor: input.processor,
      batches: [
        {
          clientBatchId: crypto.randomUUID(),
          imageCount: input.images ?? 2,
          positionOffset: 0,
          state: input.open ? "open" : "sealed",
        },
      ],
    };
    const [run] = await getDb(ctx.db)
      .insert(runTable)
      .values({
        id,
        shortcode: generateShortcode("run"),
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Lifecycle Tester",
        actorEmail: "test@example.com",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
        agentSessionId: `photo-lifecycle-test:${id}`,
        dispatchEventId: input.generation ? crypto.randomUUID() : null,
        coordinatorStartedAt: input.generation ? new Date() : null,
        purpose: "photo_inventory",
        trigger: "manual",
        status: "running",
        input: runInput,
      })
      .returning();
    if (!run) throw new Error("fixture: run not created");
    const images = await Promise.all(
      Array.from({ length: input.images ?? 2 }, (_, index) =>
        createImageFixture(ctx.db, `lifecycle-${crypto.randomUUID()}-${index}`),
      ),
    );
    await getDb(ctx.db)
      .insert(photoRunImage)
      .values(
        images.map((entry, index) => ({
          runId: run.id,
          imageId: parseEntityId("image", entry.id),
          position: index,
          state: "pending" as const,
          targetFingerprint: `fixture-${crypto.randomUUID()}`,
        })),
      );
    // A chosen-processor Run requires a description job per photo; "none"
    // models a finalize whose scheduling never ran.
    const describe = input.describe ?? "ready";
    if (describe !== "none")
      for (const entry of images) {
        // `createImageFixture` leaves the hash null; a description job is
        // current only for its Image's hash, so give each a synthetic one.
        const sha256 = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
        await getDb(ctx.db)
          .update(image)
          .set({ sha256 })
          .where(eq(image.id, parseEntityId("image", entry.id)));
        await getDb(ctx.db)
          .insert(imageProcessingJob)
          .values({
            imageId: parseEntityId("image", entry.id),
            kind: "describe_image",
            state: describe,
            sourceContentHash: sha256,
            processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
            runId: run.id,
            lastError: describe === "failed" ? "synthetic failure" : null,
          });
      }
    return {
      run,
      batch: runInput.batches[0]!,
      codes: images.map((entry) => parseShortcodeFor("image", entry.shortcode)),
    };
  };

  const readRun = async (id: string) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, parseEntityId("run", id)));
    return row!;
  };

  it("never dispatches while an admitted batch is open, then tries once it is sealed", async () => {
    const { run, batch } = await seedRun({ processor: "cubby", open: true });
    const waiting = await advancePhotoRun(ctx.db, run.shortcode);
    expect(waiting.phase).toBe("waiting_for_upload");
    expect((await readRun(run.id)).dispatchError).toBeNull();

    const sealed = await sealPhotoRunBatch(ctx.db, {
      runId: run.shortcode,
      clientBatchId: batch.clientBatchId,
    });
    // The test host has no agent grant, so the attempted dispatch is
    // recorded verbatim and the member is asked to act.
    expect(sealed.lifecycle.phase).toBe("needs_attention");
    expect((await readRun(run.id)).dispatchError).toMatch(
      /Connect the Cubby agent/,
    );
  });

  it("replays an admission without inflating the plan or moving positions", async () => {
    const { run } = await seedRun({ processor: "external", images: 3 });
    const clientBatchId = crypto.randomUUID();
    const first = await admitPhotoRunBatch(ctx.db, {
      runId: run.shortcode,
      clientBatchId,
      imageCount: 4,
    });
    const replay = await admitPhotoRunBatch(ctx.db, {
      runId: run.shortcode,
      clientBatchId,
      imageCount: 4,
    });
    expect(first.positionOffset).toBe(3);
    expect(replay.positionOffset).toBe(3);
    expect(replay.lifecycle.plannedImageCount).toBe(7);
    expect(replay.lifecycle.openBatchCount).toBe(1);
  });

  it("holds failed descriptions for the member and keeps excluded photos as reasoned skips", async () => {
    const pending = await seedRun({ processor: "cubby", describe: "pending" });
    expect(
      (await readPhotoRunLifecycle(ctx.db, pending.run.shortcode)).phase,
    ).toBe("describing");

    const { run, codes } = await seedRun({
      processor: "cubby",
      describe: "failed",
    });
    const blocked = await advancePhotoRun(ctx.db, run.shortcode);
    expect(blocked.phase).toBe("needs_attention");
    expect(blocked.failedImageIds).toEqual(expect.arrayContaining(codes));
    expect((await readRun(run.id)).dispatchEventId).toBeNull();

    await excludeFailedPhotoRunImages(ctx.db, {
      runId: run.shortcode,
      imageIds: codes,
    });
    const targets = await getDb(ctx.db)
      .select({
        state: photoRunImage.state,
        skipReason: photoRunImage.skipReason,
        imageId: photoRunImage.imageId,
      })
      .from(photoRunImage)
      .where(eq(photoRunImage.runId, run.id));
    expect(targets.map((target) => target.state)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(
      targets.every(
        (target) => target.skipReason === EXCLUDED_FAILED_DESCRIPTION_REASON,
      ),
    ).toBe(true);
    const kept = await getDb(ctx.db)
      .select({ deletedAt: image.deletedAt })
      .from(image)
      .where(eq(image.id, targets[0]!.imageId));
    expect(kept[0]?.deletedAt).toBeNull();
  });

  it("regroups unapproved photos on a new batch, keeps committed groups, and fences the old coordinator", async () => {
    const { run, codes } = await seedRun({
      processor: "cubby",
      images: 2,
      generation: true,
    });
    await proposePhotoGroups(
      ctx.db,
      {
        runId: run.shortcode,
        groups: [
          {
            groupKey: "stale",
            images: [{ id: codes[0]!, purpose: "item" }],
            product: {
              kind: "create",
              create: { name: "Synthetic Stale Item" },
            },
          },
        ],
      },
      "coordinator",
      run.dispatchEventId!,
    );
    await getDb(ctx.db)
      .insert(photoGroupProposal)
      .values({
        runId: run.id,
        groupKey: "approved",
        state: "committed",
        productKind: "create",
        productCreate: { name: "Synthetic Approved Item" },
        committedAt: new Date(),
      });

    await admitPhotoRunBatch(ctx.db, {
      runId: run.shortcode,
      clientBatchId: crypto.randomUUID(),
      imageCount: 1,
    });

    const keys = (
      await listPhotoGroupProposals(ctx.db, run.shortcode)
    ).proposals.map((group) => [group.groupKey, group.state]);
    expect(keys).toEqual([["approved", "committed"]]);
    expect((await readRun(run.id)).dispatchEventId).toBeNull();

    const stale = {
      runId: run.shortcode,
      groups: [
        {
          groupKey: "late",
          images: [{ id: codes[1]!, purpose: "item" as const }],
          product: {
            kind: "create" as const,
            create: { name: "Synthetic Late Item" },
          },
        },
      ],
    };
    const oldGeneration = run.dispatchEventId!;
    await expect(
      proposePhotoGroups(ctx.db, stale, "coordinator", oldGeneration),
    ).rejects.toThrow(/generation is no longer active/);
    // Unsigned coordinator calls are refused outright.
    await expect(
      proposePhotoGroups(ctx.db, stale, "coordinator"),
    ).rejects.toThrow(/generation is no longer active/);

    // The next generation is dispatched and acknowledged; the superseded
    // coordinator is still refused while the new one writes.
    const newGeneration = crypto.randomUUID();
    await getDb(ctx.db)
      .update(runTable)
      .set({ dispatchEventId: newGeneration, coordinatorStartedAt: new Date() })
      .where(eq(runTable.id, run.id));
    await expect(
      proposePhotoGroups(ctx.db, stale, "coordinator", oldGeneration),
    ).rejects.toThrow(/generation is no longer active/);
    await proposePhotoGroups(ctx.db, stale, "coordinator", newGeneration);
    const [fresh] = await getDb(ctx.db)
      .select({ origin: photoGroupProposal.origin })
      .from(photoGroupProposal)
      .where(
        and(
          eq(photoGroupProposal.runId, run.id),
          eq(photoGroupProposal.groupKey, "late"),
        ),
      );
    expect(fresh?.origin).toBe("coordinator");

    await proposePhotoGroups(ctx.db, stale, "member");
    const [late] = await getDb(ctx.db)
      .select({ origin: photoGroupProposal.origin })
      .from(photoGroupProposal)
      .where(
        and(
          eq(photoGroupProposal.runId, run.id),
          eq(photoGroupProposal.groupKey, "late"),
        ),
      );
    expect(late?.origin).toBe("member");
  });

  it("never dispatches Pi for an external Run", async () => {
    const { run } = await seedRun({ processor: "external", describe: "ready" });
    const lifecycle = await advancePhotoRun(ctx.db, run.shortcode);
    expect(lifecycle.phase).toBe("ready_for_handoff");
    const row = await readRun(run.id);
    expect(row.dispatchEventId).toBeNull();
    expect(row.dispatchError).toBeNull();
  });

  it("returns the same Run when createRun is replayed with its batch id", async () => {
    const grouping = {
      processor: "cubby" as const,
      clientBatchId: crypto.randomUUID(),
      imageCount: 2,
    };
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Replay Member",
      kind: "member" as const,
      userId: ctx.actor.userId,
    });
    const first = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
      grouping,
    });
    const replay = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
      grouping,
    });
    expect(replay.publicId).toBe(first.publicId);
  });

  it("registers only the initiating install and never stores the push token in an error", async () => {
    const { run } = await seedRun({ processor: "external", describe: "ready" });
    const initiator = await insertWithShortcode(ctx.db, "device", {
      installationId: `lifecycle-${crypto.randomUUID()}`,
      name: "Synthetic Phone",
      platform: "ios",
    });
    const other = await insertWithShortcode(ctx.db, "device", {
      installationId: `lifecycle-${crypto.randomUUID()}`,
      name: "Synthetic Tablet",
      platform: "ios",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ deviceId: initiator.id })
      .where(eq(runTable.id, run.id));
    const pushToken = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const input = {
      runId: parseShortcodeFor("run", run.shortcode),
      pushToken,
      apnsEnvironment: "development" as const,
      appIdentity: "production" as const,
    };
    await expect(
      registerPhotoRunLiveActivity(
        ctx.db,
        buildActorContext(ctx.actor.userId, "web", { deviceId: other.id }),
        input,
      ),
    ).rejects.toThrow(/started on another device/);
    // No APNs credentials on the test host: registration succeeds and the
    // missing configuration is recorded instead of thrown.
    await registerPhotoRunLiveActivity(
      ctx.db,
      buildActorContext(ctx.actor.userId, "web", { deviceId: initiator.id }),
      input,
    );

    const key = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const der = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", key.privateKey),
    );
    const credentials = {
      keyId: "SYNTHKEY01",
      teamId: "SYNTHTEAM1",
      privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`,
    };
    const requests: Parameters<ApnsTransport>[0][] = [];
    let status = 400;
    const transport: ApnsTransport = async (request) => {
      requests.push(request);
      return {
        status,
        reason: status === 200 ? null : `rejected ${request.pushToken}`,
      };
    };
    const lifecycle = await readPhotoRunLifecycle(ctx.db, run.shortcode);
    await pushPhotoRunRegistrations(
      ctx.db,
      run.id,
      run.shortcode,
      lifecycle,
      transport,
      credentials,
    );
    const [failed] = await getDb(ctx.db)
      .select()
      .from(runPushRegistration)
      .where(eq(runPushRegistration.runId, run.id));
    expect(failed?.lastError).toContain("[push-token]");
    expect(failed?.lastError).not.toContain(pushToken);

    status = 200;
    await pushPhotoRunRegistrations(
      ctx.db,
      run.id,
      run.shortcode,
      lifecycle,
      transport,
      credentials,
    );
    await pushPhotoRunRegistrations(
      ctx.db,
      run.id,
      run.shortcode,
      lifecycle,
      transport,
      credentials,
    );
    expect(requests).toHaveLength(2);
    const body = JSON.parse(requests[1]!.body) as {
      aps: { event: string; "content-state": { phase: string } };
    };
    expect(requests[1]!.headers["apns-push-type"]).toBe("liveactivity");
    // Ready for Claude/Codex is a resting state: the Activity ends there.
    expect(body.aps.event).toBe("end");
    expect(body.aps["content-state"].phase).toBe("ready_for_handoff");
    const [ended] = await getDb(ctx.db)
      .select()
      .from(runPushRegistration)
      .where(eq(runPushRegistration.runId, run.id));
    expect(ended?.endedAt).not.toBeNull();
  });

  it("reads a settled coordinator's review handoff as ready for review, not grouping", async () => {
    const { run, codes } = await seedRun({
      processor: "cubby",
      generation: true,
    });
    await proposePhotoGroups(
      ctx.db,
      {
        runId: run.shortcode,
        groups: [
          {
            groupKey: "ready",
            images: [{ id: codes[0]!, purpose: "item" }],
            product: {
              kind: "create",
              create: { name: "Synthetic Ready Item" },
            },
          },
        ],
      },
      "coordinator",
      run.dispatchEventId!,
    );
    expect((await readPhotoRunLifecycle(ctx.db, run.shortcode)).phase).toBe(
      "grouping",
    );
    await getDb(ctx.db)
      .update(runTable)
      .set({
        liveProgress: {
          generation: run.dispatchEventId!,
          sequence: 1,
          eventId: "photo-review-handoff:synthetic",
          phase: "awaiting_approval",
          currentItem: null,
          detail: null,
          awaitingApproval: true,
          createdAt: new Date().toISOString(),
        },
      })
      .where(eq(runTable.id, run.id));
    expect((await readPhotoRunLifecycle(ctx.db, run.shortcode)).phase).toBe(
      "ready_for_review",
    );
  });

  it("refuses to dispatch on readiness judged against a superseded input", async () => {
    const { run } = await seedRun({ processor: "cubby" });
    const judged = storedPhotoRunInput.parse((await readRun(run.id)).input);
    if (!judged) throw new Error("fixture: photo input missing");
    await setPhotoRunProcessor(ctx.db, {
      runId: run.shortcode,
      processor: "external",
    });
    const started = await startGuardedPhotoCoordinator(ctx.db, {
      publicId: run.shortcode,
      actorUserId: ctx.actor.userId,
      expectedInput: judged,
    });
    expect(started).toBeNull();
    expect((await readRun(run.id)).dispatchEventId).toBeNull();
  });

  it("refuses new photos once their batch is sealed but replays finalized ones", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Finalize Member",
      kind: "member" as const,
      userId: ctx.actor.userId,
    });
    const clientBatchId = crypto.randomUUID();
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
      grouping: { processor: "external", clientBatchId, imageCount: 2 },
    });
    const stage = async (seed: string) => {
      const sha256 = seed.repeat(64);
      const staged = await createImageFixture(
        ctx.db,
        `lifecycle-finalize-${seed}`,
        {
          status: "PENDING",
          size: 16,
          sha256,
          width: 16,
          height: 16,
          renderStatus: null,
          storageStatus: "unverified",
          verifiedAt: new Date(),
        },
      );
      return { staged, sha256 };
    };
    const ports = (sha256: string) => ({
      ...productionPhotoImportCommitPorts,
      getObject: async () => new Response(new Uint8Array(16)),
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
    const image = (
      entry: Awaited<ReturnType<typeof stage>>,
      position: number,
    ) => ({
      imageId: entry.staged.shortcode,
      position,
      sha256: entry.sha256,
      width: 16,
      height: 16,
    });
    const first = await stage("b");
    await finalizePhotoRun(
      ctx.db,
      { runId: run.publicId, clientBatchId, images: [image(first, 0)] },
      ctx.actor,
      ports(first.sha256),
    );
    await expect(
      finalizePhotoRun(
        ctx.db,
        { runId: run.publicId, images: [image(first, 0)] },
        ctx.actor,
        ports(first.sha256),
      ),
    ).rejects.toThrow(/needs the clientBatchId/);
    await sealPhotoRunBatch(ctx.db, { runId: run.publicId, clientBatchId });

    const late = await stage("c");
    await expect(
      finalizePhotoRun(
        ctx.db,
        { runId: run.publicId, clientBatchId, images: [image(late, 1)] },
        ctx.actor,
        ports(late.sha256),
      ),
    ).rejects.toThrow(/is sealed/);
    const replay = await finalizePhotoRun(
      ctx.db,
      { runId: run.publicId, clientBatchId, images: [image(first, 0)] },
      ctx.actor,
      ports(first.sha256),
    );
    expect(replay.alreadyFinalized).toEqual([first.staged.shortcode]);
  });

  it("restores unresolved photos to pending when a stopped Run takes a new batch", async () => {
    const { run } = await seedRun({ processor: "cubby", generation: true });
    await getDb(ctx.db)
      .update(photoRunImage)
      .set({ state: "unresolved" })
      .where(eq(photoRunImage.runId, run.id));
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "needs_review" })
      .where(eq(runTable.id, run.id));
    await admitPhotoRunBatch(ctx.db, {
      runId: run.shortcode,
      clientBatchId: crypto.randomUUID(),
      imageCount: 1,
    });
    const states = await getDb(ctx.db)
      .select({ state: photoRunImage.state })
      .from(photoRunImage)
      .where(eq(photoRunImage.runId, run.id));
    expect(states.map((row) => row.state)).toEqual(["pending", "pending"]);
    expect((await readRun(run.id)).status).toBe("running");
  });

  it("blocks grouping while a pending photo has no description job", async () => {
    const { run } = await seedRun({ processor: "cubby", describe: "none" });
    // The fixture Image was never uploaded, so the repair cannot schedule;
    // the Run must stay blocked rather than dispatch on bare photos.
    const lifecycle = await advancePhotoRun(ctx.db, run.shortcode);
    expect(lifecycle.phase).toBe("describing");
    const row = await readRun(run.id);
    expect(row.dispatchEventId).toBeNull();
    expect(row.dispatchError).toBeNull();
  });

  it("never ends a freshly registered Activity from a push made with the old token", async () => {
    const { run } = await seedRun({ processor: "external" });
    const device = await insertWithShortcode(ctx.db, "device", {
      installationId: `lifecycle-${crypto.randomUUID()}`,
      name: "Synthetic Phone",
      platform: "ios",
    });
    await getDb(ctx.db).insert(runPushRegistration).values({
      kind: "live_activity",
      runId: run.id,
      deviceId: device.id,
      pushToken: "0011223344556677",
      apnsEnvironment: "development",
      appIdentity: "production",
    });
    const key = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const der = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", key.privateKey),
    );
    const credentials = {
      keyId: "SYNTHKEY02",
      teamId: "SYNTHTEAM2",
      privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`,
    };
    // The device re-registers a fresh token while the old delivery is in flight.
    const transport: ApnsTransport = async () => {
      await getDb(ctx.db)
        .update(runPushRegistration)
        .set({
          pushToken: "8899aabbccddeeff",
          endedAt: null,
          lastStateKey: null,
        })
        .where(eq(runPushRegistration.runId, run.id));
      return { status: 200, reason: null };
    };
    const lifecycle = await readPhotoRunLifecycle(ctx.db, run.shortcode);
    await pushPhotoRunRegistrations(
      ctx.db,
      run.id,
      run.shortcode,
      lifecycle,
      transport,
      credentials,
    );
    const [row] = await getDb(ctx.db)
      .select()
      .from(runPushRegistration)
      .where(eq(runPushRegistration.runId, run.id));
    expect(row?.pushToken).toBe("8899aabbccddeeff");
    expect(row?.endedAt).toBeNull();
    expect(row?.lastStateKey).toBeNull();
  });

  const syntheticCredentials = async () => {
    const key = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const der = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", key.privateKey),
    );
    return {
      keyId: "SYNTHKEY03",
      teamId: "SYNTHTEAM3",
      privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`,
    };
  };

  /** An external, described Run started on a synthetic phone with alerts on. */
  const seedAlertRun = async () => {
    const { run } = await seedRun({ processor: "external" });
    const phone = await insertWithShortcode(ctx.db, "device", {
      installationId: `lifecycle-${crypto.randomUUID()}`,
      name: "Synthetic Phone",
      platform: "ios",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ deviceId: phone.id })
      .where(eq(runTable.id, run.id));
    const actor = buildActorContext(ctx.actor.userId, "web", {
      deviceId: phone.id,
    });
    const runId = parseShortcodeFor("run", run.shortcode);
    await registerPhotoRunNotification(ctx.db, actor, {
      runId,
      deviceToken: "feedfacefeedface0001",
      apnsEnvironment: "development",
      appIdentity: "production",
    });
    return { run, actor, runId };
  };

  const alertRow = async (runId: string) =>
    (
      await getDb(ctx.db)
        .select()
        .from(runPushRegistration)
        .where(
          and(
            eq(runPushRegistration.runId, parseEntityId("run", runId)),
            eq(runPushRegistration.kind, "alert"),
          ),
        )
    )[0];

  it("sends a standard alert with no Live Activity registered, once per phase entry", async () => {
    const { run } = await seedAlertRun();
    const credentials = await syntheticCredentials();
    const requests: Parameters<ApnsTransport>[0][] = [];
    const transport: ApnsTransport = async (request) => {
      requests.push(request);
      return { status: 200, reason: null };
    };
    const push = async () =>
      pushPhotoRunRegistrations(
        ctx.db,
        run.id,
        run.shortcode,
        await readPhotoRunLifecycle(ctx.db, run.shortcode),
        transport,
        credentials,
      );
    await push();
    await push();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers["apns-push-type"]).toBe("alert");
    expect(requests[0]!.headers["apns-topic"]).toBe("com.nickysemenza.cubby");
    const body = JSON.parse(requests[0]!.body) as {
      aps: { alert: { title: string } };
      runId: string;
    };
    expect(body.runId).toBe(run.shortcode);
    expect(body.aps.alert.title).toBe("Ready for Claude or Codex");
    // Alerts outlive the ready phase: no end, unlike a Live Activity.
    expect((await alertRow(run.id))?.endedAt).toBeNull();

    // A new batch leaves the ready phase quietly; sealing it re-enters and
    // alerts again.
    const clientBatchId = crypto.randomUUID();
    await admitPhotoRunBatch(ctx.db, {
      runId: run.shortcode,
      clientBatchId,
      imageCount: 1,
    });
    await push();
    expect(requests).toHaveLength(1);
    expect(
      JSON.parse((await alertRow(run.id))?.lastStateKey ?? "null"),
    ).toEqual([
      "waiting_for_upload",
      (await readPhotoRunLifecycle(ctx.db, run.shortcode)).plannedImageCount,
    ]);
    await sealPhotoRunBatch(ctx.db, { runId: run.shortcode, clientBatchId });
    await push();
    expect(requests).toHaveLength(2);
  });

  it("never marks a notification token replaced while its alert was in flight", async () => {
    const { run } = await seedAlertRun();
    const transport: ApnsTransport = async () => {
      await getDb(ctx.db)
        .update(runPushRegistration)
        // Re-registering resets delivery state, as the register path does.
        .set({
          pushToken: "feedfacefeedface0002",
          lastStateKey: null,
          lastError: null,
        })
        .where(eq(runPushRegistration.runId, run.id));
      return { status: 410, reason: "Unregistered feedfacefeedface0001" };
    };
    await pushPhotoRunRegistrations(
      ctx.db,
      run.id,
      run.shortcode,
      await readPhotoRunLifecycle(ctx.db, run.shortcode),
      transport,
      await syntheticCredentials(),
    );
    const row = await alertRow(run.id);
    expect(row?.pushToken).toBe("feedfacefeedface0002");
    expect(row?.endedAt).toBeNull();
    expect(row?.lastError).toBeNull();
  });

  it("stops alerts once the member turns notifications off", async () => {
    const { run, actor, runId } = await seedAlertRun();
    expect(await endPhotoRunNotification(ctx.db, actor, { runId })).toEqual({
      ended: true,
    });
    const requests: unknown[] = [];
    await pushPhotoRunRegistrations(
      ctx.db,
      run.id,
      run.shortcode,
      await readPhotoRunLifecycle(ctx.db, run.shortcode),
      async (request) => {
        requests.push(request);
        return { status: 200, reason: null };
      },
      await syntheticCredentials(),
    );
    expect(requests).toHaveLength(0);
  });

  it("reopens a completed Run for a new batch with committed work frozen, and refuses a failed one", async () => {
    const { run, codes } = await seedRun({ processor: "external" });
    await getDb(ctx.db)
      .update(photoRunImage)
      .set({ state: "completed" })
      .where(eq(photoRunImage.runId, run.id));
    await getDb(ctx.db)
      .insert(photoGroupProposal)
      .values({
        runId: run.id,
        groupKey: "approved",
        state: "committed",
        productKind: "create",
        productCreate: { name: "Synthetic Approved Item" },
        committedAt: new Date(),
      });
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(runTable.id, run.id));
    const reopened = await admitPhotoRunBatch(ctx.db, {
      runId: run.shortcode,
      clientBatchId: crypto.randomUUID(),
      imageCount: 1,
    });
    expect(reopened.positionOffset).toBe(codes.length);
    const row = await readRun(run.id);
    expect(row.status).toBe("running");
    expect(row.endedAt).toBeNull();
    const targets = await getDb(ctx.db)
      .select({ state: photoRunImage.state })
      .from(photoRunImage)
      .where(eq(photoRunImage.runId, run.id));
    expect(targets.every((target) => target.state === "completed")).toBe(true);
    expect(
      (await listPhotoGroupProposals(ctx.db, run.shortcode)).proposals.map(
        (group) => group.state,
      ),
    ).toEqual(["committed"]);

    const failed = await seedRun({ processor: "external" });
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed" })
      .where(eq(runTable.id, failed.run.id));
    await expect(
      admitPhotoRunBatch(ctx.db, {
        runId: failed.run.shortcode,
        clientBatchId: crypto.randomUUID(),
        imageCount: 1,
      }),
    ).rejects.toThrow(/is failed and cannot take more photos/);
  });

  it("refuses a Cubby batch once the coordinator is retired but lets an external Run reopen", async () => {
    const cubby = await seedRun({ processor: "cubby" });
    await getDb(ctx.db)
      .update(runTable)
      .set({
        status: "completed",
        retiredAt: new Date(),
        retirementReason: "settled",
      })
      .where(eq(runTable.id, cubby.run.id));
    await expect(
      admitPhotoRunBatch(ctx.db, {
        runId: cubby.run.shortcode,
        clientBatchId: crypto.randomUUID(),
        imageCount: 1,
      }),
    ).rejects.toThrow(/start a new photo import/);

    const external = await seedRun({ processor: "external" });
    await getDb(ctx.db)
      .update(runTable)
      .set({
        status: "completed",
        retiredAt: new Date(),
        retirementReason: "settled",
      })
      .where(eq(runTable.id, external.run.id));
    await admitPhotoRunBatch(ctx.db, {
      runId: external.run.shortcode,
      clientBatchId: crypto.randomUUID(),
      imageCount: 1,
    });
    const row = await readRun(external.run.id);
    expect(row.status).toBe("running");
    expect(row.retiredAt).not.toBeNull();
  });

  it("does not stamp retirement on a Run reopened while its coordinator was disposed", async () => {
    const { run } = await seedRun({ processor: "external" });
    await getDb(ctx.db)
      .update(runTable)
      .set({
        status: "completed",
        updatedAt: new Date(Date.now() - 2 * 86_400_000),
      })
      .where(eq(runTable.id, run.id));
    await retireSettledCoordinators(
      ctx.db,
      () => ({
        retire: async () => {
          await admitPhotoRunBatch(ctx.db, {
            runId: run.shortcode,
            clientBatchId: crypto.randomUUID(),
            imageCount: 1,
          });
          return { disposed: true };
        },
      }),
      new Date(Date.now() - 86_400_000),
    );
    const row = await readRun(run.id);
    expect(row.status).toBe("running");
    expect(row.retiredAt).toBeNull();
  });

  it("keeps a manual start on a chosen-processor Run behind the description barrier", async () => {
    const { run } = await seedRun({ processor: "cubby", describe: "failed" });
    const started = await startPhotoGroupingForActor(
      ctx.db,
      buildActorContext(ctx.actor.userId, "web"),
      ctx.actor.userId,
      run.shortcode,
    );
    expect(started.started).toBe(false);
    expect((await readRun(run.id)).dispatchEventId).toBeNull();
  });

  it("refuses a guarded dispatch while a pending description is still in flight", async () => {
    const { run } = await seedRun({ processor: "cubby", describe: "pending" });
    const judged = storedPhotoRunInput.parse((await readRun(run.id)).input);
    if (!judged) throw new Error("fixture: photo input missing");
    expect(
      await startGuardedPhotoCoordinator(ctx.db, {
        publicId: run.shortcode,
        actorUserId: ctx.actor.userId,
        expectedInput: judged,
      }),
    ).toBeNull();
    expect((await readRun(run.id)).dispatchEventId).toBeNull();
  });

  it("scrubs the push token from a registration failure's whole error chain", async () => {
    const { run } = await seedRun({ processor: "external" });
    // The Run names an install with no Device row, so the registration
    // insert fails its foreign key with the token among its parameters.
    const ghost = parseEntityId("device", crypto.randomUUID());
    await getDb(ctx.db)
      .update(runTable)
      .set({ deviceId: ghost })
      .where(eq(runTable.id, run.id));
    const token = "c0ffee00c0ffee00c0ffee00";
    const failure = await registerPhotoRunNotification(
      ctx.db,
      buildActorContext(ctx.actor.userId, "web", { deviceId: ghost }),
      {
        runId: parseShortcodeFor("run", run.shortcode),
        deviceToken: token,
        apnsEnvironment: "development",
        appIdentity: "production",
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const chain: string[] = [];
    for (let link: unknown = failure; link instanceof Error; link = link.cause)
      chain.push(
        link.message,
        link.stack ?? "",
        JSON.stringify("params" in link ? link.params : null),
      );
    expect(chain.join("\n")).not.toContain(token);
    expect(chain.join("\n")).toContain("[push-token]");
  });

  it("never repeats a sent alert on same-token re-registration or overlapping advances", async () => {
    const { run, actor, runId } = await seedAlertRun();
    const credentials = await syntheticCredentials();
    let sends = 0;
    const transport: ApnsTransport = async () => {
      sends += 1;
      return { status: 200, reason: null };
    };
    const lifecycle = await readPhotoRunLifecycle(ctx.db, run.shortcode);
    await Promise.all([
      pushPhotoRunRegistrations(
        ctx.db,
        run.id,
        run.shortcode,
        lifecycle,
        transport,
        credentials,
      ),
      pushPhotoRunRegistrations(
        ctx.db,
        run.id,
        run.shortcode,
        lifecycle,
        transport,
        credentials,
      ),
    ]);
    expect(sends).toBe(1);
    await registerPhotoRunNotification(ctx.db, actor, {
      runId,
      deviceToken: "feedfacefeedface0001",
      apnsEnvironment: "development",
      appIdentity: "production",
    });
    await pushPhotoRunRegistrations(
      ctx.db,
      run.id,
      run.shortcode,
      lifecycle,
      transport,
      credentials,
    );
    expect(sends).toBe(1);
  });

  it("reads a Run stopped for review with only unresolved photos as needing attention", async () => {
    const { run } = await seedRun({ processor: "cubby", generation: true });
    await getDb(ctx.db)
      .update(photoRunImage)
      .set({ state: "unresolved" })
      .where(eq(photoRunImage.runId, run.id));
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "needs_review" })
      .where(eq(runTable.id, run.id));
    expect((await readPhotoRunLifecycle(ctx.db, run.shortcode)).phase).toBe(
      "needs_attention",
    );
  });

  it("keeps an appended batch subscribed when the previous ready alert returns late", async () => {
    const { run, actor, runId } = await seedAlertRun();
    const credentials = await syntheticCredentials();
    const lifecycle = await readPhotoRunLifecycle(ctx.db, run.shortcode);
    const started = Promise.withResolvers<void>();
    const oldResponse =
      Promise.withResolvers<Awaited<ReturnType<ApnsTransport>>>();
    const oldDelivery = pushPhotoRunRegistrations(
      ctx.db,
      run.id,
      run.shortcode,
      lifecycle,
      async () => {
        started.resolve();
        return oldResponse.promise;
      },
      credentials,
    );
    await started.promise;
    const clientBatchId = crypto.randomUUID();
    await admitPhotoRunBatch(ctx.db, { runId, clientBatchId, imageCount: 1 });
    await registerPhotoRunNotification(ctx.db, actor, {
      runId,
      deviceToken: "feedfacefeedface0001",
      apnsEnvironment: "development",
      appIdentity: "production",
    });
    await sealPhotoRunBatch(ctx.db, { runId, clientBatchId });
    const ready = await readPhotoRunLifecycle(ctx.db, run.shortcode);
    const fresh = await pushPhotoRunRegistrations(
      ctx.db,
      run.id,
      run.shortcode,
      ready,
      async () => ({ status: 200, reason: null }),
      credentials,
    );
    expect(fresh.sent).toBe(1);
    oldResponse.resolve({ status: 410, reason: "Unregistered" });
    await oldDelivery;
    expect((await alertRow(run.id))?.endedAt).toBeNull();
    expect((await alertRow(run.id))?.lastError).toBeNull();
  });

  it.each([
    { appIdentity: "development", apnsEnvironment: "development" },
    { appIdentity: "production", apnsEnvironment: "production" },
  ] as const)(
    "does not let a stale APNs response overwrite $appIdentity/$apnsEnvironment registration",
    async (identity) => {
      const { run, actor, runId } = await seedAlertRun();
      const credentials = await syntheticCredentials();
      const lifecycle = await readPhotoRunLifecycle(ctx.db, run.shortcode);
      const started = Promise.withResolvers<void>();
      const oldResponse =
        Promise.withResolvers<Awaited<ReturnType<ApnsTransport>>>();
      const oldDelivery = pushPhotoRunRegistrations(
        ctx.db,
        run.id,
        run.shortcode,
        lifecycle,
        async () => {
          started.resolve();
          return oldResponse.promise;
        },
        credentials,
      );
      await started.promise;
      await registerPhotoRunNotification(ctx.db, actor, {
        runId,
        deviceToken: "feedfacefeedface0001",
        ...identity,
      });
      const fresh = await pushPhotoRunRegistrations(
        ctx.db,
        run.id,
        run.shortcode,
        lifecycle,
        async () => ({ status: 200, reason: null }),
        credentials,
      );
      oldResponse.resolve({ status: 410, reason: "Unregistered" });
      await oldDelivery;
      const [registration] = await getDb(ctx.db)
        .select()
        .from(runPushRegistration)
        .where(eq(runPushRegistration.runId, run.id));
      expect(fresh.sent).toBe(1);
      expect(registration?.endedAt).toBeNull();
      expect(registration?.lastError).toBeNull();
      expect(registration?.lastSentAt).toBeInstanceOf(Date);
    },
  );

  it("addresses each push to the registering build's topic and refuses a development Live Activity", async () => {
    const { run, actor, runId } = await seedAlertRun();
    await expect(
      registerPhotoRunLiveActivity(ctx.db, actor, {
        runId,
        pushToken: "0a0b0c0d0e0f0001",
        apnsEnvironment: "development",
        appIdentity: "development",
      }),
    ).rejects.toThrow(/only supported in the production Cubby app/);
    const liveRows = await getDb(ctx.db)
      .select({ id: runPushRegistration.id })
      .from(runPushRegistration)
      .where(
        and(
          eq(runPushRegistration.runId, run.id),
          eq(runPushRegistration.kind, "live_activity"),
        ),
      );
    expect(liveRows).toHaveLength(0);

    const credentials = await syntheticCredentials();
    const topics: string[] = [];
    const transport: ApnsTransport = async (request) => {
      topics.push(request.headers["apns-topic"] ?? "");
      return { status: 200, reason: null };
    };
    const push = async () =>
      pushPhotoRunRegistrations(
        ctx.db,
        run.id,
        run.shortcode,
        await readPhotoRunLifecycle(ctx.db, run.shortcode),
        transport,
        credentials,
      );
    await push();
    // The same token re-registered from the development build is a new
    // registration: its dedupe state resets and the alert goes to `.dev`.
    await registerPhotoRunNotification(ctx.db, actor, {
      runId,
      deviceToken: "feedfacefeedface0001",
      apnsEnvironment: "development",
      appIdentity: "development",
    });
    await push();
    expect(topics).toEqual([
      "com.nickysemenza.cubby",
      "com.nickysemenza.cubby.dev",
    ]);
  });
});
