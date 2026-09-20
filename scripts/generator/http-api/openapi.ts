import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateOpenApi, type SchemaTransformerSync } from "@ts-rest/open-api";
import { z } from "zod";
import type {
  CompiledEntity,
  EntityArtifacts,
} from "../entities/declarations.ts";
import type { HttpResources } from "../entities/render/index.ts";
import type { HttpMetadata } from "../../../apps/web/src/lib/http-api/router.ts";
import {
  discriminatorOf,
  toWire,
  wireProjection,
  wireRegistry,
} from "../../../apps/web/src/lib/http-api/wire.ts";
import {
  collapseNullableUnions,
  isObjectSchema,
  type JsonSchema,
  collapseSingleAllOf,
  dropNullOnlyProperties,
  dropRequiredWithoutProperties,
  fillDiscriminatorMappings,
  flattenNestedNullables,
  foldPositionalDuplicates,
  inlineNullableComponents,
  integerLiterals,
  inlinePrimitiveComponents,
  mapSchemas,
  nameJsonValues,
  openTupleItems,
  optionalNullableProperties,
  residualNullPointers,
} from "./document-passes.ts";
import type { EntityOutputs } from "./api-types.ts";
import { NATIVE_COMPONENT_ROOTS, renderNativeArtifacts } from "./native.ts";
import { pascal, registerSchemaNames } from "./schema-names.ts";
import { TYPE_OVERRIDES } from "./type-overrides.ts";

const WEB_SRC = new URL("../../../apps/web/src/", import.meta.url);
const webModule = (path: string) =>
  import(pathToFileURL(join(WEB_SRC.pathname, path)).href);

/**
 * better-auth's default session cookie name. The served document
 * (`routes/api/v1/openapi[.]json.ts`) overwrites this with the configured
 * name at request time; the committed document only needs a stable default.
 */
const SESSION_COOKIE_NAME = "better-auth.session_token";

export type OpenApiDocument = ReturnType<typeof generateOpenApi>;

const buildOpenApiDocument = async (): Promise<{
  document: OpenApiDocument;
  components: Record<string, JsonSchema>;
  serialized: string;
}> => {
  // Component names come from the schema exports, so every exported schema is
  // registered before the contract (and with it the wire projections) loads.
  const named = await registerSchemaNames(WEB_SRC);
  const { httpContract } = await webModule(
    "lib/generated/http-contract.gen.ts",
  );
  const { httpMetadataSchema } = await webModule("lib/http-api/router.ts");
  const { checkHttpRoutes } = await webModule("lib/http-api/routes.ts");

  checkHttpRoutes(httpContract);

  const registries = {
    input: z.registry<{ id: string }>(),
    output: z.registry<{ id: string }>(),
  };
  const nativeComponentRoots = new Set<string>(NATIVE_COMPONENT_ROOTS);

  // A named domain schema's wire projections are components under the export
  // name, so a nested reference resolves to `#/components/schemas/<Name>`
  // directly. A scalar projects to the same instance on both sides and keeps
  // one name; an object that serves both sides gets an `Input` twin.
  for (const [name, domain] of named) {
    if (nativeComponentRoots.has(name)) {
      toWire(domain, "input");
      toWire(domain, "output");
    }
    const output = wireProjection(domain, "output");
    const input = wireProjection(domain, "input");
    // A pass-through projection is the domain instance itself; it can be
    // reached from either side, so it is one component on both.
    if (output === domain || input === domain) {
      for (const registry of [registries.input, registries.output])
        if (!registry.has(domain)) registry.add(domain, { id: name });
      continue;
    }
    if (output && !registries.output.has(output))
      registries.output.add(output, { id: name });
    if (input && !registries.input.has(input))
      registries.input.add(input, {
        id:
          output === undefined
            ? name
            : `${name}${name.endsWith("Input") ? "Request" : "Input"}`,
      });
  }

  /** Every route schema is real Zod, so the JSON Schema comes straight from it. */
  const inlineSchema = (schema: z.ZodType, io: "input" | "output") =>
    inlineDefinitions(
      z.toJSONSchema(schema, {
        target: "draft-2020-12",
        io,
        reused: "inline",
        unrepresentable: "any",
        override: stripMockHints,
      }),
    );

  const stripMockHints: NonNullable<
    Parameters<typeof z.toJSONSchema>[1]
  >["override"] = ({ zodSchema, jsonSchema }) => {
    delete jsonSchema.mock;
    delete jsonSchema.mockValue;
    // Zod emits `oneOf` for a discriminated union but no discriminator; the
    // mapping is filled once every member is a named component.
    const key = discriminatorOf(zodSchema);
    if (key !== undefined && jsonSchema.oneOf !== undefined)
      jsonSchema.discriminator = { propertyName: key };
  };

  /**
   * Parameters cannot reference components, and a registered leaf (a shortcode
   * schema, say) is extracted to `definitions` even when the emission is
   * inline: put every definition back where it is referenced.
   */
  function inlineDefinitions(schema: JsonSchema): JsonSchema {
    const definitions: Record<string, JsonSchema | boolean> = {};
    for (const source of [schema.definitions, schema.$defs])
      Object.assign(definitions, source ?? {});
    const { definitions: _definitions, $defs: _defs, ...root } = schema;
    const local = /^#\/(?:definitions|\$defs)\/(?<name>.+)$/u;
    const resolve = (node: JsonSchema): JsonSchema => {
      const name =
        node.$ref === undefined
          ? undefined
          : local.exec(node.$ref)?.groups?.name;
      const target = name === undefined ? undefined : definitions[name];
      if (target !== undefined && isObjectSchema(target)) {
        const { $ref: _ref, ...rest } = node;
        return { ...resolve(target), ...rest };
      }
      const copy: JsonSchema = { ...node };
      if (copy.properties)
        copy.properties = Object.fromEntries(
          Object.entries(copy.properties).map(([key, value]) => [
            key,
            isObjectSchema(value) ? resolve(value) : value,
          ]),
        );
      if (
        copy.items !== undefined &&
        !Array.isArray(copy.items) &&
        isObjectSchema(copy.items)
      )
        copy.items = resolve(copy.items);
      for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
        const members = copy[keyword];
        if (members)
          copy[keyword] = members.map((member) =>
            isObjectSchema(member) ? resolve(member) : member,
          );
      }
      return copy;
    };
    return resolve(root);
  }

  /**
   * Query and path parameters are listed individually, so their schema must be
   * one object: the query projection guarantees that for every GET route.
   */
  function parameterObject(schema: JsonSchema): JsonSchema {
    if (schema.type !== "object" || schema.anyOf || schema.oneOf)
      throw new Error("HTTP parameters must be one object schema");
    return {
      type: "object",
      required: schema.required ?? [],
      properties: schema.properties ?? {},
    };
  }

  // SAFETY: Zod emits JSON Schema 2020-12 objects; its broader type also
  // permits booleans, which no route schema produces.
  const asSchemaObject = (schema: JsonSchema) =>
    schema as NonNullable<ReturnType<SchemaTransformerSync>>;

  /**
   * The component name of a route-level schema that is not a named export:
   * resource routes name their bodies and results after the entity, RPC routes
   * after the operation.
   */
  const routeComponentId = (
    metadata: HttpMetadata,
    type: "body" | "response",
  ): string => {
    if (metadata.resource !== undefined) {
      const entity = pascal(metadata.entity ?? "");
      switch (metadata.resource) {
        case "list":
          return `${entity}ListPage`;
        case "timeline":
          return `${entity}Timeline`;
        case "get":
          return `${entity}Detail`;
        case "create":
          return `${entity}Create${type === "body" ? "Body" : "Result"}`;
        case "update":
          return `${entity}Update${type === "body" ? "Body" : "Result"}`;
        case "delete":
          return `${entity}DeleteResult`;
      }
    }
    const operation = metadata.operation.split(".").map(pascal).join("");
    return `${operation}${type === "response" ? "Output" : "Input"}`;
  };

  const document = generateOpenApi(
    httpContract,
    {
      info: { title: "Cubby API", version: "1.0.0" },
      servers: [{ url: "/" }],
      components: {
        securitySchemes: {
          apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: SESSION_COOKIE_NAME,
          },
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
      security: [{ apiKey: [] }, { sessionCookie: [] }, { bearerAuth: [] }],
    },
    {
      setOperationId: "concatenated-path",
      operationMapper: (operation, route) => {
        const metadata = httpMetadataSchema.parse(route.metadata);
        operation.tags = [metadata.entity ?? metadata.operation.split(".")[0]!];
        // Query parameters are plain form values: repeat a key for a list.
        for (const parameter of operation.parameters ?? [])
          if (!("$ref" in parameter) && parameter.in === "query")
            Object.assign(parameter, { style: "form", explode: true });
        // One `default` error response instead of seven numeric ones: a client
        // that treats any status >= 400 as a failure needs one error type, and
        // per-status cases cost a generated client a case each. The server
        // still returns the real status codes (405 too, with the same body).
        const errors = Object.entries(operation.responses).filter(
          ([status]) => Number(status) >= 400,
        );
        const [, first] = errors[0] ?? [];
        if (first !== undefined) {
          for (const [status] of errors) delete operation.responses[status];
          operation.responses.default = { ...first, description: "Error" };
        }
        if (metadata.resource === "list")
          operation.description =
            "Use page=1&pageSize=20&sort=name,-createdAt. Filters are individual query parameters: text is literal, numbers and booleans are plain, and a list repeats its key (tag=a&tag=b). Response pagination metadata remains zero-based. Resource methods depend on entity capabilities.";
        if (metadata.resource === "create") {
          const response = operation.responses[201];
          if (response && !("$ref" in response))
            response.headers = {
              Location: {
                schema: { type: "string" },
                description: "Created resource URL",
              },
            };
        }
        return operation;
      },
      schemaTransformer: ({ schema, appRoute, type }) => {
        if (!(schema instanceof z.ZodType) || type === "header") return null;
        // A query schema is the coercing projection: emitted on its output
        // side so a parameter documents the logical type (integer, boolean,
        // array) rather than the text it accepts.
        if (type === "query" || type === "path")
          return asSchemaObject(
            parameterObject(
              inlineSchema(schema, type === "query" ? "output" : "input"),
            ),
          );
        const io = type === "response" ? "output" : "input";
        const registry = registries[io];
        // Names: a named export's projection, a schema carrying its own
        // `.meta({ id })`, or the route position.
        const id =
          registry.get(schema)?.id ??
          wireRegistry.get(schema)?.id ??
          z.globalRegistry.get(schema)?.id ??
          routeComponentId(httpMetadataSchema.parse(appRoute.metadata), type);
        if (!registry.has(schema)) registry.add(schema, { id });
        return { $ref: `#/components/schemas/${id}` };
      },
    },
  );

  /** `…/input___shared#/definitions/schema0` -> `…/input_schema0`. */
  const nameSharedDefinitions = (schemas: Record<string, JsonSchema>) =>
    Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        mapSchemas(schema, (node) =>
          node.$ref === undefined
            ? node
            : {
                ...node,
                $ref: node.$ref.replace(
                  /(input|output)___shared#\/\$defs\//u,
                  "$1_",
                ),
              },
        ),
      ]),
    );

  const emitted: Record<string, JsonSchema> = {};
  for (const io of ["input", "output"] as const) {
    const { schemas } = z.toJSONSchema(registries[io], {
      target: "draft-2020-12",
      io,
      reused: "ref",
      unrepresentable: "any",
      uri: (id) =>
        `#/components/schemas/${id === "__shared" ? `${io}___shared` : id}`,
      override: stripMockHints,
    });
    for (const [id, schema] of Object.entries(schemas)) {
      if (id === "__shared") {
        for (const [name, definition] of Object.entries(schema.$defs ?? {}))
          emitted[`${io}_${name}`] = definition;
      } else emitted[id] = schema;
    }
  }
  // What the export walk could not name: shared instances a module never
  // exported. Bare primitives are inlined; bodies equal to a named component
  // (a `.describe()` clone) fold onto it.
  const passes = [
    nameSharedDefinitions,
    inlinePrimitiveComponents,
    foldPositionalDuplicates,
    nameJsonValues,
    collapseSingleAllOf,
    flattenNestedNullables,
    inlineNullableComponents,
    collapseNullableUnions,
    optionalNullableProperties,
    dropNullOnlyProperties,
    dropRequiredWithoutProperties,
    fillDiscriminatorMappings,
    integerLiterals,
    openTupleItems,
  ];
  const components = pruneUnreachableComponents(
    document,
    passes.reduce((current, pass) => pass(current), emitted),
    NATIVE_COMPONENT_ROOTS,
  );
  /**
   * Nullability the passes above could not express in a form a generated
   * client keeps. Each pointer here is a decision, not a bucket.
   */
  const RESIDUAL_NULL_ALLOWLIST = new Set<string>([
    // A map whose values may be null; a generated client reads the map type
    // and drops the value nullability, which the product summaries tolerate.
    "#/components/schemas/ProductFoodSummariesOut/additionalProperties",
  ]);
  const residual = residualNullPointers(components).filter(
    (pointer) => !RESIDUAL_NULL_ALLOWLIST.has(pointer),
  );
  if (residual.length > 0)
    throw new Error(
      `Nullable schema a generated client would drop:\n${residual.join("\n")}`,
    );

  /**
   * Emit `paths` (and each path item's methods) and `components.schemas` in
   * sorted key order. The contract registers routes in module order, so before
   * this an operation inserted mid-contract moved every later path and
   * component, and swift-openapi-generator — which renders in document order —
   * rewrote thousands of unrelated lines per addition. Sorting happens AFTER
   * the passes: `foldPositionalDuplicates` picks survivors and `nameJsonValues`
   * numbers by emission order, and those choices must not depend on the sort.
   */
  const sortedKeys = <T extends object>(record: T): T =>
    // SAFETY: same own enumerable entries, reordered; JSON key order carries no
    // meaning, so the value is the same `T` it was.
    Object.fromEntries(
      Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
    ) as T;
  const sortedPaths = sortedKeys(
    Object.fromEntries(
      Object.entries(document.paths).map(([route, item]) => [
        route,
        sortedKeys(item),
      ]),
    ),
  );

  const serialized = `${JSON.stringify(
    {
      ...document,
      openapi: "3.1.0",
      paths: sortedPaths,
      components: { ...document.components, schemas: sortedKeys(components) },
    },
    (key, value) => {
      if (key === "$id" || key === "$schema") return undefined;
      if (key === "$ref")
        return z
          .string()
          .parse(value)
          .replace(/(input|output)___shared#\/\$defs\//u, "$1_");
      return value;
    },
    2,
  )}\n`;
  return { document, components, serialized };
};

const queryParameters = z.array(
  z.looseObject({ name: z.string().optional(), in: z.string().optional() }),
);

const componentName = (ref: string) =>
  ref.startsWith("#/components/schemas/")
    ? ref.slice("#/components/schemas/".length)
    : undefined;

/** The component names a JSON value references (`#/components/schemas/<name>`). */
const refsIn = (value: OpenApiDocument["paths"] | JsonSchema | undefined) =>
  [...JSON.stringify(value ?? null).matchAll(/"\$ref":"([^"]+)"/gu)].flatMap(
    (match) => {
      const name = componentName(match[1] ?? "");
      return name === undefined ? [] : [name];
    },
  );

/**
 * Only the components some path reaches survive: every named export is
 * registered as a component whether or not a route uses it, and each unused
 * one is another type a generated client carries. The overrides must name
 * live components (a stale override makes swift-openapi-generator fail).
 */
const pruneUnreachableComponents = (
  document: OpenApiDocument,
  components: Record<string, JsonSchema>,
  additionalRoots: readonly string[] = [],
): Record<string, JsonSchema> => {
  const reachable = new Set<string>();
  const missingRoots = additionalRoots.filter((name) => !(name in components));
  if (missingRoots.length > 0)
    throw new Error(
      `Native OpenAPI component roots do not exist: ${missingRoots.join(", ")}`,
    );
  const queue = [...refsIn(document.paths), ...additionalRoots];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (reachable.has(name)) continue;
    reachable.add(name);
    queue.push(...refsIn(components[name]));
  }
  const missingOverrides = Object.keys(TYPE_OVERRIDES).filter(
    (name) => !reachable.has(name),
  );
  if (missingOverrides.length > 0)
    throw new Error(
      `TYPE_OVERRIDES name components no route reaches: ${missingOverrides.join(", ")}`,
    );
  return Object.fromEntries(
    Object.entries(components).filter(([name]) => reachable.has(name)),
  );
};

/**
 * Every compiled filter `wire` binding must be a query parameter of the
 * entity's list route: the native filter UI sends exactly those names.
 */
const checkFilterWires = (
  document: OpenApiDocument,
  resources: HttpResources,
  entities: readonly CompiledEntity[],
) => {
  const problems: string[] = [];
  for (const entity of entities) {
    const resource = resources[entity.key];
    if (resource === undefined || !resource.verbs.includes("list")) continue;
    const route = document.paths[`/api/v1/${resource.basePath}`]?.get;
    const parameters = new Set(
      queryParameters
        .parse(route?.parameters ?? [])
        .flatMap((parameter) =>
          parameter.in === "query" && parameter.name !== undefined
            ? [parameter.name]
            : [],
        ),
    );
    for (const descriptor of entity.filterDescriptors) {
      const names =
        descriptor.wire.kind === "param"
          ? [descriptor.wire.name]
          : [
              descriptor.wire.from,
              descriptor.wire.to,
              ...(descriptor.wire.presence === undefined
                ? []
                : [descriptor.wire.presence]),
            ];
      for (const name of names)
        if (!parameters.has(name))
          problems.push(
            `${entity.key}.filters.${descriptor.columnId} binds to ${name}, which is not a query parameter of GET /${resource.basePath}`,
          );
    }
  }
  if (problems.length > 0)
    throw new Error(
      `Filter wire bindings do not match the list routes:\n${problems.join("\n")}`,
    );
};

/**
 * Stage 3 of `pnpm generate`: the OpenAPI document and everything derived
 * from it. Imports stage 2's `http-contract.gen.ts` from disk, so it runs
 * after that file is written.
 */
export async function renderHttpApiArtifacts(
  resources: HttpResources,
  nativeOperations: readonly string[],
  entityOutputs: EntityOutputs,
  entities: readonly CompiledEntity[],
): Promise<EntityArtifacts[]> {
  const { document, components, serialized } = await buildOpenApiDocument();
  checkFilterWires(document, resources, entities);
  return [
    {
      relativePath: "apps/web/src/lib/generated/http-openapi.gen.json",
      source: serialized,
    },
    ...renderNativeArtifacts(
      document,
      components,
      resources,
      nativeOperations,
      entityOutputs,
    ),
  ];
}
