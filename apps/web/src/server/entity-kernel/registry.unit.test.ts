import { SHORTCODE_PREFIX } from "@cubby/shared";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { generatedEntityKernelContractCases } from "~/server/generated/entity-kernel-entities.gen";
import { ENTITY_KERNEL_ENTITIES, entityCommandSchema } from "./contracts";
import { ENTITY_KERNEL_BINDINGS } from "./registry";

describe("entity kernel registry", () => {
  it("has one complete binding for every advertised entity", () => {
    expect(Object.keys(ENTITY_KERNEL_BINDINGS).sort()).toEqual(
      [...ENTITY_KERNEL_ENTITIES].sort(),
    );

    for (const entity of ENTITY_KERNEL_ENTITIES) {
      const binding = ENTITY_KERNEL_BINDINGS[entity];
      expect(binding.entity).toBe(entity);
      expect(binding.sort.fields).toContain(binding.sort.default);
      expect(binding.lifecycle.delete).toBeDefined();
      expect(binding.schemas.id).toBeDefined();
      expect(binding.schemas.output).toBeDefined();
    }
  });

  it("keeps merge capability and incoming-edge policy inseparable", () => {
    const mergeable = Object.values(ENTITY_KERNEL_BINDINGS).filter(
      (binding) => binding.merge,
    );
    expect(mergeable.map((binding) => binding.entity).sort()).toEqual([
      "ingredient",
      "ledgerParty",
      "product",
      "purchase",
      "vendor",
    ]);
    for (const binding of mergeable) {
      expect(binding.lifecycle.merge).toBeDefined();
    }
  });

  it("matches generated action contracts to executable bindings", () => {
    const samples = {
      get: {},
      list: {},
      search: { query: "needle" },
      create: {},
      update: {},
      delete: {},
      merge: { data: {} },
    } as const;

    for (const [entity, contractCase] of Object.entries(
      generatedEntityKernelContractCases,
    )) {
      const actions = contractCase.actions as readonly (keyof typeof samples)[];
      const binding =
        ENTITY_KERNEL_BINDINGS[entity as keyof typeof ENTITY_KERNEL_BINDINGS];
      expect(Boolean(binding.repository.create)).toBe(
        actions.includes("create"),
      );
      expect(Boolean(binding.repository.update)).toBe(
        actions.includes("update"),
      );
      expect(Boolean(binding.merge)).toBe(actions.includes("merge"));
      const id = `${SHORTCODE_PREFIX[entity as keyof typeof SHORTCODE_PREFIX]}ABCD`;
      for (const action of actions) {
        const actionInput =
          action === "create"
            ? { data: mock(binding.schemas.create!) }
            : action === "update"
              ? { id, data: mock(binding.schemas.update!) }
              : action === "get"
                ? { id }
                : action === "delete"
                  ? { ids: [id] }
                  : samples[action];
        expect(
          entityCommandSchema.safeParse({ entity, action, ...actionInput })
            .success,
        ).toBe(true);
      }
    }
  });
});
