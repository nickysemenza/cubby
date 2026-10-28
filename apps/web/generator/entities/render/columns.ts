import { SHORTCODE_PREFIX } from "@cubby/shared";
import { compactLiteral } from "../../artifacts.ts";
import { z } from "zod";
import type {
  CompiledEntity,
  DeclarationValue,
  EntityStorageField,
} from "../declarations.ts";

const enumColumnExpression = (
  entity: CompiledEntity,
  field: EntityStorageField,
): string | null => {
  const column = JSON.stringify(field.column);
  if (field.enumValues)
    return `text(${column},{enum:${compactLiteral(field.enumValues)}})`;
  // Resolve declaration schemas during generation; emitted tables need no runtime schema imports.
  const validation = entity.fieldModel.fields.find(
    ({ key }) => key === field.key,
  )?.validation;
  let schema: z.core.$ZodType | null | undefined =
    validation?.read ?? validation?.create ?? validation?.update;
  while (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault
  )
    schema = schema.unwrap();
  return schema instanceof z.ZodEnum
    ? `text(${column},{enum:${compactLiteral(schema.options)}})`
    : null;
};

const literalDefaultExpression = (value: DeclarationValue): string => {
  if (typeof value === "string") {
    if (value === "'{}'::text[]") return "sql`'{}'::text[]`";
    if (value === "'[]'::jsonb") return "[]";
    const jsonbLiteral = /^'(.*)'::jsonb$/su.exec(value);
    if (jsonbLiteral) {
      JSON.parse(jsonbLiteral[1]!.replaceAll("''", "'"));
      return `sql\`${value}\``;
    }
    if (value.startsWith("'") && value.endsWith("'"))
      return JSON.stringify(value.slice(1, -1));
  }
  return compactLiteral(value);
};

/**
 * One model storage column as a Drizzle column builder. `reference` renders
 * the FK target thunk for a referenced entity key.
 */
export const renderStorageColumn = (
  entity: CompiledEntity,
  field: EntityStorageField,
  reference: (entity: string, column?: string) => string,
): string => {
  const column = JSON.stringify(field.column);
  if (field.specialized === "amount-columns") {
    // One `{ value, unit }` model field stored as `<column>Value` +
    // `<column>Unit` (the shape `amountFromColumns`/`amountToColumns` in
    // `server/db/helpers` convert). The pair is atomic: both set or
    // both null, and a live unit is never blank.
    const valueColumn = JSON.stringify(`${field.column}Value`);
    const unitColumn = JSON.stringify(`${field.column}Unit`);
    const notNull = field.nullable ? "" : ".notNull()";
    return `${JSON.stringify(`${field.key}Value`)}:doublePrecision(${valueColumn})${notNull},${JSON.stringify(`${field.key}Unit`)}:text(${unitColumn})${notNull}`;
  }
  const ownIdType = Object.hasOwn(SHORTCODE_PREFIX, entity.key)
    ? `EntityId<${JSON.stringify(entity.key)}>`
    : undefined;
  const referenceIdType =
    field.reference !== null && Object.hasOwn(SHORTCODE_PREFIX, field.reference)
      ? `EntityId<${JSON.stringify(field.reference)}>`
      : null;
  let expression: string;
  if (field.key === "id") {
    expression =
      ownIdType === undefined
        ? `uuid(${column}).primaryKey().default(sql\`gen_random_uuid()\`)`
        : `uuid(${column}).primaryKey().default(sql\`gen_random_uuid()\`).$type<${ownIdType}>()`;
  } else if (field.key === "shortcode") {
    // The public id (`PRD-4K7M`). Deliberately NOT branded: generic Drizzle
    // table unions erase the entity correlation on inserts and comparisons,
    // so repository mappers validate it through per-entity shortcode schemas.
    expression = `text(${column}).notNull()`;
  } else if (field.kind === "identifier") {
    expression = `uuid(${column})`;
    if (referenceIdType !== undefined && referenceIdType !== null)
      expression += `.$type<${referenceIdType}>()`;
  } else if (field.kind === "text-array") {
    expression = `text(${column}).array()`;
  } else if (field.kind === "text") {
    expression = `text(${column})`;
  } else if (field.kind === "number") {
    expression =
      field.specialized === "real"
        ? `real(${column})`
        : field.specialized === "double-precision"
          ? `doublePrecision(${column})`
          : `integer(${column})`;
  } else if (field.kind === "boolean") {
    expression = `boolean(${column})`;
  } else if (field.kind === "date") {
    expression = `date(${column},{mode:"string"})`;
  } else if (field.kind === "timestamp") {
    expression = `timestamp(${column},{mode:"date"})`;
  } else if (field.kind === "json") {
    expression = `jsonb(${column})`;
  } else {
    expression = enumColumnExpression(entity, field) ?? `text(${column})`;
  }
  if (field.type)
    expression += `.$type<${field.type.export}${field.type.array ? "[]" : ""}>()`;
  if (
    field.key !== "id" &&
    field.key !== "shortcode" &&
    field.nullable === false
  )
    expression += ".notNull()";
  if (field.default === "now") expression += ".defaultNow()";
  if (field.default === "literal")
    expression += `.default(${literalDefaultExpression(field.defaultValue)})`;
  if (field.defaultSql !== undefined)
    expression += `.default(sql\`${field.defaultSql}\`)`;
  if (field.specialized === "updated-at")
    expression += ".$onUpdate(() => new Date())";
  if (field.reference !== null)
    expression += `.references(${reference(field.reference, field.referenceOptions?.column)}${field.referenceOptions?.onUpdate || field.referenceOptions?.onDelete ? `, ${JSON.stringify({ onUpdate: field.referenceOptions.onUpdate, onDelete: field.referenceOptions.onDelete })}` : ""})`;
  return `${JSON.stringify(field.key)}:${expression}`;
};

/** Unrelated column imports would reconnect leaf groups to other schema types. */
export const referencedImports = (imports: string, source: string): string => {
  const code = source.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gu, "");
  const used = new Set(code.match(/[A-Za-z_$][\w$]*/gu));
  const imported = new Set<string>();
  return imports
    .split("\n")
    .flatMap((line) => {
      const match = /^(import (?:type )?\{ )(.+)( \} from .+;)$/.exec(line);
      if (!match) return [];
      const names = match[2]!.split(", ").filter((name) => {
        const identifier = name.replace(/^type /u, "");
        const key = match[3] + identifier;
        if (!used.has(identifier) || imported.has(key)) return false;
        imported.add(key);
        return true;
      });
      return names.length
        ? [`${match[1]}${names.join(", ")}${match[3]}\n`]
        : [];
    })
    .join("");
};

export const storageColumnImportsFor = (
  source: string,
  declaredImports = "",
): string =>
  referencedImports(
    'import type { EntityId } from "@cubby/schemas/identifiers";\n' +
      declaredImports,
    source,
  );
