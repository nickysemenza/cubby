import type { Entity } from "@cubby/schemas/entity";
import { describe, expect, it } from "vitest";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import { COOKBOOK_DELETE_EDGE_POLICY } from "~/server/repo/cookbook";
import { IMAGE_HARD_DELETE } from "~/server/repo/image";
import { INGREDIENT_DELETE_EDGE_POLICY } from "~/server/repo/ingredient/deletion";
import { INGREDIENT_MERGE_EDGE_POLICY } from "~/server/repo/ingredient/merge";
import { LOCATION_DELETE_EDGE_POLICY } from "~/server/repo/location/crud";
import { MEAL_DELETE_EDGE_POLICY } from "~/server/repo/meal/crud";
import { PRODUCT_EDGE_ROLES } from "~/server/repo/product/edge-roles";
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

interface PolicyCase {
  entity: Entity;
  policy: Record<string, unknown>;
}

const POLICY_CASES = {
  "cookbook delete": {
    entity: "cookbook",
    policy: COOKBOOK_DELETE_EDGE_POLICY,
  },
  "image hard delete": { entity: "image", policy: IMAGE_HARD_DELETE },
  "recipe delete": { entity: "recipe", policy: RECIPE_DELETE_EDGE_POLICY },
  "ingredient delete": {
    entity: "ingredient",
    policy: INGREDIENT_DELETE_EDGE_POLICY,
  },
  "ingredient merge": {
    entity: "ingredient",
    policy: INGREDIENT_MERGE_EDGE_POLICY,
  },
  "meal delete": { entity: "meal", policy: MEAL_DELETE_EDGE_POLICY },
  "product retention/orphaning": {
    entity: "product",
    policy: PRODUCT_EDGE_ROLES,
  },
  "location delete": {
    entity: "location",
    policy: LOCATION_DELETE_EDGE_POLICY,
  },
  "project delete": {
    entity: "project",
    policy: PROJECT_DELETE_EDGE_POLICY,
  },
  "task delete": { entity: "task", policy: TASK_DELETE_EDGE_POLICY },
  "vendor delete": { entity: "vendor", policy: VENDOR_DELETE_EDGE_POLICY },
  "vendor merge": { entity: "vendor", policy: VENDOR_MERGE_EDGE_POLICY },
  "purchase delete": {
    entity: "purchase",
    policy: PURCHASE_DELETE_EDGE_POLICY,
  },
  "purchase merge": {
    entity: "purchase",
    policy: PURCHASE_MERGE_EDGE_POLICY,
  },
} as const satisfies Record<string, PolicyCase>;

describe("incoming-edge operation policies", () => {
  for (const [operation, { entity, policy }] of Object.entries(POLICY_CASES)) {
    it(`${operation} classifies every ${entity} incoming edge exactly once`, () => {
      expect(Object.keys(policy).sort()).toEqual(
        Object.keys(INCOMING_EDGES[entity]).sort(),
      );
    });
  }
});
