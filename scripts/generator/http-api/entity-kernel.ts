import { z } from "zod";
import { entityTimelineWindowFor } from "../../../packages/schemas/src/entity-timeline.ts";
import { generatedEntitySort } from "../../../packages/schemas/src/generated/entity-sort.gen.ts";
import { entityInspectorMetadata } from "../../../packages/schemas/src/generated/entity-inspector.gen.ts";
import { entityKeys } from "../../../packages/schemas/src/generated/entity-summary.gen.ts";
import { ENTITY_SCHEMA_BINDINGS } from "../../../apps/web/src/server/generated/entity-bindings.gen.ts";
import { toWire } from "../../../apps/web/src/lib/http-api/wire.ts";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { KernelActions } from "../entities/render/index.ts";

/**
 * How a native filter value travels in a kernel list body. `EntityFilterState`
 * holds text; the Apple client converts each named value to this JSON kind
 * and validates enum values against `values` before sending.
 */
type ParameterType = "string" | "number" | "integer" | "boolean" | "strings";

/**
 * One native filter name. Filter state is keyed by flat names; an
 * object-valued filter field (`projectScope`) contributes one name per
 * member, re-nested under `path` in the body.
 */
interface KernelParameter {
  path: readonly [string] | readonly [string, string];
  type: ParameterType;
  values?: readonly string[];
}

interface EntityKernelCapabilities {
  /** The kernel actions the HTTP API serves for this entity. */
  actions: readonly string[];
  /** `actions` plus the reads an entity-domain `list`/`detail` RPC adds. */
  nativeActions: readonly string[];
  read: "kernel" | "usdaFood" | "unavailable";
  imageAttach: boolean;
  imageOrder: boolean;
  /** List and timeline filter names (empty when the entity has no list). */
  parameters: Readonly<Record<string, KernelParameter>>;
  groupBy: readonly string[];
}

const schemaNode = z.looseObject({
  type: z.union([z.string(), z.array(z.string())]).optional(),
  enum: z.array(z.string()).optional(),
  const: z.string().optional(),
  anyOf: z.array(z.unknown()).optional(),
  items: z.unknown().optional(),
});
type SchemaNode = z.output<typeof schemaNode>;

/** A string node's enum values; an `anyOf` of string arms merges theirs. */
const stringValues = (node: SchemaNode): string[] | null | "string" => {
  if (node.type === "string")
    return node.enum ?? (node.const === undefined ? "string" : [node.const]);
  if (node.anyOf === undefined) return null;
  const arms = node.anyOf.map((arm) => schemaNode.parse(arm));
  const values = arms.map(stringValues);
  if (values.some((value) => value === null)) return null;
  // A branded id or its sentinel const: send the plain string.
  if (values.includes("string")) return "string";
  return values.flatMap((value) => (Array.isArray(value) ? value : []));
};

const unwrap = (schema: z.ZodType): z.ZodType => {
  let inner: z.core.$ZodType = schema;
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault
  )
    inner = inner.unwrap();
  // SAFETY: every wrapper above unwraps to a Zod v4 schema.
  return inner as z.ZodType;
};

const classify = (
  schema: z.ZodType,
  context: string,
): Omit<KernelParameter, "path"> => {
  // An empty metadata registry keeps named schemas (`PlainDate`) inline
  // instead of behind a `$ref`.
  const node = schemaNode.parse(
    z.toJSONSchema(toWire(schema, "input"), {
      io: "input",
      unrepresentable: "any",
      metadata: z.registry(),
    }),
  );
  const fail = () => {
    throw new Error(
      `${context} has a schema the native kernel filter table does not cover: ${JSON.stringify(node)}`,
    );
  };
  if (node.type === "number") return { type: "number" };
  if (node.type === "integer") return { type: "integer" };
  if (node.type === "boolean") return { type: "boolean" };
  // A one-or-many filter (`T | T[]`) always travels as the list.
  const listArm = node.anyOf
    ?.map((arm) => schemaNode.parse(arm))
    .find((arm) => arm.type === "array");
  const list = node.type === "array" ? node : listArm;
  if (list !== undefined) {
    const items = stringValues(schemaNode.parse(list.items ?? {}));
    if (items === null) return fail();
    return items === "string"
      ? { type: "strings" }
      : { type: "strings", values: items };
  }
  const values = stringValues(node);
  if (values === null) return fail();
  return values === "string" ? { type: "string" } : { type: "string", values };
};

/** The top-level keys an update input accepts (through any refining pipe). */
const updateInputKeys = (schema: z.ZodType | null): ReadonlySet<string> => {
  if (schema === null) return new Set();
  let inner: z.core.$ZodType = schema;
  while (inner instanceof z.ZodPipe) inner = inner.in;
  return new Set(inner instanceof z.ZodObject ? Object.keys(inner.shape) : []);
};

type BoundEntity = keyof typeof ENTITY_SCHEMA_BINDINGS;
const isBound = (entity: string): entity is BoundEntity =>
  Object.hasOwn(ENTITY_SCHEMA_BINDINGS, entity);
const isSorted = (entity: string): entity is keyof typeof generatedEntitySort =>
  Object.hasOwn(generatedEntitySort, entity);

/** Native filter names of one entity, keyed by flat name. */
type KernelParameters = Record<string, KernelParameter>;

const parametersFor = (entity: BoundEntity, timeline: boolean) => {
  const parameters: KernelParameters = {};
  const claim = (name: string, parameter: KernelParameter) => {
    if (Object.hasOwn(parameters, name))
      throw new Error(`${entity}: native filter name collision on ${name}`);
    parameters[name] = parameter;
  };
  const filters: z.ZodObject = ENTITY_SCHEMA_BINDINGS[entity].filters;
  for (const [field, schema] of Object.entries(filters.shape)) {
    const inner = unwrap(schema);
    if (!(inner instanceof z.ZodObject)) {
      claim(field, {
        path: [field],
        ...classify(schema, `${entity}.${field}`),
      });
      continue;
    }
    for (const [key, member] of Object.entries(inner.shape)) {
      if (unwrap(member) instanceof z.ZodObject)
        throw new Error(`${entity}.${field}.${key} nests too deep`);
      claim(`${field}${key.charAt(0).toUpperCase()}${key.slice(1)}`, {
        path: [field, key],
        ...classify(member, `${entity}.${field}.${key}`),
      });
    }
  }
  if (timeline)
    for (const [name, schema] of Object.entries(
      entityTimelineWindowFor(ENTITY_SCHEMA_BINDINGS[entity].id).shape,
    ))
      claim(name, {
        path: ["window", name],
        ...classify(schema, `${entity} timeline ${name}`),
      });
  return parameters;
};

/**
 * The per-entity native capabilities, derived from the entity declarations
 * and kernel bindings rather than from HTTP routes: which kernel actions the
 * entity supports, whether its update input accepts image attach/reorder,
 * and every list/timeline filter name with its JSON kind.
 */
const entityKernelCapabilities = (
  actions: KernelActions,
  nativeOperations: readonly string[],
): Record<string, EntityKernelCapabilities> =>
  Object.fromEntries(
    entityKeys.flatMap((entity) => {
      const verbs = actions[entity] ?? [];
      const rpcReads = [
        ...(nativeOperations.includes(`${entity}.list`) ? ["list"] : []),
        ...(nativeOperations.includes(`${entity}.detail`) ? ["get"] : []),
      ];
      const nativeActions = [...new Set([...verbs, ...rpcReads])].sort();
      if (nativeActions.length === 0) return [];
      const binding = isBound(entity)
        ? ENTITY_SCHEMA_BINDINGS[entity]
        : undefined;
      const update = updateInputKeys(
        verbs.includes("update") ? (binding?.updateInput ?? null) : null,
      );
      const roster:
        | { fields: readonly string[]; groupable: readonly string[] }
        | undefined = isSorted(entity)
        ? generatedEntitySort[entity]
        : undefined;
      const listed = verbs.includes("list");
      return [
        [
          entity,
          {
            actions: [...verbs].sort(),
            nativeActions,
            read: listed
              ? "kernel"
              : entity === "usda-food" && rpcReads.includes("list")
                ? "usdaFood"
                : "unavailable",
            imageAttach: update.has("pendingImageIds"),
            imageOrder: update.has("imageOrder"),
            parameters:
              listed && isBound(entity)
                ? parametersFor(entity, verbs.includes("timeline"))
                : {},
            groupBy:
              roster === undefined
                ? []
                : roster.groupable.length > 0
                  ? roster.groupable
                  : roster.fields,
          } satisfies EntityKernelCapabilities,
        ],
      ];
    }),
  );

/**
 * Every declared filter wire name must be a native kernel filter name: the
 * native filter UI sends exactly those names.
 */
const checkFilterWires = (
  capabilities: Readonly<Record<string, EntityKernelCapabilities>>,
) => {
  const problems: string[] = [];
  for (const [entity, metadata] of Object.entries(entityInspectorMetadata)) {
    const parameters = capabilities[entity]?.parameters;
    if (parameters === undefined || Object.keys(parameters).length === 0)
      continue;
    for (const descriptor of metadata.filterDescriptors) {
      const wire: (typeof metadata.filterDescriptors)[number]["wire"] =
        descriptor.wire;
      const names =
        wire.kind === "param"
          ? [wire.name]
          : [
              wire.from,
              wire.to,
              ...("presence" in wire && wire.presence !== undefined
                ? [wire.presence]
                : []),
            ];
      for (const name of names)
        if (!Object.hasOwn(parameters, name))
          problems.push(
            `${entity}.filters.${descriptor.columnId} binds to ${name}, which is not a kernel filter of ${entity}`,
          );
    }
  }
  if (problems.length > 0)
    throw new Error(
      `Filter wire bindings do not match the kernel filters:\n${problems.join("\n")}`,
    );
};

/**
 * `entity-kernel.json` (read by CubbyKit's `EntityKernel.swift`) and the web
 * inspector's native coverage table, from one capability table.
 */
export const renderEntityKernelArtifacts = (
  actions: KernelActions,
  nativeOperations: readonly string[],
): EntityArtifacts[] => {
  const capabilities = entityKernelCapabilities(actions, nativeOperations);
  checkFilterWires(capabilities);
  const coverage = Object.fromEntries(
    entityKeys.map((entity) => [
      entity,
      {
        httpActions: capabilities[entity]?.actions ?? [],
        rpcIds: nativeOperations.filter((id) => id.split(".")[0] === entity),
      },
    ]),
  );
  return [
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/entity-kernel.json",
      source: `${JSON.stringify(capabilities, null, 2)}\n`,
    },
    {
      relativePath: "apps/web/src/lib/generated/entity-native-coverage.gen.ts",
      source: `${generatedHeader}import type { Entity } from "@cubby/schemas/entity";

/**
 * What the native app can do with an entity: the entity kernel actions its
 * generic client sends, and the RPC operation ids it calls whose domain is
 * this entity.
 */
export interface NativeCoverage {
  httpActions: readonly ("list" | "timeline" | "get" | "create" | "update" | "delete")[];
  rpcIds: readonly string[];
}

// Generated coverage stays one entity per line.
// oxfmt-ignore
export const ENTITY_NATIVE_COVERAGE = {
${entityKeys.map((entity) => `  ${JSON.stringify(entity)}: ${JSON.stringify(coverage[entity])},`).join("\n")}
} as const satisfies Record<Entity, NativeCoverage>;
`,
    },
  ];
};
