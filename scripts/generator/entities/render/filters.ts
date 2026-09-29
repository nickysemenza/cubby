import { compactLiteral, generatedHeader } from "../../artifacts.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  FilterDescriptor,
  SourceRef,
} from "../declarations.ts";
import { entityProjectionMaps } from "./index.ts";

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

/** Preset value → the filter fields it sets, or null when none is declared as data. */
const presetTable = (
  descriptor: FilterDescriptor,
): Record<
  string,
  Readonly<Record<string, string | number | boolean>>
> | null => {
  const presets = (descriptor.options ?? []).flatMap((option) =>
    option.expand === undefined ? [] : [[option.value, option.expand] as const],
  );
  return presets.length === 0 ? null : Object.fromEntries(presets);
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
        : [
            `options:${compactLiteral(
              descriptor.options.map(
                ({ expand: _expand, ...option }) => option,
              ),
            )}`,
          ]),
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
      ...(presetTable(descriptor) === null
        ? []
        : [`expand:presetExpand(${compactLiteral(presetTable(descriptor))})`]),
      ...(descriptor.urlOnly ? ["urlOnly:true"] : []),
      ...(descriptor.nullable === null
        ? []
        : [`nullable:${compactLiteral(descriptor.nullable)}`]),
    ];
    return `{${properties.join(",")}}`;
  };
  const usesPresets = filterEntities.some(({ filterDescriptors }) =>
    filterDescriptors.some((descriptor) => presetTable(descriptor) !== null),
  );
  const runtimeRoster = filterEntities
    .map(
      ({ key, filterDescriptors }) =>
        `${JSON.stringify(key)}:[${filterDescriptors.map(runtimeDescriptor).join(",")}],`,
    )
    .join("\n");
  return [
    {
      relativePath:
        "apps/web/src/entities/generated/entity-filter-bindings.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import { parseShortcodeFor } from "@cubby/schemas/identifiers";\n' +
        (usesPresets
          ? 'import { presetExpand } from "~/entities/filter-presets";\n'
          : "") +
        `${runtimeImports}\n` +
        'import type { FilterSpec } from "../filter-manifest";\n\n' +
        "// Generated runtime filter assembly stays one entity per line.\n// oxfmt-ignore\n" +
        `export const generatedEntityFilters = {\n${runtimeRoster}\n} satisfies Record<Entity, readonly FilterSpec[]>;\n`,
    },
  ];
};
