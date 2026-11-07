import { sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { purchaseProductAcquisitionPairsSql } from "~/server/domains/purchase/repo/purchase-product-acquisition";

/** Known live acquisition counterparties; one row per Product and Purchase. */
export const productSellerPurchasesSql = sql`
  SELECT DISTINCT acquisitions."productId" AS owner, acquisitions."purchaseId", seller_vendor."id" AS seller
  FROM (${purchaseProductAcquisitionPairsSql}) acquisitions
  JOIN "Purchase" seller_purchase ON seller_purchase."id" = acquisitions."purchaseId" AND ${notDeleted("seller_purchase")}
  JOIN "Vendor" seller_vendor ON seller_vendor."id" = seller_purchase."vendorId" AND ${notDeleted("seller_vendor")}
`;

/** Memberships are distinct even when several acquisitions name one seller. */
export const productSellerMembershipsSql = sql`
  SELECT DISTINCT owner, seller FROM (${productSellerPurchasesSql}) acquisitions
`;
