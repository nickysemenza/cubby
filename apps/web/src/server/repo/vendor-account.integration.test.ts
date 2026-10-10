import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { VendorAccountUpdateData } from "@cubby/schemas/vendor-account";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { ledgerParty, run, vendor as vendorTable } from "~/server/db/schema";
import { startImportRunFixture } from "~/server/purchase-import/import-run.fixtures";
import { getDb } from "~/server/repo/database-helpers";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/repo/shortcode-utils";
import {
  createVendorAccount,
  getVendorAccountByShortcode,
} from "~/server/repo/vendor-account";

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
 * A member's browser-synced account for a vendor with browser domains is clear
 * evidence the vendor has an online order trail. Failure modes: an explicit
 * choice overwritten; a disabled (mail-only) account or a vendor with no
 * browser domains treated as proof.
 */
describe("vendor account creation classifies order evidence", () => {
  const ctx = withTestDb();

  let count = 0;
  async function create(
    vendorValues: {
      orderEvidence?: "online_account" | "receipt_only" | "not_expected";
      browserDomains?: string[];
    },
    status: "active" | "disabled" = "active",
  ) {
    const { row: party } = await findOrCreateWithShortcode(
      ctx.db,
      "ledgerParty",
      {
        where: eq(ledgerParty.userId, ctx.actor.userId),
        values: () => ({
          name: "Classifier member",
          kind: "member" as const,
          userId: ctx.actor.userId,
        }),
      },
    );
    count += 1;
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Classifier vendor ${count}`,
      ...vendorValues,
    });
    await createVendorAccount(
      ctx.db,
      {
        label: "Classifier account",
        vendorId: parseShortcodeFor("vendor", vendor.shortcode),
        ledgerPartyId: parseShortcodeFor("ledgerParty", party.shortcode),
        status,
        browser: "chrome",
        inventoryOwnerDefaultEnabled: false,
        browserSyncEnabled: true,
      },
      ctx.actor,
    );
    const [row] = await getDb(ctx.db)
      .select({ orderEvidence: vendorTable.orderEvidence })
      .from(vendorTable)
      .where(eq(vendorTable.id, vendor.id));
    return row?.orderEvidence;
  }

  it("sets online_account only when the vendor has none and has browser domains", async () => {
    await expect(
      create({ browserDomains: ["shop.example.test"] }),
    ).resolves.toBe("online_account");
  });

  it("preserves every explicit choice", async () => {
    for (const orderEvidence of [
      "receipt_only",
      "not_expected",
      "online_account",
    ] as const)
      await expect(
        create({ orderEvidence, browserDomains: ["shop.example.test"] }),
      ).resolves.toBe(orderEvidence);
  });

  it("classifies a mail-only account only once it is both active and synced", async () => {
    const { entityKernelContextSchema, executeEntity } =
      await import("~/server/entity-kernel");
    const { requireActor } = await import("~/server/request-context");
    const { createTestRequestContext } =
      await import("~/server/testing/request-context");
    const kernel = entityKernelContextSchema.parse(
      requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
    );
    const { row: party } = await findOrCreateWithShortcode(
      ctx.db,
      "ledgerParty",
      {
        where: eq(ledgerParty.userId, ctx.actor.userId),
        values: () => ({
          name: "Classifier member",
          kind: "member" as const,
          userId: ctx.actor.userId,
        }),
      },
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Classifier mail-only vendor",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Classifier mail",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
      status: "disabled",
      browserSyncEnabled: false,
    });
    const evidence = async () =>
      (
        await getDb(ctx.db)
          .select({ orderEvidence: vendorTable.orderEvidence })
          .from(vendorTable)
          .where(eq(vendorTable.id, vendor.id))
      )[0]?.orderEvidence;
    const update = (data: VendorAccountUpdateData) =>
      executeEntity(kernel, {
        action: "update",
        entity: "vendorAccount",
        id: account.shortcode,
        data,
      });

    // Sync on while still disabled is not yet an online account.
    await update({ browserSyncEnabled: true });
    await expect(evidence()).resolves.toBeNull();
    // Activating it later, without resending the sync flag, completes it.
    await update({ status: "active" });
    await expect(evidence()).resolves.toBe("online_account");
  });

  it("leaves weak signals unclassified for review", async () => {
    await expect(create({})).resolves.toBeNull();
    await expect(
      create({ browserDomains: ["shop.example.test"] }, "disabled"),
    ).resolves.toBeNull();
  });
});
