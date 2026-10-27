import { renderEmbeddedField } from "./embedded-field.ts";
import { z } from "zod";
import { generatedHeader } from "../../artifacts.ts";
import {
  declarationModules,
  EntityDeclarationError,
  type CompiledEntity,
  type EntityArtifacts,
} from "../declarations.ts";

/** The declaration owns whether a field needs assignment or derivation facts. */
const governedFields = (entity: CompiledEntity) =>
  entity.fieldModel.fields.filter(
    (field) =>
      field.resolution !== null ||
      field.provenance?.kind === "derived" ||
      (field.control?.suggest !== null &&
        field.control?.suggest !== undefined) ||
      Object.hasOwn(entity.fieldModel.derived, field.key) ||
      Object.hasOwn(entity.fieldModel.stored, field.key),
  );

/** Concrete value schemas are retained; the wire has no JSON-valued field map. */
export const renderFieldEnvelopeArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const imports: string[] = [];
  const bindings: string[] = [];
  const fieldBindings: string[] = [];
  const nestedBindings: string[] = [];
  const assignmentBindings: string[] = [];
  const projectorImports: string[] = [];
  const projectorBindings: string[] = [];
  const artifacts = entities.flatMap((entity) => {
    if (entity.contract === null) return [];
    const declaration = declarationModules.get(entity.key);
    if (declaration === undefined)
      throw new EntityDeclarationError(
        `${entity.key} has no declaration module for field envelopes.`,
      );
    const fields = governedFields(entity);
    const projector = entity.ports.fieldEnvelope;
    if (projector) {
      const local = `${entity.key}FieldEnvelopeProjector`;
      projectorImports.push(
        `import { ${projector.export} as ${local} } from ${JSON.stringify(projector.module)};`,
      );
      projectorBindings.push(`${JSON.stringify(entity.key)}:${local}`);
    }
    const assignmentKeys: string[] = [];
    const entries = fields.map((field) => {
      // Collection updates may contain patch operations; saved intent contains
      // the complete value, as does the existing structured editor's create schema.
      const mode =
        (field.collection || field.reference?.multiple === true) &&
        entity.fieldModel.create.includes(field.key)
          ? "create"
          : entity.fieldModel.update.includes(field.key)
            ? "update"
            : entity.fieldModel.create.includes(field.key)
              ? "create"
              : null;
      if (mode !== null) assignmentKeys.push(field.key);
      const schema =
        mode === null ? "null" : `stored.${mode}[${JSON.stringify(field.key)}]`;
      return `${JSON.stringify(field.readKey ?? field.key)}:${schema}`;
    });
    assignmentBindings.push(
      `${JSON.stringify(entity.key)}:${JSON.stringify(assignmentKeys)}`,
    );
    // Quality and display images are synthesized by the existing read/media
    // decorators and do not need hand-written per-entity declarations.
    if (!fields.some((field) => (field.readKey ?? field.key) === "dataQuality"))
      entries.push("dataQuality:null");
    if (
      !fields.some((field) => (field.readKey ?? field.key) === "displayImages")
    )
      entries.push("displayImages:null");
    const hasStored = entries.some((entry) => entry.includes("stored."));
    const name = entity.key.replaceAll(/-([a-z])/gu, (_, letter: string) =>
      letter.toUpperCase(),
    );
    imports.push(
      `import { ${name}FieldEnvelopeSchemas, ${name}FieldEnvelopeFields } from "./entity-field-envelopes.${entity.key}.gen";`,
    );
    bindings.push(`${JSON.stringify(entity.key)}:${name}FieldEnvelopeSchemas`);
    fieldBindings.push(
      `${JSON.stringify(entity.key)}:${name}FieldEnvelopeFields`,
    );
    const readImports = [
      ["output", entity.contract.output],
      ["list", entity.contract.list],
      ["detail", entity.contract.detail],
      ["mcpOutput", entity.contract.mcpOutput],
      ["mcpList", entity.contract.mcpList],
      ["mcpDetail", entity.contract.mcpDetail],
    ] as const;
    const nested = entity.contract.embedded;
    const nestedTargets = [...new Set(nested.map((binding) => binding.entity))];
    const nestedKeys = new Set<string>();
    for (const binding of nested) {
      if (
        binding.recursive &&
        (binding.entity !== entity.key || binding.path.length !== 1)
      )
        throw new EntityDeclarationError(
          `${entity.key} recursive embeddings require a direct self edge`,
        );
      for (const projection of binding.projections) {
        const key = `${projection}:${binding.path.join(".")}`;
        if (nestedKeys.has(key))
          throw new EntityDeclarationError(
            `${entity.key}.fields.embedded repeats ${key}`,
          );
        nestedKeys.add(key);
      }
      if (
        !entities.some(
          (target) => target.key === binding.entity && target.contract,
        )
      )
        throw new EntityDeclarationError(
          `${entity.key}.${binding.path.join(".")} embeds unknown entity ${binding.entity}`,
        );
    }
    if (nested.length)
      nestedBindings.push(
        `${JSON.stringify(entity.key)}:${JSON.stringify([...new Map(nested.map(({ path, entity }) => [`${entity}:${path.join(".")}`, { path, entity }])).values()])}`,
      );
    const embedded = (projection: string) =>
      nested.some((binding) =>
        binding.projections.some((value) => value === projection),
      )
        ? `${projection}EmbeddedRead`
        : `${projection}Read`;
    let usesZod = false;
    const recursiveProjections = new Set<string>();
    const nestedSource = readImports
      .map(([projection]) => {
        const bindings = nested.filter((binding) =>
          binding.projections.includes(projection),
        );
        if (!bindings.length) return "";
        const rawProjection =
          projection.endsWith("List") || projection === "list"
            ? declaration.readSchemas.list
            : projection.endsWith("Detail") || projection === "detail"
              ? declaration.readSchemas.detail
              : declaration.readSchemas.output;
        const lines: string[] = [];
        let source = `${projection}Read`;
        for (const [index, binding] of bindings
          .filter((binding) => !binding.recursive)
          .entries()) {
          const next = `${projection}Embedded${index}Read`;
          const rendered = renderEmbeddedField(
            rawProjection,
            source,
            binding.path,
            binding.entity,
          );
          usesZod ||= rendered.usesZod;
          lines.push(`const ${next} = ${rendered.code};`);
          source = next;
        }
        const recursive = bindings.filter((binding) => binding.recursive);
        if (!recursive.length)
          lines.push(`const ${projection}EmbeddedRead = ${source};`);
        if (recursive.length) {
          if (projection !== "detail" && projection !== "mcpDetail")
            throw new EntityDeclarationError(
              `${entity.key} recursive embeddings require a detail projection`,
            );
          usesZod = true;
          recursiveProjections.add(projection);
          const node = `${name}${projection}Node`;
          const edges = recursive.map((binding) => {
            const key = binding.path[0];
            if (key === undefined)
              throw new EntityDeclarationError(
                "A recursive edge requires a key",
              );
            let child = rawProjection.shape[key];
            const optional = child instanceof z.ZodOptional;
            if (optional) child = child.unwrap();
            if (!(child instanceof z.ZodLazy))
              throw new EntityDeclarationError(
                `${entity.key}.${key} must be a lazy recursive edge`,
              );
            child = child.unwrap();
            const array = child instanceof z.ZodArray;
            if (array) child = child.element;
            if (child !== rawProjection)
              throw new EntityDeclarationError(
                `${entity.key}.${key} must refer to its own detail schema`,
              );
            const value = `${node}${array ? "[]" : ""}`;
            const lazy = `z.ZodLazy<z.ZodType<${value}>>`;
            return {
              key: JSON.stringify(key),
              type: `${JSON.stringify(key)}${optional ? "?" : ""}: ${value}`,
              shape: `${JSON.stringify(key)}: ${optional ? `z.ZodOptional<${lazy}>` : lazy}`,
              schema: `${JSON.stringify(key)}: z.lazy((): z.ZodType<${value}> => ${projection}EnvelopeRead${array ? ".array()" : ""})${optional ? ".optional()" : ""}`,
            };
          });
          const omitted = edges.map((edge) => `${edge.key}: true`).join(",");
          lines.push(
            `const ${projection}EnvelopeBase = withFieldEnvelopes(${source}.omit({${omitted}}), ${name}FieldEnvelopeFields, ${name}PublicReadFields);`,
          );
          lines.push(
            `type ${node} = z.output<typeof ${projection}EnvelopeBase> & {${edges.map((edge) => edge.type).join(";")}};`,
          );
          lines.push(
            `const ${projection}EnvelopeRead: z.ZodObject<typeof ${projection}EnvelopeBase.shape & {${edges.map((edge) => edge.shape).join(";")}}> = ${projection}EnvelopeBase.extend({${edges.map((edge) => edge.schema).join(",")}});`,
          );
          if (projection === "detail")
            lines.push(
              `export const ${name}DetailNode = ${projection}EnvelopeRead;`,
            );
        }
        return lines.join("\n") + "\n";
      })
      .join("");
    return [
      {
        relativePath: `packages/schemas/src/generated/entity-field-envelope-fields.${entity.key}.gen.ts`,
        source:
          generatedHeader +
          `import definition from ${JSON.stringify(declaration.path)};\n` +
          `import { ${hasStored ? "fieldSchemasOf, " : ""}publicReadFieldSchemas } from "../entity-definitions/definition";\n` +
          (hasStored ? "const stored = fieldSchemasOf(definition);\n" : "") +
          `export const ${name}PublicReadFields = publicReadFieldSchemas(definition);\n` +
          `export const ${name}FieldEnvelopeFields = {${entries.join(",")}} as const;\n`,
      },
      {
        relativePath: `packages/schemas/src/generated/entity-field-envelopes.${entity.key}.gen.ts`,
        source:
          generatedHeader +
          `import { ${name}FieldEnvelopeFields, ${name}PublicReadFields } from "./entity-field-envelope-fields.${entity.key}.gen";\n` +
          `export { ${name}FieldEnvelopeFields } from "./entity-field-envelope-fields.${entity.key}.gen";\n` +
          readImports
            .map(
              ([projection, ref]) =>
                `import { ${ref.export} as ${projection}Read } from ${JSON.stringify(ref.module)};`,
            )
            .join("\n") +
          "\n" +
          'import { withFieldEnvelopes } from "../field-envelope";\n' +
          'import { withEntityListMedia, withEntityDetailMedia } from "../entity-read-media";\n' +
          (nested.length
            ? (usesZod ? 'import { z } from "zod";\n' : "") +
              nestedTargets
                .filter((target) => target !== entity.key)
                .map(
                  (target) =>
                    `import { ${target}FieldEnvelopeFields, ${target}PublicReadFields } from "./entity-field-envelope-fields.${target}.gen";\n`,
                )
                .join("") +
              nestedSource
            : "") +
          `const fields = ${name}FieldEnvelopeFields;\n\n` +
          `export const ${name}FieldEnvelopeSchemas = {\n` +
          `  output: withFieldEnvelopes(${embedded("output")}, fields, ${name}PublicReadFields),\n` +
          `  list: withFieldEnvelopes(withEntityListMedia(${embedded("list")}), fields, ${name}PublicReadFields),\n` +
          `  detail: ${recursiveProjections.has("detail") ? "withEntityDetailMedia(detailEnvelopeRead).omit({displayImages:true})" : `withFieldEnvelopes(withEntityDetailMedia(${embedded("detail")}), fields, ${name}PublicReadFields)`},\n` +
          `  mcpOutput: withFieldEnvelopes(${embedded("mcpOutput")}, fields, ${name}PublicReadFields),\n` +
          `  mcpList: withFieldEnvelopes(withEntityListMedia(${embedded("mcpList")}), fields, ${name}PublicReadFields),\n` +
          `  mcpDetail: ${recursiveProjections.has("mcpDetail") ? "withEntityDetailMedia(mcpDetailEnvelopeRead).omit({displayImages:true})" : `withFieldEnvelopes(withEntityDetailMedia(${embedded("mcpDetail")}), fields, ${name}PublicReadFields)`},\n` +
          "};\n",
      },
    ];
  });
  return [
    ...artifacts,
    {
      relativePath:
        "apps/web/src/server/generated/entity-field-envelope-projectors.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import type { FieldEnvelopeProjector } from "~/server/generic/derived/repo/envelope";\n' +
        projectorImports.join("\n") +
        "\n" +
        `export const entityFieldEnvelopeProjectors: Readonly<Partial<Record<Entity, FieldEnvelopeProjector>>> = {${projectorBindings.join(",")}};\n`,
    },
    {
      relativePath:
        "packages/schemas/src/generated/entity-field-envelopes.gen.ts",
      source:
        generatedHeader +
        imports.join("\n") +
        "\n\n" +
        `export const entityFieldEnvelopeSchemas = {${bindings.join(",")}} as const;\n` +
        `export const entityFieldEnvelopeFields = {${fieldBindings.join(",")}} as const;\n`,
    },
    {
      relativePath:
        "packages/schemas/src/generated/entity-field-envelope-nested.gen.ts",
      source:
        generatedHeader +
        `export const entityFieldEnvelopeNested = {${nestedBindings.join(",")}} as const;\n`,
    },
    {
      relativePath:
        "packages/schemas/src/generated/entity-field-envelope-assignments.gen.ts",
      source:
        generatedHeader +
        `export const entityFieldAssignmentKeys = {${assignmentBindings.join(",")}} as const;\n`,
    },
  ];
};
