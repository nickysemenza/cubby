import { describe, expect, it } from "vitest";
import { loadEntityDeclarations } from "../generator/entities/declarations";
import type {
  CompiledEntity,
  DeclarationObject,
} from "../generator/entities/declarations";
import {
  deriveInverseRelations,
  deriveRelationSections,
} from "../generator/entities/derive";

const edge = (direction: "incoming" | "outgoing"): DeclarationObject => ({
  edge: "Planting.taskId",
  direction,
});

// The minimum a raw declaration needs for the inverse pass: names, relations,
// filters and the storage roster the stored back-filter must name.
const rawPair = (
  taskRelation: DeclarationObject = {},
  plantingFilters: DeclarationObject[] = [],
): DeclarationObject[] => [
  {
    key: "task",
    names: { singular: "Task", plural: "Tasks" },
    relations: [],
    filters: { descriptors: [] },
    model: { storage: [{ key: "id" }] },
  },
  {
    key: "planting",
    names: { singular: "Planting", plural: "Plantings" },
    relations: [
      {
        key: "task",
        label: "Task",
        target: "task",
        cardinality: "one",
        provenance: { kind: "local-path", steps: [edge("outgoing")] },
        inverse: { steps: [edge("incoming")] },
        ...taskRelation,
      },
    ],
    filters: { descriptors: plantingFilters },
    model: { storage: [{ key: "taskId", reference: "task" }] },
  },
];

describe("deriveInverseRelations", () => {
  it("derives a many inverse and its stored back-filter for a single-FK relation", () => {
    const [task, planting] = deriveInverseRelations(rawPair());
    expect(task).toMatchObject({
      relations: [
        {
          key: "plantings",
          label: "Plantings",
          target: "planting",
          cardinality: "many",
          derived: true,
        },
      ],
    });
    expect(planting).toMatchObject({
      filters: {
        descriptors: [
          {
            columnId: "taskId",
            brandRef: { entity: "task" },
            stored: true,
          },
        ],
      },
    });
  });

  it("leaves a declared back-filter alone and honours inverseOmit", () => {
    const declared = { columnId: "taskId", brandRef: { entity: "task" } };
    const [, planting] = deriveInverseRelations(rawPair({}, [declared]));
    expect(planting).toMatchObject({ filters: { descriptors: [declared] } });

    const [task] = deriveInverseRelations(
      rawPair({ inverseOmit: "Shown elsewhere." }),
    );
    expect(task).toMatchObject({ relations: [] });
  });

  it("reports an unbranded filter over the FK instead of shadowing it", () => {
    expect(() =>
      deriveInverseRelations(rawPair({}, [{ columnId: "taskId" }])),
    ).toThrow(/planting\.filters\.taskId scopes task\.plantings/);
  });
});

describe("relation coverage across the catalog", () => {
  const load = async () => {
    const entities = await loadEntityDeclarations();
    return new Map(entities.map((entity) => [entity.key, entity]));
  };

  it("never auto-resolves a self-relation to a filter another section uses", async () => {
    const entities = await load();
    const product = entities.get("product");
    if (product === undefined) throw new Error("Expected a product entity");
    const relationFilterOverrides = {
      ...product.inspector.detail.relationFilterOverrides,
    };
    delete relationFilterOverrides["containing-kits"];
    const withoutKits: CompiledEntity = {
      ...product,
      inspector: {
        ...product.inspector,
        detail: {
          ...product.inspector.detail,
          relationFilterOverrides,
          sections: product.inspector.detail.sections.filter(
            (section) =>
              section.kind !== "relation" ||
              section.relation !== "containing-kits",
          ),
        },
      },
    };
    expect(() =>
      deriveRelationSections([
        ...[...entities.values()].filter(({ key }) => key !== "product"),
        withoutKits,
      ]),
    ).toThrow(/product\.relations\[containing-kits\] renders no detail table/);
  });
});
