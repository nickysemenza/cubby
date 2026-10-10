/** A member's confirmed statement-merchant → Vendor routing. */
import type { ActorContext } from "@cubby/schemas/context";
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import {
  confirmMerchantVendorRuleInput,
  confirmMerchantVendorRuleOut,
  type ConfirmMerchantVendorRuleInput,
} from "@cubby/schemas/purchase-import";
import { and, asc, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { merchantVendorRule, vendor } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { currentMemberLedgerParty } from "~/server/repo/member-login";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

const normalizeMerchant = (value: string) =>
  value.trim().toLowerCase().replaceAll(/\s+/g, " ");

export async function confirmMerchantVendorRule(
  db: Database,
  rawInput: ConfirmMerchantVendorRuleInput,
  actor: ActorContext,
) {
  const input = confirmMerchantVendorRuleInput.parse(rawInput);
  const party = await currentMemberLedgerParty(db, actor);
  if (!party) throw new Error("Member identity is not configured.");
  const vendorId = await resolveOrThrow(db, "vendor", input.vendorId);
  const normalizedMerchant = normalizeMerchant(input.merchant);
  await getDb(db)
    .insert(merchantVendorRule)
    .values({
      ledgerPartyId: party.id,
      normalizedMerchant,
      vendorId,
      confirmedByUserId: actor.userId,
    })
    .onConflictDoUpdate({
      target: [
        merchantVendorRule.ledgerPartyId,
        merchantVendorRule.normalizedMerchant,
      ],
      set: { vendorId, confirmedByUserId: actor.userId, updatedAt: new Date() },
    });
  return confirmMerchantVendorRuleOut.parse({
    normalizedMerchant,
    vendorId: input.vendorId,
  });
}

/** A member's confirmed merchant routing, plus every vendor it may route to. */
export async function listMerchantVendorRules(
  db: Database,
  ledgerPartyId: LedgerPartyId,
) {
  const [rules, vendors] = await Promise.all([
    getDb(db)
      .select({
        merchant: merchantVendorRule.normalizedMerchant,
        vendorId: vendor.shortcode,
        vendorName: vendor.name,
      })
      .from(merchantVendorRule)
      .innerJoin(
        vendor,
        and(eq(vendor.id, merchantVendorRule.vendorId), notDeleted(vendor)),
      )
      .where(eq(merchantVendorRule.ledgerPartyId, ledgerPartyId))
      .orderBy(asc(merchantVendorRule.normalizedMerchant)),
    getDb(db)
      .select({ shortcode: vendor.shortcode, name: vendor.name })
      .from(vendor)
      .where(notDeleted(vendor))
      .orderBy(asc(vendor.name)),
  ]);
  return { rules, vendors };
}
