import { and, isNull, type SQL, sql } from "drizzle-orm";

import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { notDeleted } from "~/server/db/helpers/predicates";
import { product } from "~/server/db/schema";
import type { liveLinks } from "~/server/generic/entity-links/repo/entity-links";

import {
  isRetainingEdgeKey,
  PRODUCT_EDGE_ROLES,
  type ProductRetainingEdgeKey,
} from "./edge-roles";

const noLiveProductLink = (
  t: typeof product,
  kind: Parameters<typeof liveLinks>[0],
  end: "fromEntityId" | "toEntityId" = "toEntityId",
): SQL => sql`NOT EXISTS (
  SELECT 1 FROM "EntityLink" dq_orphan_link
  WHERE dq_orphan_link.${sql.identifier(end)} = ${t.id}
    AND dq_orphan_link."kind" = ${kind}
    AND ${notDeleted("dq_orphan_link")}
)`;

// Foreign-table references stay literal: relational list queries rewrite every
// Drizzle Column in predicates/orderings to the outer Product alias, but leave
// nested QueryBuilder wrappers opaque (including their outer Product refs).
const PRODUCT_RETAINING_NOT_EXISTS = {
  "ImportSourceProduct.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "ImportSourceProduct" dq_orphan_original
    WHERE dq_orphan_original."productId" = ${t.id}
  )`,
  "Planting.sourceProductId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Planting" dq_orphan_planting
    WHERE dq_orphan_planting."sourceProductId" = ${t.id}
      AND ${notDeleted("dq_orphan_planting")}
  )`,
  "InventoryEntry.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "InventoryEntry" dq_orphan_inventory
    WHERE dq_orphan_inventory."productId" = ${t.id}
      AND ${notDeleted("dq_orphan_inventory")}
  )`,
  "Expense.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Expense" dq_orphan_expense
    WHERE dq_orphan_expense."productId" = ${t.id}
      AND ${notDeleted("dq_orphan_expense")}
  )`,
  "Task.subjectProductId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Task" dq_orphan_task
    WHERE ${effectiveFieldSql("task", "subjectProductId", "dq_orphan_task")} = ${t.id}
      AND ${notDeleted("dq_orphan_task")}
  )`,
  "EntityLink[projectTool].to": (t) => noLiveProductLink(t, "projectTool"),
  "EntityLink[purchaseProduct].to": (t) =>
    noLiveProductLink(t, "purchaseProduct"),
  "MealFoodEntry.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "MealFoodEntry" dq_orphan_food
    WHERE dq_orphan_food."productId" = ${t.id}
      AND ${notDeleted("dq_orphan_food")}
  )`,
  "EntityLink[wishCandidate].to": (t) => noLiveProductLink(t, "wishCandidate"),
  "Location.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Location" dq_orphan_location
    WHERE dq_orphan_location."productId" = ${t.id}
      AND ${notDeleted("dq_orphan_location")}
  )`,
  "Cookbook.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Cookbook" dq_orphan_cookbook
    WHERE dq_orphan_cookbook."productId" = ${t.id}
      AND ${notDeleted("dq_orphan_cookbook")}
  )`,
  "EntityLink[productComponent].to": (t) =>
    noLiveProductLink(t, "productComponent"),
  "Device.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Device" dq_orphan_device
    WHERE dq_orphan_device."productId" = ${t.id}
      AND ${notDeleted("dq_orphan_device")}
  )`,
  // Committed proposals are history; only pending proposals retain a Product.
  "PhotoGroupProposal.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "PhotoGroupProposal" dq_orphan_photo
    WHERE dq_orphan_photo."productId" = ${t.id}
      AND dq_orphan_photo."state" = 'proposed'
  )`,
} satisfies Record<ProductRetainingEdgeKey, (t: typeof product) => SQL>;

/** A suggestion predicate; deletion checks every incoming edge transactionally. */
export const orphanedProductCondition = (t: typeof product) =>
  and(
    isNull(t.ingredientId),
    ...Object.keys(PRODUCT_EDGE_ROLES)
      .filter(isRetainingEdgeKey)
      .map((key) => PRODUCT_RETAINING_NOT_EXISTS[key](t)),
    noLiveProductLink(t, "productComponent", "fromEntityId"),
  )!;
