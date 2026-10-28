import { z } from "zod";

import { projectShortcode, taskShortcode } from "../identifier-fields";
import project from "./09-project.entity";
import { defineEntity, type EntityDeclaration } from "./definition";
import { createRelationships } from "./relationships";
import { definition as plantingDefinition } from "./19-planting.entity";
import { definition as plantDefinition } from "./26-plant.entity";

const fixture = <
  const Field extends NonNullable<EntityDeclaration["model"]>["fields"][number],
>(
  field: Field,
) => ({
  ...project,
  model: {
    ...project.model,
    fields: [field],
  },
});

const reference = <const Schema extends z.ZodType>(read: Schema) => ({
  key: "fixture" as const,
  kind: "identifier" as const,
  reference: { entity: "project" as const, multiple: true as const },
  validation: { read, create: null, update: null },
});

defineEntity(
  fixture(reference(z.array(projectShortcode).optional())),
  () => [],
);
defineEntity(
  fixture(
    reference(z.array(z.object({ id: projectShortcode, name: z.string() }))),
  ),
  () => [],
);
// @ts-expect-error The original regression: Project dependencies declared as Task references.
defineEntity(fixture(reference(z.array(taskShortcode))), () => []);
// @ts-expect-error Multiple references cannot read a scalar identifier.
defineEntity(fixture(reference(projectShortcode)), () => []);
defineEntity(
  // @ts-expect-error An enriched reference must carry the target entity's identifier.
  fixture(reference(z.array(z.object({ id: taskShortcode })))),
  () => [],
);
// @ts-expect-error Plain strings discard the target entity's brand.
defineEntity(fixture(reference(z.array(z.string()))), () => []);

const single = {
  ...reference(projectShortcode.nullable()),
  reference: { entity: "project" as const },
};
defineEntity(fixture(single), () => []);
defineEntity(
  // @ts-expect-error Singular references cannot read identifier arrays.
  fixture({ ...single, validation: { read: z.array(projectShortcode) } }),
  () => [],
);
// @ts-expect-error A misspelled target is not a referenceable entity.
defineEntity(fixture({ ...single, reference: { entity: "projet" } }), () => []);
defineEntity(
  // @ts-expect-error Create schemas must agree with the reference target too.
  fixture({
    ...single,
    validation: { read: projectShortcode, create: taskShortcode },
  }),
  () => [],
);
defineEntity(
  // @ts-expect-error Update schemas must agree with the reference target too.
  fixture({
    ...single,
    validation: { read: projectShortcode, update: taskShortcode.optional() },
  }),
  () => [],
);

// Reference counts and expanded records are supported read projections.
defineEntity(
  fixture({ ...single, kind: "number", validation: { read: z.number() } }),
  () => [],
);
defineEntity(
  fixture({
    ...single,
    kind: "json",
    validation: { read: z.object({ id: projectShortcode }).nullable() },
  }),
  () => [],
);
// Storage-only references have no public validation schema to correlate.
defineEntity(
  fixture({
    key: "fixture",
    kind: "identifier",
    reference: { entity: "project" },
  }),
  () => [],
);

// Paths retain the identity of each endpoint instead of accepting unrelated UUID-shaped references.
const plantingRelations = createRelationships(plantingDefinition);
const plantRelations = createRelationships(plantDefinition);
const plantStep = [
  { edge: "Planting.plantId", direction: "outgoing" },
] as const;
plantingRelations.path("plant", "one", plantStep);
plantingRelations
  .field("plantId")
  .through(plantRelations.field("ingredientId"));
// @ts-expect-error Ordinary scalar fields are not physical reference relationships.
plantingRelations.field("status");
// @ts-expect-error The path reaches Plant, not Vendor.
plantingRelations.path("vendor", "one", plantStep);
// @ts-expect-error Table-less external entities cannot be reached through physical storage paths.
plantingRelations.path("usda-food", "one", plantStep);
const wrongDirection = [
  { edge: "Planting.plantId", direction: "incoming" },
] as const;
// @ts-expect-error The first hop cannot run against its declared direction.
plantingRelations.path("plant", "one", wrongDirection);
const unknownEdge = [
  { edge: "Planting.missingId", direction: "outgoing" },
] as const;
// @ts-expect-error Physical edge names come from source-owned reference fields.
plantingRelations.path("plant", "one", unknownEdge);
const brokenChain = [
  ...plantStep,
  { edge: "Task.projectId", direction: "outgoing" },
] as const;
// @ts-expect-error A path cannot jump from Plant to an unrelated Task edge.
plantingRelations.path("project", "many", brokenChain);
const plantingPlant = plantingRelations.field("plantId");
// @ts-expect-error A composed handle must start where the first handle ends.
plantingPlant.through(plantingPlant);
// @ts-expect-error Link orientation is checked against the owning entity.
plantingRelations.link("gardenEntryPlanting", "outgoing");
// @ts-expect-error Named query endpoints are owned by their source declaration.
plantingRelations.query("vendorEmails", "many");

const projectedReference = createRelationships({
  key: "plant",
  table: "Plant",
  model: {
    fields: [
      { key: "productCount", kind: "number", reference: { entity: "product" } },
    ],
    storage: ["productCount"],
  },
});
// @ts-expect-error A numeric related-record count is not a physical foreign key.
projectedReference.field("productCount");
const unconstrainedReference = createRelationships({
  key: "plant",
  table: "Plant",
  model: {
    fields: [
      {
        key: "productId",
        kind: "identifier",
        reference: { entity: "product" },
      },
    ],
    storage: [{ key: "productId", reference: null }],
  },
});
// @ts-expect-error An explicit storage opt-out cannot become a constrained field path.
unconstrainedReference.field("productId");
