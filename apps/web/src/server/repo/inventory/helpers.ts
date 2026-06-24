import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { locationType } from "@cubby/schemas/location";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { location, product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  addProductSourceMetadata,
  extractImagesFromJoinTable,
  notDeleted,
  parseInventoryAmount,
  unwrapDb,
} from "~/server/repo/database-helpers";
import type { InventoryEntryDeepDB } from "./types";

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
  if (targets.productId !== undefined) {
    const live = await client.query.product.findFirst({
      where: and(eq(product.id, targets.productId), notDeleted(product)),
      columns: { id: true },
    });
    if (!live) {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        `Product ${targets.productId} does not exist or has been deleted`,
      );
    }
  }
  if (targets.locationId !== undefined) {
    const live = await client.query.location.findFirst({
      where: and(eq(location.id, targets.locationId), notDeleted(location)),
      columns: { id: true },
    });
    if (!live) {
      throw createAppError(
        "LOCATION_NOT_FOUND",
        `Location ${targets.locationId} does not exist or has been deleted`,
      );
    }
  }
};

export const dbInventoryEntryToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { product, location, ...restOfInventoryEntry } = inventoryentry;
  const { type, images: locationImages, ...restOfLocation } = location;

  // Validate amount from JSON column
  const parsedAmount = parseInventoryAmount(
    restOfInventoryEntry.amount,
    restOfInventoryEntry.id,
  );

  return {
    ...restOfInventoryEntry,
    id: restOfInventoryEntry.id,
    amount: parsedAmount,
    location: {
      ...restOfLocation,
      id: restOfLocation.id,
      shortcode: unsafeLocationShortcode(restOfLocation.shortcode),
      type: parseWithContext(locationType, type, {
        entityType: "Location",
        identifier: { id: restOfLocation.id, name: restOfLocation.name },
      }),
      images: extractImagesFromJoinTable(locationImages),
    },
    product: {
      ...(() => {
        const { ingredientId: _ingredientId, ...rest } = product;
        return rest;
      })(),
      id: product.id,
      shortcode: unsafeProductShortcode(product.shortcode),
      unitMappings: addProductSourceMetadata(product.id, product.unitMappings),
      externalIds: product.externalIds.filter((eid) => eid.deletedAt === null),
      images: extractImagesFromJoinTable(product.images),
    },
  };
};
