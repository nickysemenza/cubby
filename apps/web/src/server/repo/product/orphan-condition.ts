import { and, isNull, type SQL, sql } from "drizzle-orm";

import { product } from "~/server/db/schema";
import type { liveLinks } from "~/server/repo/entity-links";
import { effectiveTaskSubjectProductSql } from "~/server/repo/task-project-inheritance";

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
    AND dq_orphan_link."deletedAt" IS NULL
)`;

// Foreign-table references stay literal: relational list queries rewrite every
// Drizzle Column in predicates/orderings to the outer Product alias, but leave
// nested QueryBuilder wrappers opaque (including their outer Product refs).
const PRODUCT_RETAINING_NOT_EXISTS = {
  "ImportSourceProduct.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "ImportSourceProduct" dq_orphan_original
    WHERE dq_orphan_original."productId" = ${t.id}
  )`,
  "RunTarget.entityId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "RunTarget" dq_orphan_target
    WHERE dq_orphan_target."entityId" = ${t.id}
  )`,
  "Planting.sourceProductId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Planting" dq_orphan_planting
    WHERE dq_orphan_planting."sourceProductId" = ${t.id}
      AND dq_orphan_planting."deletedAt" IS NULL
  )`,
  "InventoryEntry.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "InventoryEntry" dq_orphan_inventory
    WHERE dq_orphan_inventory."productId" = ${t.id}
      AND dq_orphan_inventory."deletedAt" IS NULL
  )`,
  "Expense.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Expense" dq_orphan_expense
    WHERE dq_orphan_expense."productId" = ${t.id}
      AND dq_orphan_expense."deletedAt" IS NULL
  )`,
  "Task.subjectProductId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Task" dq_orphan_task
    WHERE ${effectiveTaskSubjectProductSql("dq_orphan_task")} = ${t.id}
      AND dq_orphan_task."deletedAt" IS NULL
  )`,
  "EntityLink[projectTool].to": (t) => noLiveProductLink(t, "projectTool"),
  "EntityLink[purchaseProduct].to": (t) =>
    noLiveProductLink(t, "purchaseProduct"),
  "MealFoodEntry.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "MealFoodEntry" dq_orphan_food
    WHERE dq_orphan_food."productId" = ${t.id}
      AND dq_orphan_food."deletedAt" IS NULL
  )`,
  "EntityLink[wishCandidate].to": (t) => noLiveProductLink(t, "wishCandidate"),
  "Location.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Location" dq_orphan_location
    WHERE dq_orphan_location."productId" = ${t.id}
      AND dq_orphan_location."deletedAt" IS NULL
  )`,
  "Cookbook.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Cookbook" dq_orphan_cookbook
    WHERE dq_orphan_cookbook."productId" = ${t.id}
      AND dq_orphan_cookbook."deletedAt" IS NULL
  )`,
  "EntityLink[productComponent].to": (t) =>
    noLiveProductLink(t, "productComponent"),
  "Device.productId": (t) => sql`NOT EXISTS (
    SELECT 1 FROM "Device" dq_orphan_device
    WHERE dq_orphan_device."productId" = ${t.id}
      AND dq_orphan_device."deletedAt" IS NULL
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
