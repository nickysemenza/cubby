import { describe, expect, it } from "vitest";
import { loadEntityDeclarations } from "../../../scripts/generator/entities/declarations";
import type {
  CompiledEntity,
  DeclarationObject,
} from "../../../scripts/generator/entities/declarations";
import {
  deriveInverseRelations,
  deriveRelationSections,
} from "../../../scripts/generator/entities/derive";

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

  // Regression: detail tables were opt-in, so a Task page never listed the
  // Plantings whose `taskId` points at it. Every `many` relation on a generic
  // detail page now renders a table or carries a written reason.
  it("renders or explicitly omits every many relation on a generic detail page", async () => {
    const entities = await load();
    const uncovered = [...entities.values()].flatMap((entity) => {
      if (entity.route?.detail == null) return [];
      const { sections, omitRelations } = entity.inspector.detail;
      const tabled = new Set(
        sections.flatMap((section) =>
          section.kind === "relation" ? [section.relation] : [],
        ),
      );
      return entity.relations
        .filter(
          (relation) =>
            relation.cardinality === "many" &&
            !tabled.has(relation.key) &&
            !(omitRelations[relation.key]?.trim().length ?? 0),
        )
        .map((relation) => `${entity.key}.${relation.key}`);
    });
    expect(uncovered).toEqual([]);
    const plantings = entities
      .get("task")
      ?.inspector.detail.sections.find(
        (section) =>
          section.kind === "relation" && section.relation === "plantings",
      );
    expect(plantings).toMatchObject({
      derived: true,
      collapseWhenEmpty: true,
      filter: { descriptor: "taskId" },
    });
  });

  // Regression: a self-relation's lone branded filter can scope the opposite
  // direction — `kitId` lists a kit's components, so resolving the product's
  // "containing kits" to it would show components instead of kits.
  it("never auto-resolves a self-relation to a filter another section uses", async () => {
    const entities = await load();
    const product = entities.get("product");
    if (product === undefined) throw new Error("Expected a product entity");
    const withoutKits: CompiledEntity = {
      ...product,
      inspector: {
        ...product.inspector,
        detail: {
          ...product.inspector.detail,
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
