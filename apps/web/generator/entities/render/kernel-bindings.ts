import type { EdgeDefinition } from "@cubby/schemas/entity-definitions/edges";
import { renderEdgePolicyChecks } from "../edges.ts";
import { rawSource } from "../../artifacts.ts";
import { generatedHeader } from "../../artifacts.ts";
import { EntityDeclarationError } from "../declarations.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  SourceRef,
} from "../declarations.ts";
import { kernelEntitiesFor } from "./shared.ts";
import { ordinaryWriteFields } from "./schema-contracts.ts";
import { kernelActionsFor } from "./capabilities.ts";

/**
 * A kernel entity's repository port names its `defineRepository(...)`
 * export, which is the kernel binding itself.
 */
const adapterName = (entity: CompiledEntity): string =>
  entity.ports.repository?.export ?? `${entity.key}DefaultRepository`;

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
  edges: readonly EdgeDefinition[] = [],
): EntityArtifacts[] => {
  const kernelEntities = kernelEntitiesFor(entities);
  const defaultEntities = kernelEntities.filter(
    (entity) => entity.ports.repository === null,
  );
  const unsupportedReads = (entity: CompiledEntity) => {
    const supported = new Set([
      "id",
      "machinery",
      "dataQuality",
      "fieldResolutions",
      "storedProjectionVersions",
      ...entity.fieldModel.storage.map((field) => field.key),
      ...Object.entries(entity.listFields.derived).flatMap(([key, field]) =>
        field.shape === "value" && (field.rollup || field.fromResult)
          ? [key]
          : [],
      ),
    ]);
    return entity.readFields.filter((key) => !supported.has(key));
  };
  const unsupportedListBindings = (entity: CompiledEntity) => [
    ...Object.entries(entity.listFields.derived).flatMap(([key, field]) =>
      field.shape === "predicate" ||
      (field.shape === "value" && !field.rollup && !field.fromResult)
        ? key === "machineryStage" || key === "machineryActor"
          ? []
          : [key]
        : [],
    ),
    ...Object.entries(entity.listFields.rows).flatMap(([key, rows]) =>
      rows.storage.kind === "repository" ? [key] : [],
    ),
    ...Object.keys(entity.listScopes.scopes),
  ];
  for (const entity of defaultEntities) {
    if (!entity.table || !entity.contract || !entity.shortcode)
      throw new EntityDeclarationError(
        `${entity.key}: default repository requires stored table, shortcode identity and read contracts.`,
      );
    const actions = kernelActionsFor(entity);
    for (const operation of ["create", "update"] as const) {
      if (
        actions.includes(operation) &&
        !ordinaryWriteFields(entity, operation)
      )
        throw new EntityDeclarationError(
          `${entity.key}.${operation}: default repository cannot prepare all declared stored fields (${entity.fieldModel[operation].join(", ")}); declare a domain repository for unsupported writes.`,
        );
    }
    if (actions.includes("merge"))
      throw new EntityDeclarationError(
        `${entity.key}.merge requires an explicit merge policy implementation.`,
      );
    const bindings = unsupportedListBindings(entity);
    if (bindings.length)
      throw new EntityDeclarationError(
        `${entity.key}: default repository requires domain list bindings (${bindings.join(", ")}); declare a repository implementation.`,
      );
    const unsupported = unsupportedReads(entity);
    if (unsupported.length)
      throw new EntityDeclarationError(
        `${entity.key}: default repository cannot read undeclared stored projections (${unsupported.join(", ")}); declare a read implementation.`,
      );
  }
  const factoryEntities = defaultEntities.filter(
    (entity) =>
      entity.table &&
      entity.contract &&
      entity.shortcode &&
      unsupportedReads(entity).length === 0 &&
      unsupportedListBindings(entity).length === 0 &&
      ["create", "update"].every(
        (operation) =>
          !kernelActionsFor(entity).includes(operation) ||
          ordinaryWriteFields(
            entity,
            operation === "create" ? "create" : "update",
          ) !== null,
      ),
  );
  const defaultDefinition = (entity: CompiledEntity) => {
    const actions = kernelActionsFor(entity);
    const name = `${entity.key}DefaultRepository`;
    const factory = `create${entity.key[0]?.toUpperCase()}${entity.key.slice(1)}DefaultRepository`;
    const scaffold = `${entity.key}DefaultScaffold`;
    const table = `${entity.key}DefaultTable`;
    const crud = `${entity.key}DefaultCrud`;
    const key = JSON.stringify(entity.key);
    const writable = actions.includes("create") || actions.includes("update");
    const searchFields = entity.fieldModel.storage.filter(
      (field) =>
        field.kind === "text" && entity.fieldModel.output.includes(field.key),
    );
    const title = entity.fieldModel.storage.find(
      (field) => field.key === entity.inspector.titleField,
    );
    if (
      entity.descriptor.searchable === true &&
      !entity.ports.search.read &&
      !title
    )
      throw new EntityDeclarationError(
        `${entity.key}: ordinary search requires a stored title or an explicit search read port.`,
      );
    const search = entity.ports.search.read
      ? `${entity.key}DefaultSearch`
      : entity.descriptor.searchable === true
        ? `storedSearchRead({entity: ${key}, table: ${table}, title: ${table}[${JSON.stringify(title?.key)}], keywords: [${searchFields
            .filter((field) => field.key !== title?.key)
            .map((field) => `${table}[${JSON.stringify(field.key)}]`)
            .join(",")}]})`
        : null;
    const read = `{ media: true${search ? `, search: ${search}` : ""} }`;

    const updateType = actions.includes("update")
      ? `Awaited<ReturnType<(typeof ENTITY_STORED_WRITES)[${key}]["update"]>>["data"]`
      : "never";
    const declaration = writable
      ? `const ${crud} = createEntityCrud({ entity: ${key}, table: ${table}, scaffold: ${scaffold}, output: ${entity.key}SchemaBindings.repositoryOutput, toUpdate: (data: ${updateType}) => data, auditUpdateFields: [...entityFieldModels[${key}].audit] });`
      : "";
    return `${entity.ports.repository === null ? "" : "export "}const ${factory} = () => { const ${scaffold} = listScaffold(${key}, ${table}, { readSchema: ${entity.key}RepositoryReadSchema, read: ${read} });\n${declaration}\nreturn defineRepository(${key}, { schemas: ${entity.key}SchemaBindings, scaffold: ${scaffold}, ${actions.includes("create") ? `create: asActor(${crud}.createWriter(ENTITY_STORED_WRITES[${key}].create, (output, entityId) => ({output, entityId}))),` : ""} ${actions.includes("update") ? `update: asActor(${crud}.updateWriter(ENTITY_STORED_WRITES[${key}].update, (output, entityId) => ({output, entityId}))),` : ""} }); };${entity.ports.repository === null ? `\nexport const ${name} = ${factory}();` : ""}`;
  };
  const defaultImportsFor = (factoryEntities: readonly CompiledEntity[]) => {
    const writableDefaults = factoryEntities.some((entity) =>
      kernelActionsFor(entity).some(
        (action) => action === "create" || action === "update",
      ),
    );
    const defaultImports = factoryEntities.length
      ? [
          'import { listScaffold } from "~/server/generic/list/repo/list";',
          ...(factoryEntities.some(
            (entity) =>
              entity.descriptor.searchable === true &&
              !entity.ports.search.read,
          )
            ? [
                'import { storedSearchRead } from "~/server/generic/search/repo/search-read-port";',
              ]
            : []),
          ...factoryEntities.flatMap((entity) =>
            entity.ports.search.read
              ? [
                  `import { ${entity.ports.search.read.export} as ${entity.key}DefaultSearch } from ${JSON.stringify(entity.ports.search.read.module)};`,
                ]
              : [],
          ),
          writableDefaults
            ? 'import { createEntityCrud, defineRepository, asActor } from "~/server/entity-kernel/repo/repository";'
            : 'import { defineRepository } from "~/server/entity-kernel/repo/repository";',
          ...(writableDefaults
            ? [
                'import { ENTITY_STORED_WRITES } from "~/server/generated/entity-write-bindings.gen";',
                'import { entityFieldModels } from "@cubby/schemas/entity-fields";',
              ]
            : []),
          ...factoryEntities.map(
            (entity) =>
              `import { ${entity.key}SchemaBindings, ${entity.key}RepositoryReadSchema } from "~/entity/generated/entity-schema-bindings.${entity.key}.gen";`,
          ),
          ...factoryEntities.map(
            (entity) =>
              `import { ${entity.table?.exportName} as ${entity.key}DefaultTable } from "~/server/db/schema";`,
          ),
        ].join("\n")
      : "";
    return defaultImports;
  };
  const runtimeAdapterImports = new Map<string, Set<string>>();
  for (const entity of kernelEntities) {
    const adapter = entity.ports.repository;
    if (adapter === null) continue;
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
  const reportBindings = kernelEntities
    .filter((e) => e.ports.reports)
    .map(
      (e) =>
        `  ${JSON.stringify(e.key)}: () => import(${JSON.stringify(e.ports.reports!.module)}).then(m => m.${e.ports.reports!.export}),`,
    )
    .join("\n");
  const readBindings = kernelEntities
    .map((entity) => {
      const key = JSON.stringify(entity.key);
      const adapter = entity.ports.repository;
      const load = ["inventory", "meal", "run"].includes(entity.key)
        ? `import("~/server/domains/${entity.key}/repo/${entity.key === "run" ? "run" : "crud"}").then(m => m.${entity.key}Scaffold)`
        : adapter
          ? `import(${JSON.stringify(adapter.module)}).then(m => m.${adapter.export}.repository.scaffold)`
          : `import("~/server/generated/entity-default-repository.${entity.key}.gen").then(m => m.${adapterName(entity)}.repository.scaffold)`;
      const coreLoad = adapter
        ? `import(${JSON.stringify(adapter.module)}).then(m => m.${adapter.export})`
        : `import("~/server/generated/entity-default-repository.${entity.key}.gen").then(m => m.${adapterName(entity)})`;
      const title = entity.fieldModel.storage.find(
        (field) =>
          field.key ===
          entity.fieldModel.fields.find(
            (field) => field.readKey === entity.inspector.titleField,
          )?.key,
      );
      const composed =
        !title || ["inventory", "meal", "run"].includes(entity.key);
      return `  ${key}: { load: () => ${coreLoad}, title: ${composed ? `async () => (await ${load}).title()` : title && entity.table ? `() => sql.raw(${JSON.stringify(`"${entity.table.name}"."${title.column}"::text`)})` : `() => undefined`}, fieldReads: async (db: RepositoryQueryInput, codes: readonly string[], keys?: readonly string[]) => (await ${load}).fieldReads(db, codes, keys) },`;
    })
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
          ports.reports,
          ports.fieldEnvelope,
          ports.references.label,
          ports.references.resolver,
          ports.filters,
          ports.search.read,
          ports.search.projection,
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
      source: rawSource(
        generatedHeader +
          "// Rooted independently in the owning client/server program; nothing imports this file.\n" +
          [...aliases]
            .map(
              ([module, alias]) =>
                `import type * as ${alias} from ${JSON.stringify(module)};`,
            )
            .join("\n") +
          "\n\n/** Every declared module/export reference must exist. */\n" +
          `export type EntityPortExportChecks = readonly [${refs.map((ref) => `typeof ${aliases.get(ref.module)}[${JSON.stringify(ref.export)}]`).join(", ")}];\n` +
          (server ? renderEdgePolicyChecks(edges) : ""),
      ),
    };
  };
  return [
    ...factoryEntities.map((entity) => ({
      relativePath: `apps/web/src/server/generated/entity-default-repository.${entity.key}.gen.ts`,
      source: rawSource(
        generatedHeader +
          defaultImportsFor([entity]) +
          "\n" +
          defaultDefinition(entity) +
          "\n",
      ),
    })),
    {
      relativePath:
        "apps/web/src/server/generated/entity-kernel-bindings.gen.ts",
      source: rawSource(
        generatedHeader +
          'import { sql } from "drizzle-orm";\n' +
          'import type { Entity } from "@cubby/schemas/entity";\n' +
          'import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";\n' +
          `const ENTITY_READ_BINDINGS = {\n${readBindings}\n};\n` +
          `export function repositoryReadBinding(entity: Entity) { const binding = Object.entries(ENTITY_READ_BINDINGS).find(([key]) => key === entity)?.[1]; if (!binding) throw new Error(\`No repository read binding for \${entity}\`); return binding; }\n` +
          `export const ENTITY_REPORT_BINDINGS = {\n${reportBindings}\n};\n`,
      ),
    },
    portChecks(false),
    portChecks(true),
    {
      relativePath:
        "apps/web/src/server/generated/entity-kernel-runtime.gen.ts",
      source: rawSource(
        generatedHeader +
          'import type { EntityKernelCoreBinding } from "~/server/entity-kernel/adapter";\n' +
          'import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";\n' +
          'import type { TimelineEntity } from "~/entity/generated/entity-timelines.gen";\n' +
          'import type { EntityTimelineImplementation } from "~/server/generic/entity-timeline/service/contracts";\n\n' +
          'import { defineEntityOperations } from "~/server/entity-kernel/entity-operations";\n' +
          `${runtimeAdapterImportSource}\n` +
          `${timelineImportSource}\n\n` +
          factoryEntities
            .map(
              (entity) =>
                `import { ${adapterName(entity)} } from "~/server/generated/entity-default-repository.${entity.key}.gen";`,
            )
            .join("\n") +
          "\n" +
          "type CorrelatedEntityKernelBindings = {\n" +
          "  [E in EntityKernelEntity]: EntityKernelCoreBinding<E>;\n" +
          "};\n\n" +
          "// Generated runtime assembly stays one entity per line.\n// oxfmt-ignore\n" +
          `export const ENTITY_KERNEL_BINDINGS = {\n${runtimeBindings}\n} as const satisfies CorrelatedEntityKernelBindings;\n` +
          "// Generated operation closures retain each binding's schema correlation.\n// oxfmt-ignore\n" +
          `export const ENTITY_KERNEL_OPERATIONS = {\n${runtimeOperations}\n} as const;\n` +
          "// Custom timeline implementations, keyed by entity; default-timeline entities are absent.\n// oxfmt-ignore\n" +
          `export const ENTITY_TIMELINE_BINDINGS = {\n${timelineBindings}\n} as const satisfies { [E in TimelineEntity]?: EntityTimelineImplementation<E> };\n`,
      ),
    },
  ];
};
