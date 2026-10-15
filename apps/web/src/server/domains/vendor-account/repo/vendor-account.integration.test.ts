import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  ledgerParty,
  run,
  vendor as vendorTable,
  vendorAccount,
} from "~/server/db/schema";
import { startImportRunFixture } from "~/server/domains/purchase-import/import-run.fixtures";
import { getVendorAccountByShortcode } from "~/server/domains/vendor-account/repo/vendor-account";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/generic/shortcode/repo/shortcode-utils";

/**
 * `VendorAccount.lastRunAt` / `lastSuccessAt` are read from Run — the latest
 * start and the latest end of a completed run — so an account can never
 * disagree with the run history it summarizes.
 */
describe("vendor account run activity", () => {
  const ctx = withTestDb();

  it("reads lastRunAt and lastSuccessAt from the account's runs", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Activity member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Activity vendor",
      website: "https://shop.example.test/orders",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Activity account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });

    const before = await getVendorAccountByShortcode(ctx.db, account.shortcode);
    expect(before?.lastRunAt).toBeNull();
    expect(before?.lastSuccessAt).toBeNull();

    const started = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
    });
    const [row] = await getDb(ctx.db)
      .select({ startedAt: run.startedAt })
      .from(run)
      .where(eq(run.id, started.id));
    const running = await getVendorAccountByShortcode(
      ctx.db,
      account.shortcode,
    );
    expect(running?.lastRunAt).toEqual(row?.startedAt);
    expect(running?.lastSuccessAt).toBeNull();

    const endedAt = new Date("2026-06-01T12:00:00.000Z");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", endedAt })
      .where(eq(run.id, started.id));
    const done = await getVendorAccountByShortcode(ctx.db, account.shortcode);
    expect(done?.lastSuccessAt).toEqual(endedAt);
  });
});

/**
 * Failure modes: account creation drops vendor/member ownership or the
 * inventory-owner default; a created account fails to scope its import Run;
 * browser-domain metadata triggers an automatic vendor classification.
 */
describe("vendor account creation persistence", () => {
  const ctx = withTestDb();

  it("persists owner defaults and keeps the created account on its import Run", async () => {
    const { row: party } = await findOrCreateWithShortcode(
      ctx.db,
      "ledgerParty",
      {
        where: eq(ledgerParty.userId, ctx.actor.userId),
        values: () => ({
          name: "Import owner member",
          kind: "member" as const,
          userId: ctx.actor.userId,
        }),
      },
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Import owner vendor",
      browserDomains: ["shop.example.test"],
    });
    const { entityKernelContextSchema, executeEntity } =
      await import("~/server/entity-kernel");
    const { requireActor } = await import("~/server/http/request-context");
    const { createTestRequestContext } =
      await import("~/server/testing/request-context");
    const kernel = entityKernelContextSchema.parse(
      requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
    );
    const created = await executeEntity(kernel, {
      action: "create",
      entity: "vendorAccount",
      data: {
        label: "Import owner account",
        vendorId: parseShortcodeFor("vendor", vendor.shortcode),
        ledgerPartyId: parseShortcodeFor("ledgerParty", party.shortcode),
        status: "active",
        inventoryOwnerDefaultEnabled: true,
      },
    });

    const [createdRow] = await getDb(ctx.db)
      .select({ id: vendorAccount.id })
      .from(vendorAccount)
      .where(eq(vendorAccount.shortcode, created.item.id));
    if (!createdRow)
      throw new Error("Created vendor account was not persisted");
    const [persistedAccount] = await getDb(ctx.db)
      .select({
        vendorId: vendorAccount.vendorId,
        ledgerPartyId: vendorAccount.ledgerPartyId,
        inventoryOwnerDefaultEnabled:
          vendorAccount.inventoryOwnerDefaultEnabled,
        status: vendorAccount.status,
      })
      .from(vendorAccount)
      .where(eq(vendorAccount.id, createdRow.id));
    expect(persistedAccount).toEqual({
      vendorId: vendor.id,
      ledgerPartyId: party.id,
      inventoryOwnerDefaultEnabled: true,
      status: "active",
    });

    const started = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: createdRow.id,
    });
    const [persistedRun] = await getDb(ctx.db)
      .select({
        vendorAccountId: run.vendorAccountId,
        ledgerPartyId: run.ledgerPartyId,
      })
      .from(run)
      .where(eq(run.id, started.id));
    expect(persistedRun).toEqual({
      vendorAccountId: createdRow.id,
      ledgerPartyId: party.id,
    });

    const [persistedVendor] = await getDb(ctx.db)
      .select({ orderEvidence: vendorTable.orderEvidence })
      .from(vendorTable)
      .where(eq(vendorTable.id, vendor.id));
    expect(persistedVendor?.orderEvidence).toBeNull();
  });
});
