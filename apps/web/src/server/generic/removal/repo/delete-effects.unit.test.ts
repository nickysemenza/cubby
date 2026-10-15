import { describe, expect, it } from "vitest";

import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { generatedEntityKernelEntities } from "~/server/generated/entity-kernel-entities.gen";

import { calculateAffectedDeleteEdges } from "./delete-effects";

describe("generic delete effects", () => {
  it("calculates exact counts for every generated delete edge and effect family", () => {
    const coveredEffects = new Set<string>();

    for (const entity of generatedEntityKernelEntities) {
      const policy = ENTITY_KERNEL_BINDINGS[entity].lifecycle.delete;
      const edges = Object.keys(policy);
      const before = new Map(edges.map((edge, index) => [edge, index + 3]));
      const after = new Map(edges.map((edge) => [edge, 1]));

      const result = calculateAffectedDeleteEdges(policy, before, after);
      expect(result.map(({ edge }) => edge)).toEqual(edges);

      for (const [index, affected] of result.entries()) {
        coveredEffects.add(affected.effect);
        expect(affected.changed).toBe(
          affected.effect === "block" || affected.effect === "preserve"
            ? 0
            : index + 2,
        );
      }
    }

    expect(coveredEffects).toEqual(
      new Set(["block", "detach", "hard-delete", "preserve", "soft-delete"]),
    );
  });
});
