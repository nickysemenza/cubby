import type { Entity } from "@cubby/schemas/entity";
import { describe, expect, it } from "vitest";
import {
  getEntityContract,
  listOnlyEntities,
  standardEntities,
} from "./entity-contracts";

// Guards the drift the "no tRPC router yet" stubs shipped with: every entity
// that claims a crud-factory-shaped contract (standard or list-only) must
// actually carry real mutations and non-empty invalidation keys, not a
// hand-rolled stub with `invalidationKeys: []`.
describe("entity-contracts drift guard", () => {
  const entitiesWithCrudContracts: Entity[] = [
    ...standardEntities,
    ...listOnlyEntities,
  ];

  it.each(
    entitiesWithCrudContracts,
  )("%s has real create/update/delete mutations and non-empty invalidation keys", (entity) => {
    const contract = getEntityContract(entity);

    expect(contract.mutation.create).toBeDefined();
    expect(contract.mutation.update).toBeDefined();
    expect(contract.mutation.delete).toBeDefined();
    expect(contract.invalidationKeys.length).toBeGreaterThan(0);
    expect(contract.mutation.invalidationKeys.length).toBeGreaterThan(0);
  });

  it.each(standardEntities)("%s can preview (has a detail page)", (entity) => {
    expect(getEntityContract(entity).canPreview).toBe(true);
  });

  it.each(
    listOnlyEntities,
  )("%s cannot preview (no detail page by design)", (entity) => {
    expect(getEntityContract(entity).canPreview).toBe(false);
  });
});
