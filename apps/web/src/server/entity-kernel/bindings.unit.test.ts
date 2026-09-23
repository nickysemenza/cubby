import type { Entity } from "@cubby/schemas/entity";
import { SHORTCODE_PREFIX } from "@cubby/shared";
import { describe, expect, expectTypeOf, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";
import {
  generatedMcpEntityCreateCommandSchema,
  generatedMcpEntityUpdateCommandSchema,
} from "~/server/generated/entity-bindings.gen";
import {
  ENTITY_KERNEL_BINDINGS,
  ENTITY_KERNEL_OPERATIONS,
} from "~/server/generated/entity-kernel-bindings.gen";
import { generatedEntityKernelContractCases } from "~/server/generated/entity-kernel-entities.gen";
import { generatedMcpEntityKernelContractCases } from "~/server/generated/entity-kernel-entities.gen";

import {
  ENTITY_KERNEL_ENTITIES,
  type EntityBrowserMutationCommand,
  entityCommandSchema,
  type EntityQueryCommand,
  entityDeleteResultSchema,
  entityMcpCommandSchema,
  entityMcpReadCommandSchema,
  type EntityResultFor,
  entityMutationResultSchema,
} from "./contracts";

const includesAction = (actions: readonly string[], action: string) =>
  actions.includes(action);

// Generic schema mocks cannot infer cross-field refinement invariants.
const createOverrides = (entity: Entity) =>
  entity === "financialTransaction"
    ? { kind: "purchase", amount: 1 }
    : entity === "expense"
      ? { date: "2026-01-02" }
      : undefined;

describe("entity kernel bindings", () => {
  describe("live MCP product commands", () => {
    const productData = {
      name: "Example product",
      aliases: [],
      tags: [],
      upc: null,
      isbn: null,
      fdc_id: null,
      manufacturer: "Example maker",
      model: null,
      notes: null,
      expectedQuantity: null,
      category: null,
      ingredientId: null,
      unitMappings: [],
      externalIds: [],
      usdaUnavailable: null,
      stockTracked: null,
    };

    it("accepts nullable identifiers and populated identifiers on create", () => {
      expect(
        generatedMcpEntityCreateCommandSchema.safeParse({
          action: "create",
          entity: "product",
          data: productData,
        }).success,
      ).toBe(true);
      expect(
        generatedMcpEntityCreateCommandSchema.safeParse({
          action: "create",
          entity: "product",
          data: {
            ...productData,
            upc: "00045242593057",
            ingredientId: "ING-ABCD",
          },
        }).success,
      ).toBe(true);
    });

    it("keeps product updates partial when identifiers are omitted", () => {
      expect(
        generatedMcpEntityUpdateCommandSchema.safeParse({
          action: "update",
          entity: "product",
          id: "PRD-ABCD",
          data: {},
        }).success,
      ).toBe(true);
    });
  });

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
      [...ENTITY_KERNEL_ENTITIES, "cookbook"].sort(),
    );
    // Cookbook's existing read contract has no generic mutation repository.
    const cookbook = ENTITY_SCHEMA_BINDINGS.cookbook;
    expect(cookbook.createInput).toBeNull();
    expect(cookbook.updateInput).toBeNull();
    expect(cookbook.bulkUpdateInput).toBeNull();
    expect(
      entityCommandSchema.safeParse({
        action: "create",
        entity: "cookbook",
        data: { name: "Example" },
      }).success,
    ).toBe(false);

    for (const entity of ENTITY_KERNEL_ENTITIES) {
      const binding = ENTITY_KERNEL_BINDINGS[entity];
      for (const action of [
        "get",
        "list",
        "create",
        "update",
        "delete",
        "bulkUpdate",
      ] as const) {
        expect(ENTITY_KERNEL_OPERATIONS[entity][action].definition.name).toBe(
          `${entity}.${action}`,
        );
      }
      expect(binding.entity).toBe(entity);
      expect(binding.sort.fields).toContain(binding.sort.default);
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
      "plant",
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

  it("requires concrete affected-edge counts on every delete result", () => {
    const result = {
      action: "delete" as const,
      entity: "project" as const,
      deletedReferences: [{ entity: "project" as const, id: "PRJ-4K7M" }],
      affectedEdges: [
        {
          edge: "ProjectImage.projectId",
          effect: "soft-delete" as const,
          changed: 2,
        },
      ],
      sideEffects: { backgroundBatches: [] },
    };
    expect(entityDeleteResultSchema.safeParse(result).success).toBe(true);
    expect(
      entityDeleteResultSchema.safeParse({
        ...result,
        affectedEdges: [{ ...result.affectedEdges[0], changed: null }],
      }).success,
    ).toBe(false);
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
              overrides: createOverrides(entity),
            }),
          };
        } else if (action === "update") {
          const schema = binding.schemas.updateInput;
          if (schema === null)
            throw new Error(`${entity} has no update schema`);
          actionInput = { id, data: mock(schema, { seed: 1 }) };
        } else if (action === "bulkUpdate") {
          const schema = binding.schemas.bulkUpdateInput;
          if (schema === null)
            throw new Error(`${entity} has no bulk update schema`);
          actionInput = { ids: [id], data: mock(schema, { seed: 1 }) };
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

  it("accepts exactly the generated MCP action exposure", () => {
    for (const entity of ENTITY_KERNEL_ENTITIES) {
      const executable = generatedEntityKernelContractCases[entity].actions;
      const exposed = generatedMcpEntityKernelContractCases[entity].actions;
      const binding = ENTITY_KERNEL_BINDINGS[entity];
      const id = `${SHORTCODE_PREFIX[entity]}ABCD`;

      for (const action of executable) {
        let actionInput = {};
        if (action === "create") {
          const schema = binding.schemas.createInput;
          if (schema === null)
            throw new Error(`${entity} has no create schema`);
          actionInput = {
            data: mock(schema, { seed: 2, overrides: createOverrides(entity) }),
          };
        } else if (action === "update") {
          const schema = binding.schemas.updateInput;
          if (schema === null)
            throw new Error(`${entity} has no update schema`);
          actionInput = { id, data: mock(schema, { seed: 2 }) };
        } else if (action === "bulkUpdate") {
          const schema = binding.schemas.bulkUpdateInput;
          if (schema === null)
            throw new Error(`${entity} has no bulk update schema`);
          actionInput = { ids: [id], data: mock(schema, { seed: 2 }) };
        } else if (action === "get") {
          actionInput = { id };
        } else if (action === "delete") {
          actionInput = { ids: [id] };
        } else if (action === "search") {
          actionInput = { query: "needle" };
        } else if (action === "merge") {
          actionInput = { data: {} };
        }

        const parsed = entityMcpCommandSchema.safeParse({
          entity,
          action,
          ...actionInput,
        });
        expect(parsed.success).toBe(includesAction(exposed, action));
      }
    }
  });

  it("uses strict entity-specific MCP list filters with common shortcode ids", () => {
    const parsed = entityMcpReadCommandSchema.parse({
      action: "list",
      entity: "product",
      filters: { ids: ["PRD-ABCD"] },
    });
    expect(parsed).toMatchObject({
      action: "list",
      entity: "product",
      filters: { ids: ["PRD-ABCD"] },
      resultDetail: "summary",
    });
    expect(
      entityMcpReadCommandSchema.safeParse({
        action: "list",
        entity: "product",
        filters: { definitelyNotAProductFilter: true },
      }).success,
    ).toBe(false);
    expect(
      entityMcpReadCommandSchema.safeParse({
        action: "list",
        entity: "meal",
        filters: { ids: ["PRD-ABCD"] },
      }).success,
    ).toBe(false);
  });

  it("uses one public relation command shape with relation-specific items", () => {
    const owner = {
      product: "PRD-ABCD",
      project: "PRJ-ABCD",
      purchase: "PUR-ABCD",
    } as const;
    const cases = [
      {
        entity: "product",
        relation: "components",
        items: [{ id: "PRD-BCDE" }],
      },
      {
        entity: "project",
        relation: "resources",
        items: [{ id: "PRD-BCDE" }],
      },
      {
        entity: "purchase",
        relation: "products",
        items: [{ id: "PRD-BCDE" }],
      },
    ] as const;

    for (const relationCase of cases) {
      expect(
        entityCommandSchema.safeParse({
          action: "attach",
          id: owner[relationCase.entity],
          ...relationCase,
        }).success,
      ).toBe(true);
    }

    expect(
      entityCommandSchema.safeParse({
        action: "attach",
        entity: "project",
        relation: "components",
        id: owner.project,
        items: [{ id: "PRD-BCDE" }],
      }).success,
    ).toBe(false);
    expect(
      entityCommandSchema.safeParse({
        action: "attach",
        entity: "purchase",
        relation: "products",
        id: owner.purchase,
        items: [{ id: "PRD-BCDE", quantity: 2 }],
      }).success,
    ).toBe(false);
  });
});
