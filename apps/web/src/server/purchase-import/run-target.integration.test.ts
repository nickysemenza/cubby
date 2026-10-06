import {
  imageId as parseImageId,
  runEntityId,
} from "@cubby/schemas/identifiers";
import { runSummary } from "@cubby/schemas/run";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { aiUsage, auditLog, runTarget } from "~/server/db/schema";
import { runHandlers } from "~/server/operations/run.server";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
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
      .insert(auditLog)
      .values({
        runId: run.id,
        entityKind: "purchase",
        entityId: purchase.id,
        action: "create",
        changes: { displayLabel: { from: null, to: null } },
        userId: ctx.actor.userId,
        channel: "mcp",
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
      .select({ runId: auditLog.runId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, "purchase"),
          eq(auditLog.entityId, targetId!),
        ),
      );

    expect(targetId).toBe(purchase.id);
    expect(mutation?.runId).toBe(run.id);

    const runs = await listRuns(ctx.db, party.id, targetId!);
    expect(runs.map((row) => row.id)).toEqual([run.id]);
  });
});

// A left join with no calls is free; actual unpriced calls make the whole
// subtotal unknown, including when a priced call is present.
describe("import run summary pricing", () => {
  const ctx = withTestDb();
  it.each([
    { costs: [], expected: 0 },
    { costs: [0.125, 0.25], expected: 0.375 },
    { costs: [null], expected: null },
    { costs: [0.125, null], expected: null },
  ])("preserves spend for $costs", async ({ costs, expected }) => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic pricing member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
    });
    if (costs.length)
      await getDb(ctx.db)
        .insert(aiUsage)
        .values(
          costs.map((estimatedCost) => ({
            feature: "synthetic",
            provider: "openai",
            model: "gpt-6-sol",
            operation: "synthetic.summary",
            runId: runEntityId.parse(run.id),
            durationMs: 1,
            transport: "gateway",
            estimatedCost,
          })),
        );
    const [summary] = await listRuns(ctx.db, party.id);
    expect(summary?.estimatedCost).toBe(expected);
    expect(
      runSummary.parse({
        ...summary,
        startedAt: summary!.startedAt.toISOString(),
        endedAt: summary!.endedAt?.toISOString() ?? null,
      }).estimatedCost,
    ).toBe(summary!.estimatedCost);
  });
});

describe("run target entity reference", () => {
  const ctx = withTestDb();

  // A target names one purchase, product or image; the kind CHECK is the only
  // thing keeping a run worklist from pointing at any other entity.
  it("refuses an entityKind outside purchase, product and image", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Run target kind test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
    });
    const recipe = await insertWithShortcode(ctx.db, "recipe", {
      name: "Run target kind recipe",
    });
    await expect(
      getDb(ctx.db).execute(
        sql`INSERT INTO "RunTarget" ("runId", "entityId", "entityKind", "targetFingerprint")
            VALUES (${run.id}, ${recipe.id}, 'recipe', 'kind-test-fingerprint')`,
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "RunTarget_entityKind_check" },
    });
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
        entityKind: "image",
        entityId: parseImageId.parse(image.id),
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
