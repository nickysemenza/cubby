import { hasGenericListOperation } from "../list-capabilities.ts";
import { generatedHeader } from "../../artifacts.ts";
import { EntityDeclarationError } from "../declarations.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  SourceRef,
} from "../declarations.ts";
import { kernelEntitiesFor } from "./shared.ts";

/**
 * A kernel entity's repository port names its `defineRepository(...)`
 * export, which is the kernel binding itself.
 */
const adapterName = (entity: CompiledEntity): string =>
  entity.ports.repository?.export ?? "";

/**
 * The runtime kernel-entity binding module (each kernel entity's repository
 * adapter and its `defineEntityOperations` closure), plus a separate
 * type-level check (`EntityPortExportChecks`) that every declared port source
 * reference actually exists on its module — without importing it for real.
 *
 * The check lives in its own file that nothing imports: several ports are
 * client modules, and type-importing them from the server bindings tied every
 * server module to the route tree, so any edit re-checked most of the program
 * (`git show 18f8bd430:docs/reports/local-check-performance.md`).
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
  // A mixed check file joins both programs even though nothing imports it.
  // Keep every export check, rooted in the program that owns its module.
  const portChecks = (server: boolean): EntityArtifacts => {
    const refs = portExportChecks.filter(
      (ref) => ref.module.startsWith("~/server/") === server,
    );
    const aliases = new Map(
      [...new Set(refs.map((ref) => ref.module))]
        .sort()
        .map((module, index) => [module, `entityPortModule${index}`]),
    );
    return {
      relativePath: `apps/web/src/${server ? "server" : "entity"}/generated/entity-port-checks.gen.ts`,
      source:
        generatedHeader +
        "// Rooted independently in the owning client/server program; nothing imports this file.\n" +
        [...aliases]
          .map(
            ([module, alias]) =>
              `import type * as ${alias} from ${JSON.stringify(module)};`,
          )
          .join("\n") +
        "\n\n/** Every declared module/export reference must exist. */\n" +
        `export type EntityPortExportChecks = readonly [${refs.map((ref) => `typeof ${aliases.get(ref.module)}[${JSON.stringify(ref.export)}]`).join(", ")}];\n`,
    };
  };
  return [
    portChecks(false),
    portChecks(true),
    {
      relativePath:
        "apps/web/src/server/generated/entity-kernel-bindings.gen.ts",
      source:
        generatedHeader +
        'import type { EntityKernelCoreBinding } from "~/server/entity-kernel/adapter";\n' +
        'import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";\n' +
        'import type { TimelineEntity } from "~/entity/generated/entity-timelines.gen";\n' +
        'import type { EntityTimelineImplementation } from "~/server/generic/entity-timeline/service/contracts";\n\n' +
        'import { defineEntityOperations } from "~/server/entity-kernel/entity-operations";\n' +
        `${runtimeAdapterImportSource}\n` +
        `${timelineImportSource}\n\n` +
        "type CorrelatedEntityKernelBindings = {\n" +
        "  [E in EntityKernelEntity]: EntityKernelCoreBinding<E>;\n" +
        "};\n\n" +
        "// Generated runtime assembly stays one entity per line.\n// oxfmt-ignore\n" +
        `export const ENTITY_KERNEL_BINDINGS = {\n${runtimeBindings}\n} as const satisfies CorrelatedEntityKernelBindings;\n` +
        "// Generated operation closures retain each binding's schema correlation.\n// oxfmt-ignore\n" +
        `export const ENTITY_KERNEL_OPERATIONS = {\n${runtimeOperations}\n} as const;\n` +
        "// Custom timeline implementations, keyed by entity; default-timeline entities are absent.\n// oxfmt-ignore\n" +
        `export const ENTITY_TIMELINE_BINDINGS = {\n${timelineBindings}\n} as const satisfies { [E in TimelineEntity]?: EntityTimelineImplementation<E> };\n`,
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-list-read-bindings.gen.ts",
      source:
        generatedHeader +
        'import { deferredService } from "~/server/http/deferred-service";\n' +
        'import { defineProgressiveListOperations } from "~/server/entity-kernel/list-read";\n\n' +
        "// Only the selected entity loads its authoritative repository. No context is retained.\n" +
        `export const ENTITY_LIST_READ_OPERATIONS = {\n${kernelEntities
          .filter((entity) => hasGenericListOperation(entity))
          .map((entity) => {
            const port = entity.ports.repository;
            if (port === null)
              throw new EntityDeclarationError(
                `${entity.key}.ports.repository is required for a list reader.`,
              );
            return `  ${JSON.stringify(entity.key)}: deferredService(async () => defineProgressiveListOperations((await import(${JSON.stringify(port.module)})).${port.export}), () => ({})),`;
          })
          .join("\n")}\n} as const;\n`,
    },
  ];
};
