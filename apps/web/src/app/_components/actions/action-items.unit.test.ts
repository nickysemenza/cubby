import { allEntities } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";
import { entities } from "~/entities/entities";
import { entityEmptyConfigForTest } from "../data-table/entity-empty-states";
import { actionsForSurface, createActionFor } from "./action-items";

describe("createActionFor", () => {
  it("uses the /new route when the entity has one", () => {
    expect(createActionFor("product")).toEqual({ to: "/products/new" });
  });

  // The bug this exists for: a dialog-created entity has no `/new` route, so
  // anything reading `routes.new` alone concluded it couldn't be created.
  it.each(["task", "project", "expense", "meal"] as const)(
    "resolves %s to its deep-linked create dialog",
    (entity) => {
      expect(
        "new" in entities[entity].routes
          ? entities[entity].routes.new
          : undefined,
      ).toBeUndefined();
      expect(createActionFor(entity)).toEqual({
        to: entities[entity].routes.list,
        search: { create: true },
      });
    },
  );

  it("returns null for an entity with no create affordance", () => {
    expect(createActionFor("usda-food")).toBeNull();
  });

  it.each(["ledgerParty", "ledgerTransfer"] as const)(
    "returns null for route-less %s",
    (entity) => {
      expect(createActionFor(entity)).toBeNull();
    },
  );

  it("never invents a target for an entity that has neither", () => {
    for (const entity of allEntities) {
      const target = createActionFor(entity);
      if (target === null) continue;
      expect(target.to.startsWith("/")).toBe(true);
    }
  });
});

/**
 * The guard that would have caught the dead call-to-actions: an empty state
 * declaring an `actionLabel` must have somewhere to send the click. Meal,
 * project and task each shipped a label that never rendered a button.
 */
describe("empty-state call-to-actions are reachable", () => {
  it.each(
    Object.entries(entityEmptyConfigForTest)
      .filter(([, config]) => config.actionLabel)
      .map(([entity, config]) => [entity, config.actionLabel] as const),
  )("%s (%s) resolves a create target", (entity) => {
    expect(createActionFor(entity as never)).not.toBeNull();
  });
});

describe("action surfaces", () => {
  it("keeps Home focused on four recurring household verbs", () => {
    expect(actionsForSurface("home-quick").map((action) => action.id)).toEqual([
      "recount",
      "photo-pass",
      "what-can-i-make",
      "shopping-list",
    ]);
  });
});
