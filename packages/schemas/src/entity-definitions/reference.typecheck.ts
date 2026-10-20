import { z } from "zod";

import { projectShortcode, taskShortcode } from "../identifier-fields";
import project from "./09-project.entity";
import { defineEntity, type EntityDeclaration } from "./definition";

const fixture = <
  const Field extends NonNullable<EntityDeclaration["model"]>["fields"][number],
>(
  field: Field,
) => ({
  ...project,
  model: {
    ...project.model,
    fields: [field],
    output: ["fixture" as const],
  },
});

const reference = <const Schema extends z.ZodType>(read: Schema) => ({
  key: "fixture" as const,
  kind: "identifier" as const,
  reference: { entity: "project" as const, multiple: true as const },
  validation: { read, create: null, update: null },
});

defineEntity(fixture(reference(z.array(projectShortcode).optional())));
defineEntity(
  fixture(
    reference(z.array(z.object({ id: projectShortcode, name: z.string() }))),
  ),
);
// @ts-expect-error The original regression: Project dependencies declared as Task references.
defineEntity(fixture(reference(z.array(taskShortcode))));
// @ts-expect-error Multiple references cannot read a scalar identifier.
defineEntity(fixture(reference(projectShortcode)));
// @ts-expect-error An enriched reference must carry the target entity's identifier.
defineEntity(fixture(reference(z.array(z.object({ id: taskShortcode })))));
// @ts-expect-error Plain strings discard the target entity's brand.
defineEntity(fixture(reference(z.array(z.string()))));

const single = {
  ...reference(projectShortcode.nullable()),
  reference: { entity: "project" as const },
};
defineEntity(fixture(single));
defineEntity(
  // @ts-expect-error Singular references cannot read identifier arrays.
  fixture({ ...single, validation: { read: z.array(projectShortcode) } }),
);
// @ts-expect-error A misspelled target is not a referenceable entity.
defineEntity(fixture({ ...single, reference: { entity: "projet" } }));
defineEntity(
  // @ts-expect-error Create schemas must agree with the reference target too.
  fixture({
    ...single,
    validation: { read: projectShortcode, create: taskShortcode },
  }),
);
defineEntity(
  // @ts-expect-error Update schemas must agree with the reference target too.
  fixture({
    ...single,
    validation: { read: projectShortcode, update: taskShortcode.optional() },
  }),
);

// Reference counts and expanded records are supported read projections.
defineEntity(
  fixture({ ...single, kind: "number", validation: { read: z.number() } }),
);
defineEntity(
  fixture({
    ...single,
    kind: "json",
    validation: { read: z.object({ id: projectShortcode }).nullable() },
  }),
);
// Storage-only references have no public validation schema to correlate.
defineEntity(
  fixture({
    key: "fixture",
    kind: "identifier",
    reference: { entity: "project" },
  }),
);
