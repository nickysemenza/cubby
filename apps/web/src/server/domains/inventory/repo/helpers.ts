import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  amountFromColumns,
  amountJsonSql,
  notDeleted,
  unwrapDb,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";

/**
 * `InventoryEntry.amount` as a `{ value, unit }` object in a `select`, for the
 * read projections that hand the amount on unchanged. Stored as two columns
 * (`amountValue`, `amountUnit`); `inventoryAuditRow` and `amountFromColumns`
 * cover rows already in memory.
 */
export const inventoryAmountSql = amountJsonSql(
  inventoryEntry.amountValue,
  inventoryEntry.amountUnit,
);

/**
 * The audited shape of an inventory row: `amount` is stored as a column pair
 * but audited (and shown in the timeline) as one `{ value, unit }`, so
 * `computeChanges` over `["amount"]` needs it as a single field.
 */
export const inventoryAuditRow = <
  T extends { amountValue: number; amountUnit: string },
>(
  row: T,
) => ({ ...row, amount: amountFromColumns(row) });

/**
 * Reject inventory writes whose target product/location is soft-deleted. Without
 * this, an entry can be created or re-pointed (single CRUD via crud.ts AND the
 * bulk process/move paths in bulk.ts) to a deleted parent — the entry stays live
 * but references a "gone" product/location, which then leaks into global search
 * (the symptom also guarded in repo/search.ts). Only the ids actually provided
 * are checked. Accepts a tx so bulk callers can validate inside their transaction.
 */
export const assertLiveTargets = async (
  db: Database | DrizzleTransaction,
  targets: { productId?: ProductId; locationId?: LocationId },
) => {
  const client = unwrapDb(db);
  const { productId, locationId } = targets;
  if (productId !== undefined) {
    const live = await client.query.product.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(eq(product.id, productId), notDeleted(product)),
          ),
      },
      columns: { id: true },
    });
    if (!live) {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        `Product ${targets.productId} does not exist or has been deleted`,
      );
    }
  }
  if (locationId !== undefined) {
    const live = await client.query.location.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(eq(location.id, locationId), notDeleted(location)),
          ),
      },
      columns: { id: true, parentId: true },
    });
    if (!live) {
      throw createAppError(
        "LOCATION_NOT_FOUND",
        `Location ${targets.locationId} does not exist or has been deleted`,
      );
    }
    if (live.parentId === null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Inventory cannot be placed directly at Home",
      );
    }
  }
};
