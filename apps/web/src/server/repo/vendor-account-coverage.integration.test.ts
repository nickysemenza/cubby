import { relatedPreviewInput } from "@cubby/schemas/related-view";
import { vendorAccountFilters } from "@cubby/schemas/vendor-account";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getConnectedRecords } from "./connected-records";
import { loadDataQualities } from "./data-quality/hydrate";
import { updatePurchase } from "./purchase";
import { loadRelatedPreviews } from "./related-view";
import { createImageFixture, insertEntityAttachments } from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";
import {
  getVendorAccountByShortcode,
  listVendorAccountsRead,
} from "./vendor-account";
import { readRecordWorkQueue, readWorkQueue } from "./work-queue";

// Failure modes: a vendor without purchases escapes logo work, duplicate
// problem/research branches produce two tasks for one logo, assigning an
// account leaves Purchase quality/work stale, or a shared vendor mixes members'
// purchases and counts (including deleted rows) in account previews.
describe("vendor identity and purchase account coverage", () => {
  const ctx = withTestDb();

  it("queues one logo gap for a vendor with no purchases or accounts and clears it when fixed", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic new vendor",
    });
    const quality = (
      await loadDataQualities(ctx.db, "vendor", [vendor.id])
    ).get(vendor.id);
    expect(quality?.gaps.map((gap) => gap.check)).toContain("vendor_logo");

    const work = await readRecordWorkQueue(
      ctx.db,
      null,
      vendor.shortcode,
      false,
    );
    expect(work.items).toHaveLength(1);
    expect(work.items[0]).toMatchObject({
      entity: "vendor",
      source: "research",
      waitingFor: { kind: "either" },
      gaps: [{ check: "vendor_logo" }],
    });
    const filtered = await readWorkQueue(
      ctx.db,
      null,
      workQueueHouseholdInput.parse({
        check: ["vendor_logo"],
      }),
      false,
    );
    expect(filtered.items.map((item) => item.id)).toContain(vendor.shortcode);

    const logo = await createImageFixture(ctx.db, "synthetic-new-vendor-logo");
    await insertEntityAttachments(ctx.db, {
      entityId: vendor.id,
      role: "logo",
      imageId: logo.id,
    });
    const fixed = await readRecordWorkQueue(
      ctx.db,
      null,
      vendor.shortcode,
      false,
    );
    expect(fixed.items).toEqual([]);
  });

  it("lowers Purchase quality for a missing account and clears its work after assignment", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic guest vendor",
    });
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic guest member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic in-store relationship",
      vendorId: vendor.id,
      ledgerPartyId: member.id,
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      displayLabel: "Synthetic guest purchase",
      date: "2026-09-01",
    });
    const before = (
      await loadDataQualities(ctx.db, "purchase", [purchase.id])
    ).get(purchase.id);
    expect(before?.gaps.map((gap) => gap.check)).toContain(
      "purchase_vendor_account",
    );
    const input = workQueueHouseholdInput.parse({
      check: ["purchase_vendor_account"],
    });
    const work = await readWorkQueue(ctx.db, null, input, false);
    expect(work.items.map((item) => item.id)).toContain(purchase.shortcode);

    await updatePurchase(
      ctx.db,
      purchase.shortcode,
      { vendorAccountId: account.shortcode },
      ctx.actor,
    );
    const after = (
      await loadDataQualities(ctx.db, "purchase", [purchase.id])
    ).get(purchase.id);
    expect(after?.gaps.map((gap) => gap.check)).not.toContain(
      "purchase_vendor_account",
    );
    expect(after?.score).toBeGreaterThan(before?.score ?? 0);
    const fixed = await readWorkQueue(ctx.db, null, input, false);
    expect(fixed.items.map((item) => item.id)).not.toContain(
      purchase.shortcode,
    );
  });

  it("previews only each account's latest three live purchases and counts all its purchases", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic shared vendor",
    });
    const firstMember = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic member A",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const secondMember = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic member B",
      kind: "member",
    });
    const first = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic relationship A",
      vendorId: vendor.id,
      ledgerPartyId: firstMember.id,
    });
    const second = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic relationship B",
      vendorId: vendor.id,
      ledgerPartyId: secondMember.id,
    });
    const purchases = [];
    for (const day of [1, 2, 3, 4]) {
      purchases.push(
        await insertWithShortcode(ctx.db, "purchase", {
          vendorId: vendor.id,
          vendorAccountId: first.id,
          displayLabel: `Synthetic purchase ${day}`,
          date: `2026-09-0${day}`,
        }),
      );
    }
    const other = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: second.id,
      date: "2026-09-09",
    });
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-10",
    });
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: first.id,
      date: "2026-09-11",
      deletedAt: new Date(),
    });

    const previews = await loadRelatedPreviews(
      ctx.db,
      relatedPreviewInput.parse({
        source: "vendorAccount",
        sourceIds: [first.shortcode, second.shortcode],
        relationKeys: ["vendorAccount.purchases"],
      }),
    );
    const firstPreview = previews.find(
      (preview) => preview.sourceId === first.shortcode,
    );
    expect(firstPreview?.totalCount).toBe(4);
    expect(firstPreview?.items.map((item) => item.id)).toEqual(
      purchases
        .slice(1)
        .reverse()
        .map((purchase) => purchase.shortcode),
    );
    expect(firstPreview?.items.map((item) => item.label)).toEqual([
      "Synthetic purchase 4",
      "Synthetic purchase 3",
      "Synthetic purchase 2",
    ]);
    const secondPreview = previews.find(
      (preview) => preview.sourceId === second.shortcode,
    );
    expect(secondPreview?.totalCount).toBe(1);
    expect(secondPreview?.items.map((item) => item.id)).toEqual([
      other.shortcode,
    ]);
    expect(
      (await getVendorAccountByShortcode(ctx.db, first.shortcode))
        ?.purchaseCount,
    ).toBe(4);
    expect(
      (await getVendorAccountByShortcode(ctx.db, second.shortcode))
        ?.purchaseCount,
    ).toBe(1);
    const filtered = await listVendorAccountsRead(
      ctx.db,
      vendorAccountFilters.parse({ purchaseId: [other.shortcode] }),
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(filtered.data.map((account) => account.id)).toEqual([
      second.shortcode,
    ]);
    const all = await getConnectedRecords(ctx.db, {
      source: { entityKind: "vendorAccount", entityId: first.shortcode },
      viewKey: "relation:purchases",
    });
    expect(all.totalCount).toBe(4);
    expect(all.items.map((item) => item.target.entityId).sort()).toEqual(
      purchases.map((purchase) => purchase.shortcode).sort(),
    );
  });
});
