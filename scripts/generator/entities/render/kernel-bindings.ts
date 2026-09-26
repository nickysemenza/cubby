import { generatedHeader } from "../../artifacts.ts";
import { EntityDeclarationError } from "../declarations.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  SourceRef,
} from "../declarations.ts";
import { kernelEntitiesFor } from "./shared.ts";

/**
 * A repository port whose export ends in `Repository` is a standard
 * `(db, input, actor)` repository object; its kernel adapter is emitted here
 * rather than hand-written. Any other export is a hand-written adapter.
 */
const isStandardRepository = (exportName: string): boolean =>
  exportName.endsWith("Repository");

const adapterName = (entity: CompiledEntity): string => {
  const port = entity.ports.repository;
  if (port === null) return "";
  return isStandardRepository(port.export)
    ? `${entity.key}EntityAdapter`
    : port.export;
};

/** The concrete, per-entity adapter over a standard repository object. */
const standardAdapterSource = (entity: CompiledEntity): string => {
  const repo = entity.ports.repository?.export ?? "";
  const key = JSON.stringify(entity.key);
  const methods = [
    `    get: (ctx, id) => ${repo}.get(ctx.db, id),`,
    `    list: (ctx, filters, sorts, pagination) => ${repo}.list(ctx.db, filters, sorts, pagination),`,
    ...(entity.contract?.create
      ? [
          `    create: (ctx, data) => ${repo}.create(ctx.db, data, ctx.actorContext),`,
        ]
      : []),
    ...(entity.contract?.update
      ? [
          `    update: (ctx, id, data) => ${repo}.update(ctx.db, id, data, ctx.actorContext),`,
        ]
      : []),
    ...(entity.bulkUpdateFields !== null
      ? [
          `    bulkUpdate: (ctx, ids, data) => ${repo}.bulkUpdate(ctx.db, ids, data, ctx.actorContext),`,
        ]
      : []),
    entity.lifecycle.delete === null
      ? `    delete: () => { throw new Error(${JSON.stringify(`${entity.key} declares no delete`)}); },`
      : `    delete: async (ctx, ids) => standardDeleteResult(${key}, ids, await ${repo}.delete(ctx.db, ids, ctx.actorContext)),`,
  ];
  return (
    `const ${adapterName(entity)} = defineEntityAdapter({
` +
    `  entity: ${key},
` +
    `  sideEffects: ${repo}.sideEffects,
` +
    `  lifecycle: ${repo}.lifecycle,
` +
    `  repository: {
${methods.join("\n")}
  },
});`
  );
};

/**
 * The runtime kernel-entity binding module: each kernel entity's repository
 * adapter, its `defineEntityOperations` closure, and a type-level check
 * (`EntityPortExportChecks`) that every declared port source reference
 * actually exists on its module — without importing that module for real.
 */
export const renderKernelBindingsArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const kernelEntities = kernelEntitiesFor(entities);
  const runtimeAdapterImports = new Map<string, Set<string>>();
  for (const entity of kernelEntities) {
    const adapter = entity.ports.repository;
    if (adapter === null) {
      throw new EntityDeclarationError(
        `${entity.key}.ports.repository is required for a kernel entity.`,
      );
    }
    const exports =
      runtimeAdapterImports.get(adapter.module) ?? new Set<string>();
    exports.add(adapter.export);
    runtimeAdapterImports.set(adapter.module, exports);
  }
  const runtimeAdapterImportSource = [...runtimeAdapterImports.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const standardAdapters = kernelEntities
    .filter(({ ports }) => isStandardRepository(ports.repository?.export ?? ""))
    .map(standardAdapterSource)
    .join("\n");
  const runtimeBindings = kernelEntities
    .map((entity) => `  ${JSON.stringify(entity.key)}: ${adapterName(entity)},`)
    .join("\n");
  const runtimeOperations = kernelEntities
    .map(
      (entity) =>
        `  ${JSON.stringify(entity.key)}: defineEntityOperations(${adapterName(entity)}),`,
    )
    .join("\n");
  // `capabilities.timeline: "custom"` binds the declared port; `"default"`
  // entities are served by the shared default implementation and stay out.
  const timelineEntities = kernelEntities.filter(
    ({ ports, timeline }) => timeline === "custom" && ports.timeline !== null,
  );
  const timelineImports = new Map<string, Set<string>>();
  for (const { ports } of timelineEntities) {
    const port = ports.timeline;
    if (port === null) continue;
    const exports = timelineImports.get(port.module) ?? new Set<string>();
    exports.add(port.export);
    timelineImports.set(port.module, exports);
  }
  const timelineImportSource = [...timelineImports.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const timelineBindings = timelineEntities
    .map(
      ({ key, ports }) =>
        `  ${JSON.stringify(key)}: ${ports.timeline?.export},`,
    )
    .join("\n");
  const portExportChecks = [
    ...new Map(
      entities.flatMap((entity) => {
        const { ports } = entity;
        const refs = [
          ports.repository,
          ports.references.label,
          ports.references.resolver,
          ports.filters,
          ports.search.projection,
          ports.search.semanticText,
          ports.search.dependentRefresh,
          ports.timeline,
          ...entity.relationMutations.flatMap(
            ({ itemSchema, rowSchema, adapter }) => [
              itemSchema,
              rowSchema,
              adapter,
            ],
          ),
          ...entity.filterDescriptors.flatMap((descriptor) => [
            descriptor.optionsRef,
            descriptor.expandRef,
          ]),
        ].filter((ref): ref is SourceRef => ref !== null);
        return refs.map((ref) => [`${ref.module}#${ref.export}`, ref] as const);
      }),
    ).values(),
  ].sort((left, right) =>
    `${left.module}#${left.export}`.localeCompare(
      `${right.module}#${right.export}`,
    ),
  );
  const portTypeModuleAliases = new Map(
    [...new Set(portExportChecks.map((ref) => ref.module))]
      .sort((left, right) => left.localeCompare(right))
      .map((module, index) => [module, `entityPortModule${index}`]),
  );
  const portTypeImports = [...portTypeModuleAliases.entries()]
    .map(
      ([module, alias]) =>
        `import type * as ${alias} from ${JSON.stringify(module)};`,
    )
    .join("\n");
  return [
    {
      relativePath:
        "apps/web/src/server/generated/entity-kernel-bindings.gen.ts",
      source:
        generatedHeader +
        "// Generated port aliases retain deterministic import order.\n" +
        'import { defineEntityAdapter, type EntityKernelCoreBinding, standardDeleteResult } from "~/server/entity-kernel/adapter";\n' +
        'import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";\n' +
        'import type { TimelineEntity } from "~/entities/generated/entity-timelines.gen";\n' +
        'import type { EntityTimelineImplementation } from "~/server/entity-timeline/contracts";\n\n' +
        'import { defineEntityOperations } from "~/server/entity-kernel/entity-operations";\n\n' +
        `${portTypeImports}\n\n` +
        "/** Each literal module/export source reference is checked without a runtime import. */\n" +
        `type EntityPortExportChecks = readonly [${portExportChecks
          .map(
            (ref) =>
              `typeof ${portTypeModuleAliases.get(ref.module)}[${JSON.stringify(ref.export)}]`,
          )
          .join(", ")}];\n\n` +
        `${runtimeAdapterImportSource}\n` +
        `${timelineImportSource}\n\n` +
        "// Adapters over standard `(db, input, actor)` repository objects.\n// oxfmt-ignore\n" +
        `${standardAdapters}\n\n` +
        "type CorrelatedEntityKernelBindings = {\n" +
        "  [E in EntityKernelEntity]: EntityKernelCoreBinding<E>;\n" +
        "};\n\n" +
        "// Generated runtime assembly stays one entity per line.\n// oxfmt-ignore\n" +
        `export const ENTITY_KERNEL_BINDINGS = {\n${runtimeBindings}\n} as const satisfies CorrelatedEntityKernelBindings & { readonly __portExportChecks?: EntityPortExportChecks };\n` +
        "// Generated operation closures retain each binding's schema correlation.\n// oxfmt-ignore\n" +
        `export const ENTITY_KERNEL_OPERATIONS = {\n${runtimeOperations}\n} as const;\n` +
        "// Custom timeline implementations, keyed by entity; default-timeline entities are absent.\n// oxfmt-ignore\n" +
        `export const ENTITY_TIMELINE_BINDINGS = {\n${timelineBindings}\n} as const satisfies { [E in TimelineEntity]?: EntityTimelineImplementation<E> };\n`,
    },
  ];
};
