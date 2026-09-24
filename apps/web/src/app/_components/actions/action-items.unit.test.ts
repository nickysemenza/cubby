import { allEntities } from "@cubby/schemas/entity-manifest";
import { browserRoutedEntities } from "@cubby/schemas/entity-manifest";
import {
  type EntityPresentation,
  entitySummary,
} from "@cubby/schemas/entity-summary";
import { describe, expect, it } from "vitest";

import { entities } from "~/entities/entities";

import {
  actionItems,
  actionsForSurface,
  createActionFor,
} from "./action-items";
import { verbDef } from "./action-verbs";

describe("createActionFor", () => {
  it("uses the /new route when the entity has one", () => {
    expect(createActionFor("recipe")).toEqual({ to: "/recipes/new" });
  });

  // The bug this exists for: a dialog-created entity has no `/new` route, so
  // anything reading `routes.new` alone concluded it couldn't be created.
  // Product joined this list once its rich create/edit form moved onto the
  // generic dialog (`route.create: "dialog"`).
  it.each(["task", "project", "expense", "meal", "product"] as const)(
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

  // Both are routed (list + detail pages), but neither carries a create
  // affordance — no `/new` route, no registered create action — so this still
  // isolates the "browser-routed, un-creatable" branch `createActionFor` guards.
  it.each(["ledgerParty", "ledgerTransfer"] as const)(
    "returns null for %s, which has no create affordance",
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
    browserRoutedEntities.flatMap((entity) => {
      const emptyState: EntityPresentation["emptyState"] =
        entitySummary[entity].emptyState;
      return emptyState.actionLabel === undefined
        ? []
        : [[entity, emptyState.actionLabel] as const];
    }),
  )("%s (%s) resolves a create target", (entity) => {
    const browserEntity = browserRoutedEntities.find(
      (candidate) => candidate === entity,
    );
    expect(browserEntity).toBeDefined();
    if (!browserEntity) throw new Error(`${entity} has no browser route`);
    expect(createActionFor(browserEntity)).not.toBeNull();
  });
});

describe("action registry", () => {
  it("has unique ids", () => {
    const ids = actionItems.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives each entity at most one create action", () => {
    const claimed = actionItems.flatMap((action) =>
      action.entity ? [action.entity] : [],
    );
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

describe("verb-backed actions single-source their presentation", () => {
  // The drift this closes: "Bulk Edit" and "Print Labels" shipped here in
  // Title Case against action-verbs.ts's documented sentence case, and Bulk
  // edit carried a different icon than the verb registry declares. Both
  // registries existed; they were simply never connected.
  const verbBacked = actionItems.filter((item) => item.verb !== undefined);

  it.each(verbBacked)("$id reads label and icon from the verb", (item) => {
    const verb = verbDef(item.verb!);
    expect(item.name).toBe(verb.label);
    expect(item.icon).toBe(verb.icon);
  });
});
