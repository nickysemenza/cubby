import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { GOOGLE_DRIVE_SOURCE, NOTION_SOURCE } from "@cubby/schemas/external-id";
import { financialAccountIdentityKind } from "@cubby/schemas/financial-account";
import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { amountJsonSql } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { inventoryEntry } from "~/server/db/schema";

/** Scalar adapters read only the saved row, a to-one link, or a two-row cardinality probe. */
export function nonColumnMutationScalar(
  entity: ShortcodeEntity,
  key: string,
): SQL | undefined {
  if (entity === "inventory" && key === "amount") {
    const saved = alias(inventoryEntry, "saved");
    return amountJsonSql(saved.amountValue, saved.amountUnit);
  }
  if (
    entity === "project" &&
    (key === "googleDriveFolderUrl" || key === "notionPageUrl")
  ) {
    const source =
      key === "googleDriveFolderUrl" ? GOOGLE_DRIVE_SOURCE : NOTION_SOURCE;
    const kind = key === "googleDriveFolderUrl" ? "folder" : "page";
    return sql`(SELECT link.url FROM "EntityExternalId" link WHERE link."entityId"=saved.id AND link.source=${source} AND link.kind=${kind} AND link."isPrimary"=true AND ${notDeleted("link")} LIMIT 1)`;
  }
  if (entity === "financialAccount" && key === "network")
    return sql`CASE WHEN saved.identity->>${"kind"}=${financialAccountIdentityKind.enum.credit_card} THEN saved.identity->>${key} END`;
  if (entity === "expense" && key === "vendor")
    return sql`(SELECT vendor.name FROM "Purchase" purchase JOIN "Vendor" vendor ON vendor.id=purchase."vendorId" AND ${notDeleted("vendor")} WHERE purchase.id=saved."purchaseId" AND ${notDeleted("purchase")})`;
  if (entity === "expense" && key === "orderId")
    return sql`(SELECT purchase."orderId" FROM "Purchase" purchase WHERE purchase.id=saved."purchaseId" AND ${notDeleted("purchase")})`;
  if (entity === "financialTransaction" && key === "purchaseId")
    return sql`(SELECT CASE WHEN count(*)=1 THEN min(link.shortcode) END FROM (SELECT purchase.shortcode FROM "FinancialTransactionAllocation" allocation JOIN "Purchase" purchase ON purchase.id=allocation."purchaseId" AND ${notDeleted("purchase")} WHERE allocation."transactionId"=saved.id AND ${notDeleted("allocation")} LIMIT 2) link)`;
  return undefined;
}
