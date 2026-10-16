import { sql } from "drizzle-orm";

import { vendor } from "~/server/db/retained-tables";
import { displayableImageRawSql } from "~/server/domains/image/repo/image-displayability";

import { defineEntityChecks } from "../registry";

type Vendor = typeof vendor;

// Order evidence and a website become expected once a vendor has purchases.
// Every live vendor needs a logo independently of purchase history.
const hasLivePurchase = (t: Vendor) => sql`EXISTS (
  SELECT 1 FROM "Purchase" dq_ven_p
  WHERE dq_ven_p."vendorId" = ${t.id} AND dq_ven_p."deletedAt" IS NULL
)`;

// The logo is the vendor's one `logo` attachment (ADR 0006); a set but
// non-displayable image is the same as no logo.
const hasDisplayableLogo = (t: Vendor) => sql`EXISTS (
  SELECT 1 FROM "EntityAttachment" dq_ven_att
  JOIN "Image" dq_ven_img ON dq_ven_img."id" = dq_ven_att."imageId"
  WHERE dq_ven_att."entityId" = ${t.id} AND dq_ven_att."role" = 'logo'
    AND dq_ven_att."deletedAt" IS NULL AND dq_ven_img."deletedAt" IS NULL
    AND ${sql.raw(displayableImageRawSql("dq_ven_img"))}
)`;

export const vendorChecks = defineEntityChecks({
  entity: "vendor",
  table: vendor,
  checks: {
    vendor_order_evidence: {
      expected: hasLivePurchase,
      missing: (t) => sql`${t.orderEvidence} IS NULL`,
      fingerprint: (t) => [sql`${t.orderEvidence}`],
    },
    // Source classification only guides where to look; the itemization
    // expectation decides whether item lines are wanted. Expecting item lines
    // from a vendor that leaves no order evidence is the one contradiction;
    // an in-store shop whose receipts are sometimes kept (`receipt_only`)
    // with itemization `not_expected` is ordinary. Changing either value
    // resolves it, so no exception reason exists.
    vendor_order_evidence_conflict: {
      missing: (t) =>
        sql`(${t.orderEvidence} = 'not_expected' AND ${t.itemizationExpectation} = 'required')`,
      fingerprint: (t) => [
        sql`${t.orderEvidence}`,
        sql`${t.itemizationExpectation}`,
      ],
    },
    vendor_logo: {
      missing: (t) => sql`NOT ${hasDisplayableLogo(t)}`,
      // A new website is new evidence for a logo search.
      fingerprint: (t) => [sql`${t.website}`, hasDisplayableLogo(t)],
    },
    vendor_website: {
      expected: hasLivePurchase,
      missing: (t) => sql`(${t.website} IS NULL OR trim(${t.website}) = '')`,
      fingerprint: (t) => [sql`${t.name}`, sql`${t.website}`],
    },
  },
});
