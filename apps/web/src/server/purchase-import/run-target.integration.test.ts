import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { importRunMutation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { startOrResumeImportRun } from "./run-service";
import {
  listPurchaseImportRuns,
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
    const run = await startOrResumeImportRun(ctx.db, {
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
      .insert(importRunMutation)
      .values({
        runId: run.id,
        targetType: "purchase",
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
    await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: untouchedAccount.id,
      trigger: "manual",
    });

    const targetId = await resolvePurchaseImportTarget(
      ctx.db,
      purchase.shortcode,
    );
    const [mutation] = await getDb(ctx.db)
      .select({ runId: importRunMutation.runId })
      .from(importRunMutation)
      .where(
        and(
          eq(importRunMutation.targetType, "purchase"),
          eq(importRunMutation.targetId, targetId!),
        ),
      );

    expect(targetId).toBe(purchase.id);
    expect(mutation?.runId).toBe(run.id);

    const runs = await listPurchaseImportRuns(ctx.db, party.id, targetId!);
    expect(runs.map((row) => row.id)).toEqual([run.id]);
  });
});
