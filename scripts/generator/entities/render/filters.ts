import { compactLiteral, generatedHeader } from "../../artifacts.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  FilterDescriptor,
  SourceRef,
} from "../declarations.ts";
import { entityProjectionMaps } from "./index.ts";
import { renderRecord } from "./record.ts";

/**
 * One aliased runtime import per distinct `module#export`, sorted so the
 * emitted import block is stable. `alias` resolves a ref back to its
 * identifier in the generated module.
 */
export const sourceRefImports = (
  refs: readonly SourceRef[],
  prefix: string,
) => {
  const refKey = (ref: SourceRef) => `${ref.module}#${ref.export}`;
  const distinct = [
    ...new Map(refs.map((ref) => [refKey(ref), ref] as const)).values(),
  ].sort((left, right) => refKey(left).localeCompare(refKey(right)));
  const aliases = new Map(
    distinct.map((ref, index) => [refKey(ref), `${prefix}${index}`]),
  );
  const byModule = new Map<string, Array<{ export: string; alias: string }>>();
  for (const ref of distinct) {
    const imports = byModule.get(ref.module) ?? [];
    // SAFETY: every distinct ref was assigned an alias in the map above.
    imports.push({ export: ref.export, alias: aliases.get(refKey(ref))! });
    byModule.set(ref.module, imports);
  }
  return {
    imports: [...byModule.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([module, imports]) =>
          `import { ${imports.map(({ export: name, alias }) => `${name} as ${alias}`).join(", ")} } from ${JSON.stringify(module)};`,
      )
      .join("\n"),
    // SAFETY: callers only resolve refs they passed in.
    alias: (ref: SourceRef) => aliases.get(refKey(ref))!,
  };
};

export const renderFilterArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const { filters: filterEntities } = entityProjectionMaps(entities);
  const { imports: runtimeImports, alias } = sourceRefImports(
    filterEntities.flatMap(({ filterDescriptors }) =>
      filterDescriptors.flatMap((descriptor) =>
        [descriptor.optionsRef, descriptor.expandRef].filter(
          (ref): ref is SourceRef => ref !== null,
        ),
      ),
    ),
    "filterRef",
  );
  const runtimeDescriptor = (descriptor: FilterDescriptor): string => {
    const properties = [
      `columnId:${JSON.stringify(descriptor.columnId)}`,
      ...(descriptor.field === null
        ? []
        : [`field:${JSON.stringify(descriptor.field)}`]),
      ...(descriptor.urlKey === descriptor.columnId
        ? []
        : [`urlKey:${JSON.stringify(descriptor.urlKey)}`]),
      `kind:${JSON.stringify(descriptor.kind)}`,
      `placeholder:${JSON.stringify(descriptor.placeholder)}`,
      ...(descriptor.options === null
        ? []
        : [`options:${compactLiteral(descriptor.options)}`]),
      ...(descriptor.optionsRef === null
        ? []
        : [`options:${alias(descriptor.optionsRef)}`]),
      ...(descriptor.optionsKey === null
        ? []
        : [`optionsKey:${JSON.stringify(descriptor.optionsKey)}`]),
      ...(descriptor.label === null
        ? []
        : [`label:${JSON.stringify(descriptor.label)}`]),
      ...(descriptor.brandRef === null
        ? []
        : [
            `referenceEntity:${JSON.stringify(descriptor.brandRef.entity)}`,
            `brand:(value) => parseShortcodeFor(${JSON.stringify(descriptor.brandRef.entity)}, value)`,
          ]),
      ...(descriptor.expandRef === null
        ? []
        : [`expand:${alias(descriptor.expandRef)}`]),
      ...(descriptor.urlOnly ? ["urlOnly:true"] : []),
      ...(descriptor.nullable === null
        ? []
        : [`nullable:${compactLiteral(descriptor.nullable)}`]),
    ];
    return `{${properties.join(",")}}`;
  };
  const runtimeRoster = filterEntities
    .map(
      ({ key, filterDescriptors }) =>
        `${JSON.stringify(key)}:[${filterDescriptors.map(runtimeDescriptor).join(",")}],`,
    )
    .join("\n");
  const filterContractCases = Object.fromEntries(
    filterEntities.map(
      ({ key, filterAudit, filterSchema, filterDescriptors }) => [
        key,
        {
          descriptorColumns: filterDescriptors.map(({ columnId }) => columnId),
          urlKeys: filterDescriptors.map(({ urlKey }) => urlKey),
          referenceFilters: filterDescriptors.flatMap((descriptor) =>
            descriptor.brandRef === null
              ? []
              : [
                  {
                    columnId: descriptor.columnId,
                    entity: descriptor.brandRef.entity,
                  },
                ],
          ),
          schema:
            filterSchema === null
              ? null
              : `${filterSchema.module}#${filterSchema.export}`,
          optionSources: [
            ...new Set(
              filterDescriptors.flatMap((descriptor) => [
                ...(descriptor.optionsKey === null
                  ? []
                  : [descriptor.optionsKey]),
                ...(descriptor.optionsRef === null
                  ? []
                  : [
                      `${descriptor.optionsRef.module}#${descriptor.optionsRef.export}`,
                    ]),
              ]),
            ),
          ],
          audit: filterAudit,
          rangeExpanders: filterDescriptors.flatMap((descriptor) =>
            descriptor.kind === "range" && descriptor.expandRef !== null
              ? [
                  `${descriptor.columnId}:${descriptor.expandRef.module}#${descriptor.expandRef.export}`,
                ]
              : [],
          ),
        },
      ],
    ),
  );
  return [
    {
      relativePath:
        "apps/web/src/entities/generated/entity-filter-contracts.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n\n' +
        'import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";\n\n' +
        "export type EntityFilterContractCase = {\n" +
        "  descriptorColumns: readonly string[];\n" +
        "  urlKeys: readonly string[];\n" +
        "  referenceFilters: readonly { columnId: string; entity: ShortcodeEntity }[];\n" +
        "  schema: string | null;\n" +
        "  optionSources: readonly string[];\n" +
        "  audit: boolean;\n" +
        "  rangeExpanders: readonly string[];\n" +
        "};\n\n" +
        renderRecord({
          name: "generatedEntityFilterContractCases",
          entries: filterContractCases,
          satisfies: "Record<Entity, EntityFilterContractCase>",
          comment:
            "// Generated contract cases keep mechanical filter invariants reviewable.\n// Generated filter contract cases stay compact.",
        }),
    },
    {
      relativePath:
        "apps/web/src/entities/generated/entity-filter-bindings.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import { parseShortcodeFor } from "@cubby/schemas/identifiers";\n' +
        `${runtimeImports}\n` +
        'import type { FilterSpec } from "../filter-manifest";\n\n' +
        "// Generated runtime filter assembly stays one entity per line.\n// oxfmt-ignore\n" +
        `export const generatedEntityFilters = {\n${runtimeRoster}\n} satisfies Record<Entity, readonly FilterSpec[]>;\n`,
    },
  ];
};
