/**
 * Charge-driven hunt eligibility against real PostgreSQL.
 *
 * Failure modes these scenarios guard:
 * - a vendor's source classification (`orderEvidence: not_expected`) silently
 *   suppresses a hunt for a charge whose resolved evidence policy requires
 *   evidence;
 * - a charge whose resolved policy is `not_expected` (transaction override,
 *   category, vendor, reviewed reimbursement) still opens a hunt;
 * - the transaction override or category policy is ignored in favor of the
 *   vendor's, or the vendor's is ignored when nothing closer decides;
 * - an unclassified policy changes today's behavior, which `orderEvidence`
 *   alone governs;
 * - a null `orderEvidence` or an `online_account` loses the mail-then-browser
 *   path, or `receipt_only` loses the receipt path;
 * - rediscovery opens a second hunt or rewrites an existing one.
 */
import type { SpendingCategoryId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { importHunt, merchantVendorRule } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { discoverImportHunts } from "./hunts";

type Policy = "required" | "not_expected" | "unknown";
type OrderEvidence = "online_account" | "receipt_only" | "not_expected" | null;

describe("charge-driven hunt eligibility", () => {
  const ctx = withTestDb();

  async function seed() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Hunt policy member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: party.id,
    });
    let n = 0;
    return {
      party,
      /** A vendor routed from its own merchant descriptor. */
      async vendor(values: {
        orderEvidence?: OrderEvidence;
        evidenceExpectation?: Policy | null;
      }) {
        n += 1;
        const merchant = `policy shop ${n}`;
        const vendor = await insertWithShortcode(ctx.db, "vendor", {
          name: `Policy shop ${n}`,
          ...values,
        });
        await getDb(ctx.db).insert(merchantVendorRule).values({
          ledgerPartyId: party.id,
          normalizedMerchant: merchant,
          vendorId: vendor.id,
          confirmedByUserId: ctx.actor.userId,
        });
        return {
          vendor,
          charge: (
            extra: {
              kind?: "refund";
              amount?: number;
              evidenceExpectation?: Policy;
              spendingCategoryId?: SpendingCategoryId;
            } = {},
          ) =>
            insertWithShortcode(ctx.db, "financialTransaction", {
              accountId: card.id,
              kind: "purchase",
              status: "posted",
              amount: 25,
              merchant: merchant.toUpperCase(),
              transactionDate: "2026-09-10",
              postedDate: "2026-09-10",
              ...extra,
            }),
        };
      },
    };
  }

  const huntFor = async (transactionId: string) => {
    const rows = await getDb(ctx.db)
      .select({ state: importHunt.state })
      .from(importHunt)
      .where(
        eq(
          importHunt.financialTransactionId,
          parseEntityId("financialTransaction", transactionId),
        ),
      );
    return rows.map((row) => row.state);
  };

  it("still hunts for a required charge when the vendor's source is not_expected, and starts it in receipt_required", async () => {
    const s = await seed();
    const shop = await s.vendor({
      orderEvidence: "not_expected",
      evidenceExpectation: "required",
    });
    const charge = await shop.charge();

    await expect(discoverImportHunts(ctx.db)).resolves.toBe(1);
    expect(await huntFor(charge.id)).toEqual(["receipt_required"]);

    // Replay-safe: neither a second hunt nor a state rewrite.
    await expect(discoverImportHunts(ctx.db)).resolves.toBe(0);
    expect(await huntFor(charge.id)).toEqual(["receipt_required"]);
  });

  it("does not hunt for an unclassified charge whose vendor source is not_expected", async () => {
    const s = await seed();
    const shop = await s.vendor({ orderEvidence: "not_expected" });
    const charge = await shop.charge();
    await expect(discoverImportHunts(ctx.db)).resolves.toBe(0);
    expect(await huntFor(charge.id)).toEqual([]);
  });

  it("lets orderEvidence pick only the discovery source when evidence is wanted", async () => {
    const s = await seed();
    const receipt = await s.vendor({ orderEvidence: "receipt_only" });
    const online = await s.vendor({ orderEvidence: "online_account" });
    const unclassified = await s.vendor({ orderEvidence: null });
    const requiredOnline = await s.vendor({
      orderEvidence: "online_account",
      evidenceExpectation: "required",
    });
    const requiredNull = await s.vendor({
      orderEvidence: null,
      evidenceExpectation: "required",
    });
    const requiredReceipt = await s.vendor({
      orderEvidence: "receipt_only",
      evidenceExpectation: "required",
    });
    const charges = {
      receipt: await receipt.charge(),
      online: await online.charge(),
      unclassified: await unclassified.charge(),
      requiredOnline: await requiredOnline.charge(),
      requiredNull: await requiredNull.charge(),
      requiredReceipt: await requiredReceipt.charge(),
    };
    await discoverImportHunts(ctx.db);
    expect(await huntFor(charges.receipt.id)).toEqual(["receipt_required"]);
    expect(await huntFor(charges.online.id)).toEqual(["pending_mail"]);
    expect(await huntFor(charges.unclassified.id)).toEqual(["pending_mail"]);
    expect(await huntFor(charges.requiredOnline.id)).toEqual(["pending_mail"]);
    expect(await huntFor(charges.requiredNull.id)).toEqual(["pending_mail"]);
    expect(await huntFor(charges.requiredReceipt.id)).toEqual([
      "receipt_required",
    ]);
  });

  it("never hunts for a charge whose resolved policy is not_expected, whatever the vendor's source says", async () => {
    const s = await seed();
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Hunt policy exempt",
      evidenceExpectation: "not_expected",
    });
    const viaVendor = await s.vendor({
      orderEvidence: "online_account",
      evidenceExpectation: "not_expected",
    });
    const viaOverride = await s.vendor({ orderEvidence: "online_account" });
    const viaCategory = await s.vendor({ orderEvidence: "online_account" });
    const charges = [
      await viaVendor.charge(),
      await viaOverride.charge({ evidenceExpectation: "not_expected" }),
      await viaCategory.charge({ spendingCategoryId: category.id }),
    ];
    await expect(discoverImportHunts(ctx.db)).resolves.toBe(0);
    for (const charge of charges) expect(await huntFor(charge.id)).toEqual([]);
  });

  it("resolves transaction override, then vendor, then category", async () => {
    const s = await seed();
    const required = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Hunt policy wanted",
      evidenceExpectation: "required",
    });
    const exempt = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Hunt policy exempt",
      evidenceExpectation: "not_expected",
    });
    // Override beats a vendor that says not_expected.
    const overrideWins = await s.vendor({
      orderEvidence: "not_expected",
      evidenceExpectation: "not_expected",
    });
    // Vendor beats a category that says not_expected.
    const vendorWins = await s.vendor({
      orderEvidence: "not_expected",
      evidenceExpectation: "required",
    });
    // The category decides when neither closer level does.
    const categoryRequired = await s.vendor({ orderEvidence: "not_expected" });
    const categoryExempt = await s.vendor({ orderEvidence: "online_account" });
    const a = await overrideWins.charge({ evidenceExpectation: "required" });
    const b = await vendorWins.charge({ spendingCategoryId: exempt.id });
    const c = await categoryRequired.charge({
      spendingCategoryId: required.id,
    });
    const d = await categoryExempt.charge({ spendingCategoryId: exempt.id });
    await discoverImportHunts(ctx.db);
    expect(await huntFor(a.id)).toEqual(["receipt_required"]);
    expect(await huntFor(b.id)).toEqual(["receipt_required"]);
    expect(await huntFor(c.id)).toEqual(["receipt_required"]);
    expect(await huntFor(d.id)).toEqual([]);
  });

  it("does not hunt for a reviewed reimbursement even when the vendor requires evidence", async () => {
    const s = await seed();
    const shop = await s.vendor({
      orderEvidence: "not_expected",
      evidenceExpectation: "required",
    });
    const credit = await shop.charge({ kind: "refund", amount: -8 });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Hunt policy friend reimbursement",
      cost: -8,
      date: "2026-09-10",
      costType: "materials",
      economicRole: "reimbursement",
      bookingTransactionCode: credit.shortcode,
    });
    await expect(discoverImportHunts(ctx.db)).resolves.toBe(0);
    expect(await huntFor(credit.id)).toEqual([]);
  });
});
