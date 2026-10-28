import { generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";

/** Only constrained references to canonical entity ids receive ordinary defaults. */
export const renderEntityEdgesArtifact = (
  entities: readonly CompiledEntity[],
): EntityArtifacts => {
  const targets = new Set(entities.map((entity) => entity.key));
  const imports = new Set<string>();
  const groups = entities.map((target) => {
    const defaults = entities.flatMap((source) => {
      const table = source.table;
      if (!table) return [];
      return source.fieldModel.storage.flatMap((field) => {
        if (
          field.kind !== "identifier" ||
          field.reference !== target.key ||
          !targets.has(field.reference) ||
          (field.referenceOptions?.column ?? "id") !== "id"
        )
          return [];
        imports.add(table.exportName);
        const edgeKey = `${table.name}.${field.column}`;
        const label = source.inspector.plural ?? source.inspector.singular;
        return [
          `    ${JSON.stringify(edgeKey)}: {
      column: ${table.exportName}.${field.key},
      role: "reference",
      label: ${JSON.stringify(label)},
      description: ${JSON.stringify(`${source.inspector.singular} ${field.key} references ${target.inspector.singular}.`)},
      liveness: { kind: "must-target-live" },
    },`,
        ];
      });
    });
    return `  ${JSON.stringify(target.key)}: {
    ...{
${defaults.join("\n")}
    },
    ...ENTITY_EDGE_OVERRIDES[${JSON.stringify(target.key)}],
  },`;
  });
  return {
    relativePath: "apps/web/src/server/db/generated/entity-edges.gen.ts",
    source:
      generatedHeader +
      'import type { Entity } from "@cubby/schemas/entity";\n' +
      'import { ENTITY_EDGE_OVERRIDES, type EntityEdge } from "../entity-edge-overrides";\n' +
      (imports.size
        ? `import { ${[...imports].sort().join(", ")} } from "~/server/db/generated/entity-table-definitions.gen";\n`
        : "") +
      `export const ENTITY_EDGES = {\n${groups.join("\n")}\n} as const satisfies Record<Entity, Record<string, EntityEdge>>;\n`,
  };
};
