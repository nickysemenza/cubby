import type { Entity } from "@cubby/schemas/entity";
import { countableEntities } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";
import { queryKeys } from "~/lib/query-keys";
import {
  type EntityDetailRoute,
  type EntityListRoute,
  type EntityNewRoute,
  entities,
  isBrowserRoutedEntity,
} from "./entities";
import { getEntityContract, standardEntities } from "./entity-contracts";

// Guards the drift the "no tRPC router yet" stubs shipped with: every entity
// that claims a crud-factory-shaped standard contract must actually carry
// real mutations and non-empty invalidation keys, not a hand-rolled stub with
// `invalidationKeys: []`.
describe("entity-contracts drift guard", () => {
  const entitiesWithCrudContracts: Entity[] = [...standardEntities];

  it.each(entitiesWithCrudContracts)(
    "%s has real create/update/delete mutations and non-empty invalidation keys",
    (entity) => {
      const contract = getEntityContract(entity);

      expect(contract.mutation.create).toBeDefined();
      expect(contract.mutation.update).toBeDefined();
      expect(contract.mutation.delete).toBeDefined();
      expect(contract.invalidationKeys.length).toBeGreaterThan(0);
      expect(contract.mutation.invalidationKeys.length).toBeGreaterThan(0);
    },
  );

  it.each(standardEntities)("%s can preview (has a detail page)", (entity) => {
    expect(getEntityContract(entity).canPreview).toBe(true);
  });

  it.each(countableEntities)(
    "%s mutations invalidate the shared dashboard count",
    (entity) => {
      expect(getEntityContract(entity).invalidationKeys).toContainEqual(
        queryKeys.dashboard.counts,
      );
    },
  );
});

describe("derived entity route unions", () => {
  it("keeps route-less ledger entities out of browser route capability", () => {
    expect(isBrowserRoutedEntity("ledgerParty")).toBe(false);
    expect(isBrowserRoutedEntity("ledgerTransfer")).toBe(false);
    expect(isBrowserRoutedEntity("project")).toBe(true);
  });

  it("preserves detail, list, and new route literals", () => {
    const detail: EntityDetailRoute = entities.recipe.routes.detail;
    const list: EntityListRoute = entities.project.routes.list;
    const create: EntityNewRoute = entities.location.routes.new;

    expect([detail, list, create]).toEqual([
      "/recipes/$shortcode",
      "/projects",
      "/locations/new",
    ]);
  });
});
