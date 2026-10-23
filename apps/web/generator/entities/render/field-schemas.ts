import { CURRENT_MEMBER_FILTER } from "@cubby/shared/filter";
import { generatedHeader } from "../../artifacts.ts";
import { EntityDeclarationError, declarationModules } from "../declarations.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  EntityField,
  FilterDescriptor,
  SourceRef,
} from "../declarations.ts";

interface DerivedFilterFields {
  imports: string;
  entries: string[];
}

interface DerivedFilterNeeds {
  z: boolean;
  oneOrMany: boolean;
  entityFilterList: boolean;
  tokenFilterList: boolean;
  shortcodeSchema: boolean;
  presence: boolean;
  numeric: boolean;
  date: boolean;
}

const derivedEnumValues = (
  descriptor: FilterDescriptor,
  needs: DerivedFilterNeeds,
  readRef: (descriptor: FilterDescriptor) => string,
  refAlias: (ref: SourceRef) => string,
): string => {
  if (descriptor.schemaFromRead) return readRef(descriptor);
  if (descriptor.schemaRef !== null) return refAlias(descriptor.schemaRef);
  needs.z = true;
  return descriptor.options === null
    ? "z.string()"
    : `z.enum(${JSON.stringify(descriptor.options.map((option) => option.value))})`;
};

const derivedRangeEntry = (
  entity: CompiledEntity,
  descriptor: FilterDescriptor,
  key: string,
  needs: DerivedFilterNeeds,
): string => {
  const range = descriptor.range;
  if (range === null)
    throw new EntityDeclarationError(
      `${entity.key} filter ${descriptor.columnId} range was not resolved.`,
    );
  if (range.kind === "date") {
    needs.date = true;
    const describe =
      range.describe === null
        ? ""
        : `,{describe:{from:${JSON.stringify(range.describe.lower)},to:${JSON.stringify(range.describe.upper)}}}`;
    return `...dateRangeFields(${JSON.stringify(key)}${describe})`;
  }
  needs.numeric = true;
  const options = [
    ...(range.int ? ["int:true"] : []),
    ...(range.nonnegative ? ["nonnegative:true"] : []),
    ...(range.finite ? ["finite:true"] : []),
    ...(range.describe === null
      ? []
      : [
          `describe:{min:${JSON.stringify(range.describe.lower)},max:${JSON.stringify(range.describe.upper)}}`,
        ]),
  ];
  return `...numericRangeFields(${JSON.stringify(key)}${options.length ? `,{${options.join(",")}}` : ""})`;
};

const derivedFilterImports = (
  needs: DerivedFilterNeeds,
  refs: ReadonlyMap<string, string>,
): string => {
  const byModule = new Map<string, string[]>();
  for (const [key, alias] of refs) {
    const [module = "", name = ""] = key.split("#");
    const list = byModule.get(module) ?? [];
    list.push(`${name} as ${alias}`);
    byModule.set(module, list);
  }
  const pagination = [
    ...(needs.entityFilterList ? ["entityFilterList"] : []),
    ...(needs.tokenFilterList ? ["tokenFilterList"] : []),
    ...(needs.oneOrMany ? ["oneOrMany"] : []),
    ...(needs.presence ? ["presenceFilter"] : []),
  ];
  const ranges = [
    ...(needs.date ? ["dateRangeFields"] : []),
    ...(needs.numeric ? ["numericRangeFields"] : []),
  ];
  return [
    ...(needs.z ? ['import { z } from "zod";'] : []),
    ...(pagination.length
      ? [
          `import { ${pagination.join(", ")} } from "@cubby/schemas/pagination";`,
        ]
      : []),
    ...(ranges.length
      ? [`import { ${ranges.join(", ")} } from "@cubby/schemas/base-entity";`]
      : []),
    ...(needs.shortcodeSchema
      ? ['import { shortcodeSchema } from "@cubby/schemas/identifiers";']
      : []),
    ...[...byModule.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([module, names]) =>
          `import { ${names.join(", ")} } from ${JSON.stringify(module)};`,
      ),
  ]
    .map((line) => `${line}\n`)
    .join("");
};

/**
 * Filter fields derived from descriptors flagged `deriveSchema`: the Zod for a
 * filter key is spelled once, next to the column it filters. Enum values come
 * from the model field's read schema (`schemaFromRead`), a named export
 * (`schemaRef`), or the descriptor's static options; ranges expand to the
 * shared min/max or from/to builders.
 */
const renderDerivedFilterFields = (
  entity: CompiledEntity,
  fields: readonly EntityField[],
): DerivedFilterFields => {
  const refs = new Map<string, string>();
  const refAlias = (ref: SourceRef) => {
    const key = `${ref.module}#${ref.export}`;
    const existing = refs.get(key);
    if (existing) return existing;
    const alias = `filterSchema${refs.size}`;
    refs.set(key, alias);
    return alias;
  };
  const needs: DerivedFilterNeeds = {
    z: false,
    oneOrMany: false,
    entityFilterList: false,
    tokenFilterList: false,
    shortcodeSchema: false,
    presence: false,
    numeric: false,
    date: false,
  };
  const readRef = (descriptor: FilterDescriptor) => {
    const index = fields.findIndex(
      (field) => field.key === descriptor.columnId,
    );
    if (index < 0)
      throw new EntityDeclarationError(
        `${entity.key} filter ${descriptor.columnId} has no model field for schemaFromRead.`,
      );
    return `fieldSchemasOf(definition).read[${JSON.stringify(descriptor.columnId)}]`;
  };
  const valueEntry = (
    descriptor: FilterDescriptor,
    as?: Readonly<{ name: string; description: string }>,
  ): string => {
    const name = as?.name ?? descriptor.field ?? descriptor.columnId;
    const key = JSON.stringify(name);
    const description = as?.description ?? descriptor.schemaDescription;
    const describe =
      description === null ? "" : `.describe(${JSON.stringify(description)})`;
    switch (descriptor.kind) {
      case "text": {
        if (!descriptor.schemaFromRead) needs.z = true;
        // A text filter's `schemaRef` names a value schema of several terms.
        const base = descriptor.schemaFromRead
          ? readRef(descriptor)
          : descriptor.schemaRef !== null
            ? refAlias(descriptor.schemaRef)
            : "z.string()";
        return `${key}:${base}.optional()${describe}`;
      }
      case "boolean":
        needs.z = true;
        return `${key}:z.boolean().optional()${describe}`;
      case "presence":
        needs.presence = true;
        return `${key}:presenceFilter${describe}`;
      case "multiselect":
        needs.oneOrMany = true;
        return `${key}:oneOrMany(${derivedEnumValues(descriptor, needs, readRef, refAlias)}).optional()${describe}`;
      case "range": {
        const bounds = derivedRangeEntry(entity, descriptor, name, needs);
        // A range's declared Any value / No value key rides beside its bounds.
        if (descriptor.wire.kind !== "range" || !descriptor.wire.presence)
          return bounds;
        needs.presence = true;
        return `${bounds},${JSON.stringify(descriptor.wire.presence)}:presenceFilter`;
      }
      // The referenced entity's branded shortcode — never the field's
      // read schema, which is nullable for an optional foreign key.
      case "idMulti": {
        const target = descriptor.brandRef?.entity;
        if (target === undefined)
          throw new EntityDeclarationError(
            `${entity.key} filter ${descriptor.columnId} derives an id schema without brandRef.`,
          );
        needs.shortcodeSchema = true;
        const code = `shortcodeSchema(${JSON.stringify(target)})`;
        // `@me` (declared `currentMember`) and declared sentinels are
        // public tokens beside the shortcodes.
        const tokens = [
          ...(descriptor.currentMember ? [CURRENT_MEMBER_FILTER] : []),
          ...(descriptor.sentinels ?? []).map(({ value }) => value),
        ];
        if (tokens.length > 0) {
          needs.tokenFilterList = true;
          return `${key}:tokenFilterList(${code},${JSON.stringify(tokens)}).optional()${describe}`;
        }
        needs.entityFilterList = true;
        return `${key}:entityFilterList(${code}).optional()${describe}`;
      }
    }
  };
  const entries = entity.filterDescriptors
    // A compiled filter's generated keys reach its schema even when the value
    // key is hand-written.
    .filter(
      (descriptor) =>
        descriptor.deriveSchema ||
        descriptor.stored !== null ||
        descriptor.anyOf !== null ||
        descriptor.derived !== null,
    )
    .flatMap((descriptor) => {
      const label =
        descriptor.nullable?.label ??
        (descriptor.label ?? descriptor.columnId).toLowerCase();
      // The generated Any value / No value, Match all and Exclude keys ride
      // beside the value key, so a request can say "has a value", "all of
      // these" or "none of these".
      if (descriptor.nullable !== null) needs.presence = true;
      if (descriptor.match !== null) needs.z = true;
      return [
        ...(descriptor.deriveSchema ? [valueEntry(descriptor)] : []),
        ...(descriptor.nullable === null
          ? []
          : [
              `${JSON.stringify(descriptor.nullable.field)}:presenceFilter.describe(${JSON.stringify(`has/none ${label}, ORed with picked values`)})`,
            ]),
        ...(descriptor.match === null
          ? []
          : [
              `${JSON.stringify(descriptor.match.field)}:z.enum(["any","all"]).optional().describe(${JSON.stringify(`all: every picked ${label}`)})`,
            ]),
        // The Exclude key takes the value key's schema; a filter that cannot
        // exclude keeps it so the list rejects it with the reason.
        ...(descriptor.exclude === null
          ? []
          : [
              valueEntry(descriptor, {
                name: descriptor.exclude.field,
                description:
                  descriptor.exclude.reason === null
                    ? `Exclude rows matching any of these ${label} values; rows with no value stay`
                    : `Unsupported: ${descriptor.exclude.reason}`,
              }),
            ]),
      ];
    });
  return { imports: derivedFilterImports(needs, refs), entries };
};

export const renderFieldSchemaArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const fieldByKey = (entity: CompiledEntity, key: string) => {
    const field = entity.fieldModel.fields.find(
      (candidate) => candidate.key === key,
    );
    if (field === undefined)
      throw new EntityDeclarationError(
        `${entity.key}.model is missing field ${key}.`,
      );
    return field;
  };
  const validationComplete = (
    entity: CompiledEntity,
    mode: "create" | "update" | "read",
    keys: readonly string[],
  ) => keys.every((key) => fieldByKey(entity, key).validation[mode] !== null);
  const fieldSchemaArtifacts = entities.flatMap((entity) => {
    const { fieldModel } = entity;
    if (
      fieldModel.create.length +
        fieldModel.update.length +
        fieldModel.output.length ===
      0
    )
      return [];
    for (const [mode, keys] of [
      ["create", fieldModel.create],
      ["update", fieldModel.update],
      ["read", fieldModel.output],
    ] as const)
      if (!validationComplete(entity, mode, keys))
        throw new EntityDeclarationError(
          `${entity.key}.${mode} roster has missing schemas.`,
        );
    const declaration = declarationModules.get(entity.key);
    if (!declaration)
      throw new EntityDeclarationError(
        `${entity.key} has no declaration module.`,
      );
    const prefix = `generated${entity.inspector.singular.replaceAll(" ", "")}`;
    const filterFields = renderDerivedFilterFields(entity, fieldModel.fields);
    return [
      {
        relativePath: `packages/schemas/src/generated/entity-field-schemas.${entity.key}.gen.ts`,
        source:
          generatedHeader +
          `import definition from ${JSON.stringify(declaration.path)};\n` +
          'import { fieldSchemasOf } from "../entity-definitions/definition";\n' +
          filterFields.imports +
          (declaration.enumExports.length
            ? `export {${declaration.enumExports.join(",")}} from ${JSON.stringify(declaration.path)};\n`
            : "") +
          // Keyed by roster, not field index: `fieldSchemasOf` reads each
          // schema by key at load time, so inserting a field mid-declaration
          // cannot shift another field's schema. The rosters were validated
          // complete above; the runtime lookup throws on a missing schema.
          `export const ${prefix}FieldSchemas = fieldSchemasOf(definition);\n` +
          (filterFields.entries.length
            ? `export const ${prefix}FilterFields = {${filterFields.entries.join(",")}} as const;\n`
            : ""),
      },
    ];
  });
  return fieldSchemaArtifacts;
};
