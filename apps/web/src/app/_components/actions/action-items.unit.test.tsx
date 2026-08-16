import { allEntities } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";
import { entities } from "~/entities/entities";
import { entityEmptyConfigForTest } from "../data-table/entity-empty-states";
import {
  actionItems,
  actionsForSurface,
  createActionFor,
} from "./action-items";

describe("createActionFor", () => {
  it("uses the /new route when the entity has one", () => {
    expect(createActionFor("product")).toEqual({ to: "/products/new" });
  });

  // The bug this exists for: a dialog-created entity has no `/new` route, so
  // anything reading `routes.new` alone concluded it couldn't be created.
  it.each(["task", "project", "expense", "meal"] as const)(
    "resolves %s to its deep-linked create dialog",
    (entity) => {
      expect(entities[entity].routes.new).toBeUndefined();
      expect(createActionFor(entity)).toEqual({
        to: entities[entity].routes.list,
        search: { create: true },
      });
    },
  );

  it("returns null for an entity with no create affordance", () => {
    expect(createActionFor("usda-food")).toBeNull();
  });

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

describe("action registry", () => {
  it("has unique ids", () => {
    const ids = actionItems.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives each entity at most one create action", () => {
    const claimed = actionItems.flatMap((a) => (a.entity ? [a.entity] : []));
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("declares every action on at least one surface", () => {
    for (const action of actionItems) {
      expect(action.surfaces.length).toBeGreaterThan(0);
    }
  });

  it("keeps every surface non-empty", () => {
    for (const surface of [
      "navbar-create",
      "palette-quick",
      "inventory-page",
      "home-quick",
    ] as const) {
      expect(actionsForSurface(surface).length).toBeGreaterThan(0);
    }
  });
});
