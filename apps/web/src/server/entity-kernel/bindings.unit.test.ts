import { SHORTCODE_PREFIX } from "@cubby/shared";
import { describe, expect, expectTypeOf, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { generatedEntityKernelContractCases } from "~/server/generated/entity-kernel-entities.gen";

import {
  ENTITY_KERNEL_ENTITIES,
  type EntityBrowserMutationCommand,
  entityCommandSchema,
  type EntityQueryCommand,
  type EntityResultFor,
  entityMutationResultSchema,
} from "./contracts";

const includesAction = (actions: readonly string[], action: string) =>
  actions.includes(action);

describe("entity kernel bindings", () => {
  it("correlates command entity and action with the exact result variant", () => {
    type ProductGetCommand = EntityQueryCommand & {
      action: "get";
      entity: "product";
    };
    type ProductGetResult = EntityResultFor<ProductGetCommand>;
    type ProductCreateCommand = Extract<
      EntityBrowserMutationCommand,
      { action: "create"; entity: "product" }
    >;
    type ProductCreateResult = EntityResultFor<ProductCreateCommand>;

    expectTypeOf<ProductGetResult>().toMatchTypeOf<{
      action: "get";
      entity: "product";
    }>();
    expectTypeOf<
      Extract<ProductGetResult, { entity: "image" }>
    >().toEqualTypeOf<never>();
    expectTypeOf<ProductCreateResult>().toMatchTypeOf<{
      action: "create";
      entity: "product";
    }>();
    expectTypeOf<
      Extract<ProductCreateResult, { action: "merge" }>
    >().toEqualTypeOf<never>();
  });

  it("has one complete binding for every advertised entity", () => {
    expect(Object.keys(ENTITY_KERNEL_BINDINGS).sort()).toEqual(
      [...ENTITY_KERNEL_ENTITIES].sort(),
    );
    expect(Object.keys(ENTITY_SCHEMA_BINDINGS).sort()).toEqual(
      [...ENTITY_KERNEL_ENTITIES].sort(),
    );

    for (const entity of ENTITY_KERNEL_ENTITIES) {
      const binding = ENTITY_KERNEL_BINDINGS[entity];
      expect(binding.entity).toBe(entity);
      expect(binding.sort.fields).toContain(binding.sort.default);
      expect(binding.lifecycle.delete).toBeDefined();
      expect(binding.schemas.id).toBeDefined();
      expect(binding.schemas.output).toBeDefined();
      expect(binding.schemas.detail).toBeDefined();
      expect(binding.schemas.list).toBeDefined();
      expect(binding.schemas.filters).toBeDefined();
      expect(binding.schemas).toBe(ENTITY_SCHEMA_BINDINGS[entity]);
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
      expect(
        entityMutationResultSchema.safeParse({
          action: "merge",
          entity: binding.entity,
          item: mock(binding.schemas.output, {
            seed: 1,
            overrides:
              binding.entity === "product" ? { externalIds: [] } : undefined,
          }),
          mergeSummary: { merged: 1 },
          sideEffects: { backgroundBatches: [] },
        }).success,
      ).toBe(true);
    }
  });

  it("models image as update-capable without inventing row creation", () => {
    const image = ENTITY_KERNEL_BINDINGS.image;
    expect(image.schemas.createInput).toBeNull();
    expect(image.repository.create).toBeUndefined();
    expect(image.schemas.updateInput).toBeDefined();
    expect(image.repository.update).toBeTypeOf("function");
  });

  it("matches generated action contracts to executable bindings", () => {
    for (const entity of ENTITY_KERNEL_ENTITIES) {
      const actions = generatedEntityKernelContractCases[entity].actions;
      const binding = ENTITY_KERNEL_BINDINGS[entity];
      expect(Boolean(binding.repository.create)).toBe(
        includesAction(actions, "create"),
      );
      expect(Boolean(binding.repository.update)).toBe(
        includesAction(actions, "update"),
      );
      expect(Boolean(binding.merge)).toBe(includesAction(actions, "merge"));
      const id = `${SHORTCODE_PREFIX[entity]}ABCD`;
      for (const action of actions) {
        let actionInput = {};
        if (action === "create") {
          const schema = binding.schemas.createInput;
          if (schema === null)
            throw new Error(`${entity} has no create schema`);
          actionInput = {
            data: mock(schema, {
              seed: 1,
              overrides:
                entity === "financialTransaction"
                  ? { kind: "purchase", amount: 1 }
                  : undefined,
            }),
          };
        } else if (action === "update") {
          const schema = binding.schemas.updateInput;
          if (schema === null)
            throw new Error(`${entity} has no update schema`);
          actionInput = { id, data: mock(schema, { seed: 1 }) };
        } else if (action === "get") {
          actionInput = { id };
        } else if (action === "delete") {
          actionInput = { ids: [id] };
        } else if (action === "search") {
          actionInput = { query: "needle" };
        } else if (action === "merge") {
          actionInput = { data: {} };
        }
        const parsed = entityCommandSchema.safeParse({
          entity,
          action,
          ...actionInput,
        });
        // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
        expect(
          parsed.success,
          parsed.success
            ? undefined
            : `${entity}.${action}: ${parsed.error.message}`,
        ).toBe(true);
      }
    }
  });
});
