import { and, eq, isNull, notExists, type SQL, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import {
  cookbook,
  device,
  entityLink,
  expense,
  inventoryEntry,
  location,
  mealFoodEntry,
  photoGroupProposal,
  planting,
  product,
  runTarget,
  task,
} from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";
import { liveLinks } from "~/server/repo/entity-links";
import { effectiveTaskSubjectProductSql } from "~/server/repo/task-project-inheritance";

import {
  isRetainingEdgeKey,
  PRODUCT_EDGE_ROLES,
  type ProductRetainingEdgeKey,
} from "./edge-roles";
/** Orphan suggestions are not a saved predicate: delete eligibility must use the canonical incoming-edge policy. */
const PRODUCT_RETAINING_NOT_EXISTS = {
  "RunTarget.entityId": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(runTarget)
        .where(eq(runTarget.entityId, t.id)),
    ),
  "Planting.sourceProductId": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(planting)
        .where(and(eq(planting.sourceProductId, t.id), notDeleted(planting))),
    ),
  "InventoryEntry.productId": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(inventoryEntry)
        .where(
          and(eq(inventoryEntry.productId, t.id), notDeleted(inventoryEntry)),
        ),
    ),
  // Unlike the `productIdsWithExpenses` subquery in product/crud.ts, this
  // needs no `isNotNull(expense.productId)`: that one is an uncorrelated
  // NOT IN list, where a single NULL makes the whole predicate UNKNOWN. A
  // correlated `eq` simply never matches NULL.
  "Expense.productId": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(expense)
        .where(and(eq(expense.productId, t.id), notDeleted(expense))),
    ),
  "Task.subjectProductId": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(task)
        .where(
          and(eq(effectiveTaskSubjectProductSql(), t.id), notDeleted(task)),
        ),
    ),
  "EntityLink[projectTool].to": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(entityLink)
        .where(and(eq(entityLink.toEntityId, t.id), liveLinks("projectTool"))),
    ),
  "EntityLink[purchaseProduct].to": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(entityLink)
        .where(
          and(eq(entityLink.toEntityId, t.id), liveLinks("purchaseProduct")),
        ),
    ),
  "MealFoodEntry.productId": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(mealFoodEntry)
        .where(
          and(eq(mealFoodEntry.productId, t.id), notDeleted(mealFoodEntry)),
        ),
    ),
  "EntityLink[wishCandidate].to": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(entityLink)
        .where(
          and(eq(entityLink.toEntityId, t.id), liveLinks("wishCandidate")),
        ),
    ),
  "Location.productId": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(location)
        .where(and(eq(location.productId, t.id), notDeleted(location))),
    ),
  "Cookbook.productId": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(cookbook)
        .where(and(eq(cookbook.productId, t.id), notDeleted(cookbook))),
    ),
  "EntityLink[productComponent].to": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(entityLink)
        .where(
          and(eq(entityLink.toEntityId, t.id), liveLinks("productComponent")),
        ),
    ),
  "Device.productId": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(device)
        .where(and(eq(device.productId, t.id), notDeleted(device))),
    ),
  // Only a still-pending proposal intends to use the Product; a committed
  // one is history and must not hide an otherwise-orphaned Product forever.
  "PhotoGroupProposal.productId": (dbClient, t) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(photoGroupProposal)
        .where(
          and(
            eq(photoGroupProposal.productId, t.id),
            eq(photoGroupProposal.state, "proposed"),
          ),
        ),
    ),
} satisfies Record<
  ProductRetainingEdgeKey,
  (dbClient: QueryBuilder, t: typeof product) => SQL
>;

/** A suggestion predicate; canonical deletion still checks every incoming edge transactionally. */
export const orphanedProductCondition = (t: typeof product) => {
  const builder = new QueryBuilder();
  return and(
    isNull(t.ingredientId),
    ...Object.keys(PRODUCT_EDGE_ROLES)
      .filter(isRetainingEdgeKey)
      .map((key) => PRODUCT_RETAINING_NOT_EXISTS[key](builder, t)),
    notExists(
      builder
        .select({ id: sql`1` })
        .from(entityLink)
        .where(
          and(eq(entityLink.fromEntityId, t.id), liveLinks("productComponent")),
        ),
    ),
  )!;
};
