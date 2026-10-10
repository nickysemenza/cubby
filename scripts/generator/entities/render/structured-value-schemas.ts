import { drawsFromValueSchema } from "../../../../packages/schemas/src/native-coverage.ts";
import { generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity } from "../declarations.ts";
import { renderRecord } from "./record.ts";
import {
  type EntityForPrefix,
  type ValueSchemaJSON,
  valueSchemaOf,
} from "./value-schema.ts";

/** Resolves an entity from a shortcode prefix such as `ING-`. */
export const entityPrefixLookup = (
  entities: readonly CompiledEntity[],
): EntityForPrefix => {
  const entityByPrefix = new Map(
    entities.flatMap((entity) =>
      entity.shortcode === undefined || entity.shortcode === null
        ? []
        : [[entity.shortcode, entity.key] as const],
    ),
  );
  return (prefix) => entityByPrefix.get(prefix) ?? null;
};

type Field = CompiledEntity["fieldModel"]["fields"][number];

/**
 * The structured editor's schema description for a field whose renderer draws from one, derived
 * from the input schema a client sends (`update`, else `create`: a create-only field such as a
 * meal's `recipes` has no update input; a collection field's full value). Null for every other field.
 */
export const valueSchemaForField = (
  entity: string,
  field: Field,
  where: string,
  entityForPrefix: EntityForPrefix,
): ValueSchemaJSON | null => {
  if (!drawsFromValueSchema(entity, field)) return null;
  // A collection field's update input also accepts patch items; the editor
  // always sends the full value, which its create input describes.
  const input =
    field.collection && field.validation.create
      ? field.validation.create
      : (field.validation.update ?? field.validation.create);
  if (input === null || input === undefined)
    throw new Error(
      `${where}: a structured renderer needs a create or update input schema.`,
    );
  return valueSchemaOf(input, where, entityForPrefix);
};

/**
 * Web's copy of the schemas native draws: one record keyed `entity.field`, imported only by the
 * generic structured-value editor so no other bundle pays for it.
 */
export const renderStructuredValueSchemas = (
  entities: readonly CompiledEntity[],
) => {
  const entityForPrefix = entityPrefixLookup(entities);
  const schemas = Object.fromEntries(
    entities.flatMap((entity) =>
      entity.fieldModel.fields.flatMap((field) => {
        const id = `${entity.key}.${field.key}`;
        const schema = valueSchemaForField(
          entity.key,
          field,
          id,
          entityForPrefix,
        );
        return schema === null ? [] : [[id, schema] as const];
      }),
    ),
  );
  return [
    {
      relativePath:
        "packages/schemas/src/generated/structured-value-schemas.gen.ts",
      source:
        generatedHeader +
        'import type { StructuredValueSchema } from "../structured-value-schema";\n\n' +
        renderRecord({
          name: "structuredValueSchemas",
          entries: schemas,
          satisfies: "Readonly<Record<string, StructuredValueSchema>>",
          comment:
            "// The generic structured-value editor's schema per `entity.field`.",
        }),
    },
  ];
};
