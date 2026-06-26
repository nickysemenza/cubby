/**
 * Location repository helper functions.
 * Includes DB-to-API transformations and utility functions.
 */

import { extractDbTimestampsFromDBRec } from "@cubby/schemas/common";
import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  type InfLocation,
  type LocationOut,
  type LocationOutWithParentChildren,
  locationType,
} from "@cubby/schemas/location";
import { parseWithContext } from "~/lib/zod-utils";
import type { image, location } from "~/server/db/schema";
import {
  extractImagesFromJoinTable,
  mapRelation,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";

import type { LocationDeepDB, LocationWithParentChild } from "./internal-types";

/**
 * Transform a location DB record to API format.
 * Handles shortcode branding, type parsing, and image extraction.
 */
export const dbLocationToAPI = (
  locationData: typeof location.$inferSelect & {
    images?: Array<{ image: typeof image.$inferSelect }>;
  },
): LocationOut => {
  return {
    id: locationData.id,
    shortcode: unsafeLocationShortcode(locationData.shortcode),
    lastBulkInventory: locationData.lastBulkInventory,
    aiDescription: locationData.aiDescription ?? null,
    name: locationData.name,
    type: parseWithContext(locationType, locationData.type, {
      entityType: "Location",
      identifier: { id: locationData.id, name: locationData.name },
    }),
    images: extractImagesFromJoinTable(locationData.images),
    valuation: locationData.valuation ?? null,
    ...extractDbTimestampsFromDBRec(locationData),
  };
};

/**
 * Transform a deeply nested location to API format with parent/children.
 */
export const dbLocationToAPIWithChildren = (
  locationData: LocationDeepDB,
): LocationOutWithParentChildren => {
  const { parent, children, inventoryEntries, ...restOfLocation } =
    locationData;

  return {
    ...dbLocationToAPI(restOfLocation),
    parent: parent ? dbLocationToAPI(parent) : null,
    children: mapRelation(children, dbLocationToAPI),
    inventoryEntries: mapRelation(inventoryEntries, (x) => {
      const { product, ...rest } = x;
      return {
        id: rest.id,
        amount: parseInventoryAmount(rest.amount, rest.id),
        valuation: rest.valuation,
        createdAt: rest.createdAt,
        updatedAt: rest.updatedAt,
        product: {
          id: product.id,
          shortcode: unsafeProductShortcode(product.shortcode),
          name: product.name,
          manufacturer: product.manufacturer,
          category: product.category,
          upc: product.upc,
          fdc_id: product.fdc_id,
          model: product.model,
          expectedQuantity: product.expectedQuantity,
          price: product.price,
          usdaUnavailable: product.usdaUnavailable,
          createdAt: product.createdAt,
          updatedAt: product.updatedAt,
        },
      };
    }),
  };
};

/**
 * Build a hierarchical InfLocation from a LocationWithParentChild record.
 * Recursively processes children and calculates item counts.
 */
export const buildLocationWithChildren = (
  x: LocationWithParentChild,
  excludeId?: string,
  includeParent = true,
): InfLocation => {
  const children =
    x.children && x.children.length > 0
      ? x.children
          .filter((child) => child.id !== excludeId && child.deletedAt === null)
          .map((child) =>
            buildLocationWithChildren(child, excludeId, includeParent),
          )
      : [];

  const directItemCount = x.directItemCount ?? 0;
  const childrenTotalCount = children.reduce(
    (sum, child) => sum + (child.totalItemCount ?? 0),
    0,
  );

  return {
    name: x.name,
    id: x.id,
    shortcode: unsafeLocationShortcode(x.shortcode),
    lastBulkInventory: x.lastBulkInventory,
    aiDescription: x.aiDescription ?? null,
    type: parseWithContext(locationType, x.type, {
      entityType: "Location",
      identifier: { id: x.id, name: x.name },
    }),
    images: extractImagesFromJoinTable(x.images),
    valuation: x.valuation ?? null,
    children,
    parent:
      includeParent && x.parent
        ? buildLocationWithChildren(x.parent, excludeId, includeParent)
        : undefined,
    childCount: x.childCount,
    directItemCount,
    totalItemCount: directItemCount + childrenTotalCount,
    inventoryItems: x.inventoryItems ?? [],
    ...extractDbTimestampsFromDBRec(x),
  };
};
