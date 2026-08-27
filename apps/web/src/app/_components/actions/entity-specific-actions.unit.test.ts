import { describe, expect, it } from "vitest";
import {
  deleteDescriptionForEntity,
  deleteEntityActionDefinition,
} from "./delete-entity-action";
import { ingredientEntityActionDefinitions } from "./ingredient-entity-actions";
import { inventoryLocationEntityActionDefinitions } from "./inventory-location-entity-actions";
import { mergeEntityActionDefinitions } from "./merge-entity-actions";
import { productRosterEntityActionDefinitions } from "./product-roster-entity-actions";
import { recipeEntityActionDefinitions } from "./recipe-entity-actions";
import { specialistLifecycleEntityActionDefinitions } from "./specialist-lifecycle-entity-actions";

describe("entity-specific action definitions", () => {
  it("registers generated CRUD delete only on record surfaces", () => {
    expect(deleteEntityActionDefinition).toEqual(
      expect.objectContaining({
        verb: "delete",
        arity: "single",
        group: "destructive",
        surfaces: ["inspector", "detail"],
        entities: expect.arrayContaining([
          "product",
          "task",
          "financialAccount",
          "expense",
        ]),
      }),
    );
    expect(deleteEntityActionDefinition.entities).toHaveLength(14);
    expect(deleteDescriptionForEntity("task", { subtaskCount: 2 })).toBe(
      "This also deletes 2 subtasks, and removes the task from any dependency chains. This action cannot be undone.",
    );
  });

  it("keeps Recipe duplicate single-record and compare selection-only", () => {
    expect(recipeEntityActionDefinitions).toEqual([
      expect.objectContaining({
        verb: "duplicate",
        entities: ["recipe"],
        arity: "single",
        surfaces: ["row", "inspector", "detail"],
      }),
      expect.objectContaining({
        verb: "compare",
        entities: ["recipe"],
        arity: "multi",
        surfaces: ["selection"],
        preserveSelection: true,
      }),
    ]);
  });

  it("keeps Ingredient merge selection-only and staged", () => {
    expect(ingredientEntityActionDefinitions).toEqual([
      expect.objectContaining({
        verb: "merge",
        entities: ["ingredient"],
        arity: "multi",
        surfaces: ["selection"],
      }),
    ]);
    expect(ingredientEntityActionDefinitions[0]).not.toHaveProperty(
      "preserveSelection",
    );
  });

  it("uses one merge contract for Vendor and Purchase surfaces", () => {
    expect(mergeEntityActionDefinitions).toEqual([
      expect.objectContaining({
        verb: "merge",
        entities: ["vendor"],
        arity: "both",
        minSelection: 2,
      }),
      expect.objectContaining({
        verb: "merge",
        entities: ["purchase"],
        arity: "both",
        minSelection: 2,
      }),
    ]);
  });

  it("keeps Product roster actions reusable without exposing stock state blindly", () => {
    expect(productRosterEntityActionDefinitions).toEqual([
      expect.objectContaining({
        verb: "printLabels",
        surfaces: ["row", "selection", "inspector", "detail"],
      }),
      expect.objectContaining({
        verb: "setStockTracking",
        surfaces: ["selection"],
      }),
    ]);
  });

  it("centralizes reusable Inventory and Location actions", () => {
    expect(inventoryLocationEntityActionDefinitions).toEqual([
      expect.objectContaining({
        verb: "moveTo",
        entities: ["inventory"],
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      }),
      expect.objectContaining({
        verb: "printLabel",
        entities: ["location"],
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      }),
      expect.objectContaining({
        verb: "moveUnder",
        entities: ["location"],
        arity: "both",
        surfaces: ["row", "selection"],
      }),
    ]);
  });

  it("keeps Cookbook lifecycle deletion available to its canonical surfaces and Image record-only", () => {
    expect(specialistLifecycleEntityActionDefinitions).toEqual([
      expect.objectContaining({
        verb: "delete",
        entities: ["cookbook"],
        arity: "single",
        surfaces: ["row", "selection", "inspector", "detail"],
        group: "destructive",
      }),
      expect.objectContaining({
        verb: "delete",
        entities: ["image"],
        arity: "single",
        surfaces: ["inspector", "detail"],
        group: "destructive",
      }),
    ]);
  });
});
