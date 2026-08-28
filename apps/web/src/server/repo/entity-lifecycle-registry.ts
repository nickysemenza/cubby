/**
 * The single collected registry of every entity's removal-path operation
 * policies — one entry per `(entity, operation)` pair that has a
 * `*_DELETE_EDGE_POLICY` / `*_MERGE_EDGE_POLICY` (or `IMAGE_HARD_DELETE`),
 * naming every one of that entity's incoming edges and what the operation
 * does to it.
 *
 * This is production data, not a dev-only index: the entity-integrity service
 * flattens it into the `/entities?tab=integrity` catalog
 * that backs the introspection UI and impact planners, so they can answer
 * "what happens to each incoming edge of this entity under this operation?"
 * without reaching into a dozen repo files by hand.
 *
 * **This module only collects declarations — it does not execute them.**
 * Behavior stays operation-specific and per-repo, on purpose: the same
 * `Expense.purchaseId` edge is cleared (`detach`) on a purchase delete and
 * re-pointed (`repoint`) on a purchase merge (see `purchase.ts`), and a global
 * cascade/disposition on that edge would be wrong for one operation or the
 * other. Each policy constant listed here is still owned, defined, and
 * consumed (where it has a runtime consumer, e.g. `IMAGE_HARD_DELETE` in
 * `image.ts`) by its own repo file; this registry just assembles the
 * already-existing declarations into one place to read.
 *
 * `expense` and `inventory` have zero incoming edges (`INCOMING_EDGES.expense`
 * / `.inventory` are both `{}`) but a real (bulk, soft) delete operation, so
 * they get an explicit entry here with an empty `policy` rather than being
 * omitted — there is a `deleteExpenses`/`deleteInventoryEntries` operation,
 * it simply has nothing to disposition. `usda-food` has no local table and no
 * delete or merge operation at all (`entityManifest["usda-food"].lifecycle`
 * is `{ delete: null, merge: false }`), so — unlike the other two — it gets
 * no entry at all: there is no operation to attach one to.
 *
 * Coverage against `entityManifest[*].lifecycle` is enforced by
 * `entity-edge-operation-policies.unit.test.ts`: every entity whose
 * `lifecycle.delete` is non-null must have a `"delete"` entry here (and vice
 * versa), and likewise for `lifecycle.merge`.
 */

import type { Entity } from "@cubby/schemas/entity";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";

import { COOKBOOK_DELETE_EDGE_POLICY } from "~/server/repo/cookbook";
import { EXPENSE_DELETE_EDGE_POLICY } from "~/server/repo/expense/crud";
import { FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY } from "~/server/repo/financial-account";
import { FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY } from "~/server/repo/financial-transaction";
import { IMAGE_HARD_DELETE } from "~/server/repo/image";
import { INGREDIENT_DELETE_EDGE_POLICY } from "~/server/repo/ingredient/deletion";
import { INGREDIENT_MERGE_EDGE_POLICY } from "~/server/repo/ingredient/merge";
import {
  LEDGER_PARTY_DELETE_EDGE_POLICY,
  LEDGER_PARTY_MERGE_EDGE_POLICY,
} from "~/server/repo/ledger-party";
import { LEDGER_TRANSFER_DELETE_EDGE_POLICY } from "~/server/repo/ledger-transfer";
import { LOCATION_DELETE_EDGE_POLICY } from "~/server/repo/location/crud";
import { MEAL_DELETE_EDGE_POLICY } from "~/server/repo/meal/crud";
import { PRODUCT_DELETE_EDGE_POLICY } from "~/server/repo/product/edge-roles";
import { PRODUCT_MERGE_EDGE_POLICY } from "~/server/repo/product/merge";
import { PROJECT_DELETE_EDGE_POLICY } from "~/server/repo/project/crud";
import {
  PURCHASE_DELETE_EDGE_POLICY,
  PURCHASE_MERGE_EDGE_POLICY,
} from "~/server/repo/purchase";
import { RECIPE_DELETE_EDGE_POLICY } from "~/server/repo/recipe/crud";
import { TASK_DELETE_EDGE_POLICY } from "~/server/repo/task/crud";
import {
  VENDOR_DELETE_EDGE_POLICY,
  VENDOR_MERGE_EDGE_POLICY,
} from "~/server/repo/vendor";
import { WISH_DELETE_EDGE_POLICY } from "~/server/repo/wish";

/**
 * One `(entity, operation)` pair's declared edge dispositions, keyed by edge.
 * `policy` is widened to `Record<string, OperationDisposition>` rather than
 * each entity's own `IncomingEdgePolicy<E, ...>` — this registry only
 * *assembles* already-exhaustiveness-checked declarations (each one is typed
 * `satisfies IncomingEdgePolicy<E, OperationDisposition>` at its own
 * definition site), so it doesn't need to re-derive per-entity key
 * exhaustiveness here. A policy whose per-edge type is a superset of
 * `OperationDisposition` (see `PRODUCT_DELETE_EDGE_POLICY`'s extra
 * `reason`/`label` fields) still satisfies this structurally.
 */
export interface EntityLifecycleRegistryEntry {
  entity: Entity;
  operation: "delete" | "merge";
  policy: Record<string, OperationDisposition>;
}

export const ENTITY_LIFECYCLE_REGISTRY: EntityLifecycleRegistryEntry[] = [
  {
    entity: "ledgerParty",
    operation: "delete",
    policy: LEDGER_PARTY_DELETE_EDGE_POLICY,
  },
  {
    entity: "ledgerParty",
    operation: "merge",
    policy: LEDGER_PARTY_MERGE_EDGE_POLICY,
  },
  {
    entity: "ledgerTransfer",
    operation: "delete",
    policy: LEDGER_TRANSFER_DELETE_EDGE_POLICY,
  },
  {
    entity: "product",
    operation: "delete",
    policy: PRODUCT_DELETE_EDGE_POLICY,
  },
  {
    entity: "product",
    operation: "merge",
    policy: PRODUCT_MERGE_EDGE_POLICY,
  },
  { entity: "recipe", operation: "delete", policy: RECIPE_DELETE_EDGE_POLICY },
  {
    entity: "ingredient",
    operation: "delete",
    policy: INGREDIENT_DELETE_EDGE_POLICY,
  },
  {
    entity: "ingredient",
    operation: "merge",
    policy: INGREDIENT_MERGE_EDGE_POLICY,
  },
  {
    entity: "cookbook",
    operation: "delete",
    policy: COOKBOOK_DELETE_EDGE_POLICY,
  },
  {
    entity: "location",
    operation: "delete",
    policy: LOCATION_DELETE_EDGE_POLICY,
  },
  // Zero incoming edges (INCOMING_EDGES.inventory === {}), but
  // deleteInventoryEntries is a real (bulk, soft) delete op — declared
  // explicitly with an empty policy rather than omitted.
  { entity: "inventory", operation: "delete", policy: {} },
  { entity: "meal", operation: "delete", policy: MEAL_DELETE_EDGE_POLICY },
  {
    entity: "project",
    operation: "delete",
    policy: PROJECT_DELETE_EDGE_POLICY,
  },
  { entity: "task", operation: "delete", policy: TASK_DELETE_EDGE_POLICY },
  { entity: "vendor", operation: "delete", policy: VENDOR_DELETE_EDGE_POLICY },
  { entity: "vendor", operation: "merge", policy: VENDOR_MERGE_EDGE_POLICY },
  {
    entity: "purchase",
    operation: "delete",
    policy: PURCHASE_DELETE_EDGE_POLICY,
  },
  {
    entity: "purchase",
    operation: "merge",
    policy: PURCHASE_MERGE_EDGE_POLICY,
  },
  {
    entity: "expense",
    operation: "delete",
    policy: EXPENSE_DELETE_EDGE_POLICY,
  },
  {
    entity: "financialAccount",
    operation: "delete",
    policy: FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY,
  },
  {
    entity: "financialTransaction",
    operation: "delete",
    policy: FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY,
  },
  { entity: "wish", operation: "delete", policy: WISH_DELETE_EDGE_POLICY },
  { entity: "image", operation: "delete", policy: IMAGE_HARD_DELETE },
  // No entry for "usda-food": no local table, and no delete or merge
  // operation at all (entityManifest["usda-food"].lifecycle is
  // { delete: null, merge: false }) — there is no operation to attach one to.
];
