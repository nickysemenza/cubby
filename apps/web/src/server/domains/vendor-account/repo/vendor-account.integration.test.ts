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
import { startImportRunFixture } from "~/server/domains/purchase-import/service/import-run.fixtures";
import { getRunByID } from "~/server/domains/run/repo/run";
import {
  getVendorAccountByShortcode,
  listVendorAccountsRead,
} from "~/server/domains/vendor-account/repo/vendor-account";
import { getEntityGraph } from "~/server/generic/entity-graph/repo/entity-graph";
import { getFilterOptions } from "~/server/generic/list/repo/filter-options";
import {
  lookupEntityLabels,
  lookupEntityReferences,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
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
    expect(created.item.displayName).toBe(
      "Import owner vendor · Import owner member",
    );
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

/**
 * Failure modes: an account title is a stored copy that goes stale when its
 * Vendor or member is renamed; list search, sort, reference lookups, Run
 * labels, the entity graph or filter-option rosters read a different label
 * than the account.
 */
describe("derived vendor account label", () => {
  const ctx = withTestDb();

  it("reads the current vendor and member names everywhere the account is named", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Morgan",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const store = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Store",
    });
    const other = await insertWithShortcode(ctx.db, "vendor", {
      name: "Zephyr Supply",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: store.id,
      ledgerPartyId: member.id,
    });
    const second = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: other.id,
      ledgerPartyId: member.id,
    });
    const accountRun = await startImportRunFixture(ctx.db, {
      ledgerPartyId: member.id,
      vendorAccountId: account.id,
    });

    await getDb(ctx.db)
      .update(vendorTable)
      .set({ name: "Renamed Store" })
      .where(eq(vendorTable.id, store.id));
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ name: "Avery" })
      .where(eq(ledgerParty.id, member.id));
    const expected = "Renamed Store · Avery";

    expect(
      (await getVendorAccountByShortcode(ctx.db, account.shortcode))
        ?.displayName,
    ).toBe(expected);
    const page = { pageIndex: 0, pageSize: 10 };
    const sorted = await listVendorAccountsRead(
      ctx.db,
      {},
      [{ orderBy: "displayName", direction: "desc" }],
      page,
    );
    expect(sorted.data.map((row) => row.displayName)).toEqual([
      "Zephyr Supply · Avery",
      expected,
    ]);
    const found = await listVendorAccountsRead(
      ctx.db,
      { search: "renamed store · av" },
      [],
      page,
    );
    expect(found.data.map((row) => row.id)).toEqual([account.shortcode]);
    const stale = await listVendorAccountsRead(
      ctx.db,
      { search: "Example Store" },
      [],
      page,
    );
    expect(stale.count).toBe(0);

    expect(
      (await lookupEntityReferences(ctx.db, "vendorAccount", [account.id])).get(
        account.id,
      )?.name,
    ).toBe(expected);
    expect([
      ...(
        await lookupEntityLabels(ctx.db, [
          { entity: "vendorAccount", id: second.id },
        ])
      ).values(),
    ]).toEqual(["Zephyr Supply · Avery"]);
    expect((await getRunByID(ctx.db, accountRun.id)).vendorAccountLabel).toBe(
      expected,
    );
    const graph = await getEntityGraph(ctx.db, {
      roots: [{ entityKind: "vendorAccount", entityId: account.shortcode }],
      relationshipKeys: [],
    });
    expect(graph.nodes.map((node) => node.label)).toEqual([expected]);
    const options = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "vendorAccount",
      search: "renamed",
      selectedIds: [],
      limit: 25,
      include: [],
    });
    expect(options.items).toEqual([{ id: account.shortcode, label: expected }]);
  });
});
