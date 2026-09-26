import {
  imageId as parseImageId,
  runEntityId,
} from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { runMutation, runTarget } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { runHandlers } from "~/server/run-browser.server";
import { createTestRequestContext } from "~/server/testing/request-context";

import { startOrResumeRun, startPhotoInventoryRun } from "./run-service";
import {
  listRuns,
  reportRunTargetDeviceWork,
  resolvePurchaseImportTarget,
} from "./run-target";

describe("purchase import run target resolution", () => {
  const ctx = withTestDb();

  it("resolves a Purchase shortcode to the mutation run target", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Import target test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Import target vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Import target account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
      displayLabel: "Imported target purchase",
    });
    await getDb(ctx.db)
      .insert(runMutation)
      .values({
        runId: run.id,
        targetKind: "purchase",
        targetId: purchase.id,
        mutationKind: "create",
        fields: ["displayLabel"],
        postFingerprint: "test-fingerprint",
      });
    const untouchedVendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Untouched target vendor ${crypto.randomUUID()}`,
      website: "https://other.example.test",
      browserDomains: ["other.example.test"],
    });
    const untouchedAccount = await insertWithShortcode(
      ctx.db,
      "vendorAccount",
      {
        label: "Untouched target account",
        vendorId: untouchedVendor.id,
        ledgerPartyId: party.id,
      },
    );
    await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: untouchedAccount.id,
      trigger: "manual",
    });

    const targetId = await resolvePurchaseImportTarget(
      ctx.db,
      purchase.shortcode,
    );
    const [mutation] = await getDb(ctx.db)
      .select({ runId: runMutation.runId })
      .from(runMutation)
      .where(
        and(
          eq(runMutation.targetKind, "purchase"),
          eq(runMutation.targetId, targetId!),
        ),
      );

    expect(targetId).toBe(purchase.id);
    expect(mutation?.runId).toBe(run.id);

    const runs = await listRuns(ctx.db, party.id, targetId!);
    expect(runs.map((row) => row.id)).toEqual([run.id]);
  });
});

describe("run.reportDeviceWork", () => {
  const ctx = withTestDb();

  async function seedPhotoRunTarget() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Device work test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
    });
    const runRow = await getDb(ctx.db).query.run.findFirst({
      where: (table, { eq }) => eq(table.id, run.id),
      columns: { shortcode: true },
    });
    const image = await insertWithShortcode(ctx.db, "image", {
      key: `test-photos/${crypto.randomUUID()}.jpg`,
      filename: "device-work.jpg",
      contentType: "image/jpeg",
      size: 100,
      status: "UPLOADED",
    });
    await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: runEntityId.parse(run.id),
        imageId: parseImageId.parse(image.id),
        targetFingerprint: "device-work-test-fingerprint",
      });
    return { runShortcode: runRow!.shortcode, imageShortcode: image.shortcode };
  }

  it("is idempotent on a repeated report", async () => {
    const { runShortcode, imageShortcode } = await seedPhotoRunTarget();
    const first = await reportRunTargetDeviceWork(ctx.db, {
      run: runShortcode,
      image: imageShortcode,
      state: "running",
    });
    expect(first).toEqual({ recorded: true });

    const second = await reportRunTargetDeviceWork(ctx.db, {
      run: runShortcode,
      image: imageShortcode,
      state: "running",
    });
    expect(second).toEqual({ recorded: true });

    const [row] = await getDb(ctx.db)
      .select({
        deviceWorkState: runTarget.deviceWorkState,
        deviceWorkAttempts: runTarget.deviceWorkAttempts,
      })
      .from(runTarget);
    // Repeating the same state must not double-count an attempt.
    expect(row?.deviceWorkState).toBe("running");
    expect(row?.deviceWorkAttempts).toBe(0);
  });

  it("rejects a caller with no linked member ledger party", async () => {
    const context = {
      ...requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      signal: new AbortController().signal,
    };
    await expect(
      runHandlers.runs.reportDeviceWork!.run(context, {
        run: "RUN-0000",
        image: "IMG-0000",
        state: "queued",
      }),
    ).rejects.toThrow(/not linked to a member ledger party/);
  });

  it("rejects an image that is not a target of the run", async () => {
    const { runShortcode } = await seedPhotoRunTarget();
    const otherImage = await insertWithShortcode(ctx.db, "image", {
      key: `test-photos/${crypto.randomUUID()}.jpg`,
      filename: "unrelated.jpg",
      contentType: "image/jpeg",
      size: 100,
      status: "UPLOADED",
    });
    await expect(
      reportRunTargetDeviceWork(ctx.db, {
        run: runShortcode,
        image: otherImage.shortcode,
        state: "queued",
      }),
    ).rejects.toThrow(/no photo target/);
  });

  it("increments attempts only on transition into failed, not on repeats", async () => {
    const { runShortcode, imageShortcode } = await seedPhotoRunTarget();
    await reportRunTargetDeviceWork(ctx.db, {
      run: runShortcode,
      image: imageShortcode,
      state: "running",
    });
    await reportRunTargetDeviceWork(ctx.db, {
      run: runShortcode,
      image: imageShortcode,
      state: "failed",
      error: "device offline",
    });
    await reportRunTargetDeviceWork(ctx.db, {
      run: runShortcode,
      image: imageShortcode,
      state: "failed",
      error: "device offline",
    });
    const [row] = await getDb(ctx.db)
      .select({
        deviceWorkState: runTarget.deviceWorkState,
        deviceWorkAttempts: runTarget.deviceWorkAttempts,
        deviceWorkError: runTarget.deviceWorkError,
      })
      .from(runTarget);
    expect(row?.deviceWorkState).toBe("failed");
    expect(row?.deviceWorkAttempts).toBe(1);
    expect(row?.deviceWorkError).toBe("device offline");
  });
});
