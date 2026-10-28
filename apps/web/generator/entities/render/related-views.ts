import { generatedHeader } from "../../artifacts.ts";
import {
  EntityDeclarationError,
  type CompiledEntity,
  type EntityArtifacts,
} from "../declarations.ts";

export const compileRelatedViews = (entities: readonly CompiledEntity[]) => {
  const views = entities.flatMap((entity) =>
    entity.relations.flatMap((relation) => {
      const view = relation.view;
      if (view === undefined) return [];
      return [
        {
          key: `${entity.key}.${view.key ?? relation.key}`,
          source: entity.key,
          relationship: relation.key,
          target: relation.target,
          label: relation.label,
          defaultVisible: view.defaultVisible ?? false,
          order: view.order ?? "alphabetical",
          ...(view.columnGroup === undefined
            ? {}
            : { columnGroup: view.columnGroup }),
          ...(view.filterPrefix === undefined
            ? {}
            : { filterPrefix: view.filterPrefix }),
          ...(view.inverseKey === undefined
            ? {}
            : { inverseKey: view.inverseKey }),
          filter: view.filter !== false,
        },
      ];
    }),
  );
  const byKey = new Map(views.map((view) => [view.key, view]));
  if (byKey.size !== views.length)
    throw new EntityDeclarationError("Related view keys must be unique.");
  for (const view of views) {
    if (!view.inverseKey) continue;
    const inverse = byKey.get(view.inverseKey);
    if (
      !inverse ||
      inverse.source !== view.target ||
      inverse.target !== view.source ||
      inverse.inverseKey !== view.key
    )
      throw new EntityDeclarationError(
        `${view.key}.view.inverseKey must name a reciprocal related view.`,
      );
  }
  return views;
};

export const renderRelatedViewArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const views = compileRelatedViews(entities);
  const registry = views.map(({ filter: _filter, ...view }) => view);
  const filterEntries = entities.map((entity) => {
    const fields = new Map<string, string>();
    for (const view of views.filter(
      (candidate) => candidate.source === entity.key && candidate.filter,
    )) {
      const prefix = view.filterPrefix ?? view.target;
      const previous = fields.get(`${prefix}Id`);
      const id = `shortcodeSchema(${JSON.stringify(view.target)})`;
      // Member references retain @me in both scalar and multi-value filters.
      const value = entities.find((target) => target.key === view.target)
        ?.currentMember
        ? `partyFilter(${id})`
        : id;
      const ids = `z.union([${value}, z.array(${value})]).optional()`;
      if (previous !== undefined && previous !== ids)
        throw new EntityDeclarationError(
          `${entity.key} has conflicting related filter prefix ${prefix}.`,
        );
      fields.set(`${prefix}Id`, ids);
      fields.set(
        `${prefix}PresenceFilter`,
        'z.enum(["has", "none"]).optional()',
      );
      fields.set(`${prefix}Search`, "z.string().optional()");
    }
    return `${JSON.stringify(entity.key)}: {${[...fields].map(([key, value]) => `${JSON.stringify(key)}: ${value}`).join(",\n")}}`;
  });
  return [
    {
      relativePath: "packages/schemas/src/generated/related-views.gen.ts",
      source:
        generatedHeader +
        `export const relatedViewRegistry = ${JSON.stringify(registry, null, 2)} as const;\n`,
    },
    {
      relativePath:
        "packages/schemas/src/generated/related-view-filters.gen.ts",
      source:
        generatedHeader +
        'import { z } from "zod";\nimport { shortcodeSchema } from "../identifier-fields";\nimport { partyFilter } from "../pagination";\n\n' +
        `export const relatedFilterFieldsByEntity = {${filterEntries.join(",\n")}} as const;\n`,
    },
  ];
};
