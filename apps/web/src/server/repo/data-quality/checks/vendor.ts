import { sql } from "drizzle-orm";

import { vendor } from "~/server/db/schema";
import { displayableImageRawSql } from "~/server/repo/image-displayability";

import { defineEntityChecks } from "../registry";

type Vendor = typeof vendor;

// A vendor is worth having identity evidence for only once it has actually
// been transacted with (mirrors `vendorPurchaseCount`, repo/vendor.ts).
const hasLivePurchase = (t: Vendor) => sql`EXISTS (
  SELECT 1 FROM "Purchase" dq_ven_p
  WHERE dq_ven_p."vendorId" = ${t.id} AND dq_ven_p."deletedAt" IS NULL
)`;

// The logo is the vendor's one `logo` attachment (ADR 0006); a set but
// non-displayable image is the same as no logo.
const hasDisplayableLogo = (t: Vendor) => sql`EXISTS (
  SELECT 1 FROM "EntityAttachment" dq_ven_att
  JOIN "Image" dq_ven_img ON dq_ven_img."id" = dq_ven_att."imageId"
  WHERE dq_ven_att."subjectEntityId" = ${t.id} AND dq_ven_att."role" = 'logo'
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
    },
    vendor_logo: {
      expected: hasLivePurchase,
      missing: (t) => sql`NOT ${hasDisplayableLogo(t)}`,
    },
    vendor_website: {
      expected: hasLivePurchase,
      missing: (t) => sql`(${t.website} IS NULL OR trim(${t.website}) = '')`,
    },
  },
});
