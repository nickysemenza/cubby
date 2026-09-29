import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatedHeader } from "../../artifacts.ts";
import { EntityDeclarationError } from "../declarations.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";

/**
 * Per-entity Zod wrappers (`packages/schemas/src/generated/<key>.gen.ts`):
 * the create/update/read objects over the generated field schemas, the
 * `{ id, data }` update envelope, the gallery list row, and the filter fields.
 * The hand-written module re-exports them under the same names and keeps only
 * genuine extras (refinements, workflow inputs, bespoke rows).
 *
 * Only exports no declaration imports may be generated: declarations import
 * `identifier-fields`, `*-fields` and primitives, which is why this file
 * imports `identifier-fields` (never `identifiers`) and no declared module.
 *
 * Knip reads generated files, so each entity lists exactly the wrappers its
 * hand-written module consumes. A token names a wrapper; a trailing `+` also
 * emits the inferred type under the same PascalCase name.
 *
 * - `create`, `update`, `updateInput`, `out`, `listItem`: `z.object(...)` over
 *   the generated create/update/read schemas; `listItem` is `out` plus the
 *   server-resolved `displayImages`, so it needs `out`.
 * - `filters`: the complete `<key>FilterFields` + filters schema (an entity
 *   with no hand-written filter extras).
 * - `filtersBase`: `<key>BaseFilterFields`, the audit/related/derived spread
 *   the hand-written module extends with its own extras.
 */
const WRAPPERS = {
  device: "create+ update+ updateInput out+ filters+",
  expense: "update+ updateInput+ out+ listItem+ filtersBase",
  financialAccount: "create+ update+ updateInput+ out+ filtersBase",
  financialTransaction: "filtersBase",
  gardenEntry: "create update updateInput out+ listItem filtersBase",
  ingredient: "create+ update updateInput+ filtersBase",
  ledgerParty: "create+ update+ updateInput+ out+ filters+",
  ledgerTransfer: "create+ update+ updateInput+ out+ filtersBase",
  location: "create+ update updateInput+ filtersBase",
  meal: "create+ update updateInput+ filtersBase",
  plant: "create+ update+ out+ filtersBase",
  planting: "create update updateInput out+ listItem filtersBase",
  product: "create+ update updateInput+ filtersBase",
  productCategory: "create+ update+ updateInput out+ filters+",
  project: "create+ update+ updateInput+ out+ listItem+ filtersBase",
  purchase: "out+ listItem+ filtersBase",
  recipe: "create+ update updateInput+ filtersBase",
  run: "out+ filters+",
  task: "create+ update+ updateInput+ out+ listItem+ filtersBase",
  vendor: "create+ update+ updateInput+ out+ filtersBase",
  vendorAccount: "create+ update+ updateInput out+ filters+",
  wish: "create+ update+ updateInput+ out+ listItem+ filtersBase",
} satisfies Record<string, string>;

/** Entities whose complete filters schema is exported as `<key>Filters`. */
const SHORT_FILTERS_NAME: ReadonlySet<string> = new Set([
  "device",
  "productCategory",
  "run",
  "vendorAccount",
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const RELATED_VIEW = resolve(
  HERE,
  "../../../../packages/schemas/src/related-view.ts",
);

const camel = (key: string): string =>
  key.replaceAll(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
const pascal = (key: string): string =>
  `${camel(key)[0]?.toUpperCase() ?? ""}${camel(key).slice(1)}`;

/**
 * `related-view.ts` hand-lists one `<key>RelatedFilterFields` block per source
 * entity (it imports the generated manifest, so it cannot be loaded here).
 */
const relatedFilterEntities = (): ReadonlySet<string> => {
  const source = readFileSync(RELATED_VIEW, "utf8");
  return new Set(
    [...source.matchAll(/^export const (\w+)RelatedFilterFields\b/gm)].map(
      ([, key]) => key ?? "",
    ),
  );
};

type Wanted = ReadonlyMap<string, boolean>;

const parseSpec = (spec: string): Wanted =>
  new Map(
    spec.split(" ").map((token) => {
      const withType = token.endsWith("+");
      return [withType ? token.slice(0, -1) : token, withType] as const;
    }),
  );

/** The `z.object` wrappers over the generated create/update/read schemas. */
const objectWrappers = (
  entity: CompiledEntity,
  name: string,
  wanted: Wanted,
  fieldSchemas: string,
): string[] => {
  const { fieldModel } = entity;
  const kinds = [
    {
      kind: "create",
      suffix: "CreateInput",
      roster: fieldModel.create,
      expression: `z.object(${fieldSchemas}.create)`,
    },
    {
      kind: "update",
      suffix: "UpdateData",
      roster: fieldModel.update,
      expression: `z.object(${fieldSchemas}.update)`,
    },
    {
      kind: "updateInput",
      suffix: "UpdateInput",
      roster: fieldModel.update,
      expression: `z.object({ id: ${name}Shortcode, data: ${name}UpdateData })`,
      requires: "update",
    },
    {
      kind: "out",
      suffix: "Out",
      roster: fieldModel.output,
      expression: `z.object(${fieldSchemas}.read)`,
    },
    {
      kind: "listItem",
      suffix: "ListItemOut",
      roster: null,
      expression: `${name}Out.extend({ displayImages: displayImagesField })`,
      requires: "out",
    },
  ];
  return kinds.flatMap(({ kind, suffix, roster, expression, ...rest }) => {
    if (!wanted.has(kind)) return [];
    const requires = "requires" in rest ? rest.requires : undefined;
    if (requires !== undefined && !wanted.has(requires))
      throw new EntityDeclarationError(
        `${entity.key} lists ${kind} without ${requires}.`,
      );
    if (roster !== null && roster.length === 0)
      throw new EntityDeclarationError(
        `${entity.key} lists the ${kind} wrapper but declares no ${kind} fields.`,
      );
    const exportName = `${name}${suffix}`;
    return [
      `export const ${exportName} = ${expression};\n` +
        (wanted.get(kind) === true
          ? `export type ${pascal(exportName)} = z.infer<typeof ${exportName}>;\n`
          : ""),
    ];
  });
};

/** The complete filters (schema + type) or the base spread the module extends. */
const filterWrapper = (
  name: string,
  wanted: Wanted,
  spread: string,
): string[] => {
  if (wanted.has("filters") && wanted.has("filtersBase"))
    throw new EntityDeclarationError(
      `${name} lists both filters and filtersBase.`,
    );
  if (wanted.has("filtersBase"))
    return [`export const ${name}BaseFilterFields = { ${spread} };\n`];
  if (!wanted.has("filters")) return [];
  const schemaName = `${name}${SHORT_FILTERS_NAME.has(name) ? "Filters" : "FiltersSchema"}`;
  return [
    `export const ${name}FilterFields = { ${spread} };\n` +
      `export const ${schemaName} = z.object(${name}FilterFields);\n` +
      `export type ${pascal(name)}Filters = z.infer<typeof ${schemaName}>;\n`,
  ];
};

export const renderSchemaWrapperArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const related = relatedFilterEntities();
  const specs = new Map<string, string>(Object.entries(WRAPPERS));
  const known = new Set(entities.map(({ key }) => camel(key)));
  for (const key of specs.keys())
    if (!known.has(key))
      throw new EntityDeclarationError(
        `Schema wrapper spec names unknown entity ${key}.`,
      );
  return entities.flatMap((entity) => {
    const name = camel(entity.key);
    const spec = specs.get(name);
    if (spec === undefined) return [];
    const wanted = parseSpec(spec);
    const prefix = `generated${entity.inspector.singular.replaceAll(" ", "")}`;
    const fieldSchemas = `${prefix}FieldSchemas`;
    const filterFields = `${prefix}FilterFields`;
    const usesFilters = wanted.has("filters") || wanted.has("filtersBase");
    const hasAudit = usesFilters && entity.filterAudit;
    const hasRelated = usesFilters && related.has(name);
    const spread = [
      ...(hasAudit ? ["...auditDateFilterFields"] : []),
      ...(hasRelated ? [`...${name}RelatedFilterFields`] : []),
      `...${filterFields}`,
    ].join(", ");
    const body = [
      ...objectWrappers(entity, name, wanted, fieldSchemas),
      ...filterWrapper(name, wanted, spread),
    ];
    const code = body.join("\n");
    const fieldImports = [
      ...(code.includes(`(${fieldSchemas}`) ? [fieldSchemas] : []),
      ...(usesFilters ? [filterFields] : []),
    ];
    const imports =
      (code.includes("z.") ? 'import { z } from "zod";\n' : "") +
      (wanted.has("updateInput")
        ? `import { ${name}Shortcode } from "../identifier-fields";\n`
        : "") +
      (wanted.has("listItem")
        ? 'import { displayImagesField } from "../display-images";\n'
        : "") +
      (hasAudit
        ? 'import { auditDateFilterFields } from "../base-entity";\n'
        : "") +
      (hasRelated
        ? `import { ${name}RelatedFilterFields } from "../related-view";\n`
        : "") +
      `import { ${fieldImports.join(", ")} } from "./entity-field-schemas.${entity.key}.gen";\n`;
    return [
      {
        relativePath: `packages/schemas/src/generated/${entity.key}.gen.ts`,
        source: `${generatedHeader}${imports}\n${code}`,
      },
    ];
  });
};
