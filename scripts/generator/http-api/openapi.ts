import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateOpenApi, type SchemaTransformerSync } from "@ts-rest/open-api";
import { z } from "zod";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { KernelActions } from "../entities/render/index.ts";
import type { HttpMetadata } from "../../../apps/web/src/lib/http-api/router.ts";
import {
  discriminatorOf,
  passThrough,
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
  nameStructuralComponents,
  openTupleItems,
  optionalNullableProperties,
  residualNullPointers,
} from "./document-passes.ts";
import { registerDiscriminatedUnionMembersForIo } from "./discriminator-registration.ts";
import type { EntityOutputs } from "./api-types.ts";
import { renderEntityKernelArtifacts } from "./entity-kernel.ts";
import { renderNativeArtifacts } from "./native.ts";
import { pascal, registerSchemaNames } from "./schema-names.ts";
import { NATIVE_TYPED_RECORDS, TYPE_OVERRIDES } from "./type-overrides.ts";

const WEB_SRC = new URL("../../../apps/web/src/", import.meta.url);
const webModule = (path: string) =>
  import(pathToFileURL(join(WEB_SRC.pathname, path)).href);

/**
 * Production's session cookie: Secure cookies get better-auth's `__Secure-`
 * prefix. The document is committed for the Apple client, so nothing
 * rewrites this at request time.
 */
const SESSION_COOKIE_NAME = "__Secure-better-auth.session_token";

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

  // No route reaches the keep-list records, so project them here: a named
  // export by its name, an entity detail under `<Entity>Detail`.
  const { getEntityDetailOutputSchema } = await webModule(
    "entity/generated/entity-details.gen.ts",
  );
  for (const name of NATIVE_TYPED_RECORDS) {
    const exported = named.get(name);
    if (exported !== undefined) {
      toWire(exported, "output");
      continue;
    }
    const entity = /^(?<entity>[A-Z][a-z]+)Detail$/u.exec(name)?.groups?.entity;
    if (entity === undefined)
      throw new Error(
        `NATIVE_TYPED_RECORDS: ${name} is neither an export nor <Entity>Detail`,
      );
    registries.output.add(
      toWire(getEntityDetailOutputSchema(entity.toLowerCase()), "output"),
      { id: name },
    );
  }

  // A named domain schema's wire projections are components under the export
  // name, so a nested reference resolves to `#/components/schemas/<Name>`
  // directly. A scalar projects to the same instance on both sides and keeps
  // one name; an object that serves both sides gets an `Input` twin.
  for (const [name, domain] of named) {
    // A schema reached only through a `z.lazy` has no projection until the
    // document walks it, so a pass-through scalar export is projected here
    // to keep its name (`SignedProductQuantity` inside `SplitExpenseOut`).
    if (
      wireProjection(domain, "output") === undefined &&
      wireProjection(domain, "input") === undefined &&
      passThrough.has(domain._zod.def.type)
    )
      toWire(domain, "output");
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
        override: schemaOverride(io),
      }),
    );

  /**
   * Zod emits `additionalProperties: false` on every object in `output`
   * mode, and swift-openapi-generator turns that into
   * `ensureNoAdditionalProperties` in each `init(from:)` — so an installed
   * native build rejected every response the server had gained a field on.
   * Outputs are therefore left open (a client ignores what it does not
   * know); inputs stay closed so an unknown request key is still refused.
   */
  const schemaOverride =
    (
      io: "input" | "output",
    ): NonNullable<Parameters<typeof z.toJSONSchema>[1]>["override"] =>
    ({ zodSchema, jsonSchema }) => {
      delete jsonSchema.mock;
      delete jsonSchema.mockValue;
      // Structured-editor annotations (`value-schema.ts`) are not OpenAPI keywords.
      delete jsonSchema.opaque;
      delete jsonSchema.createOnly;
      delete jsonSchema.notice;
      if (io === "output" && jsonSchema.additionalProperties === false)
        delete jsonSchema.additionalProperties;
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
   * the operation's name.
   */
  const routeComponentId = (
    metadata: HttpMetadata,
    type: "body" | "response",
  ): string => {
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
        operation.tags = [metadata.operation.split(".")[0]!];
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
        return operation;
      },
      schemaTransformer: ({ schema, appRoute, type }) => {
        if (!(schema instanceof z.ZodType) || type === "header") return null;
        if (type === "path")
          throw new Error(
            `${appRoute.path}: HTTP routes take no path parameters`,
          );
        // A query schema is the coercing projection: emitted on its output
        // side so a parameter documents the logical type (integer, boolean,
        // array) rather than the text it accepts.
        if (type === "query")
          return asSchemaObject(
            parameterObject(inlineSchema(schema, "output")),
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

  // `schemaTransformer` above only registers the ROUTE-LEVEL schema it was
  // asked to convert, so a discriminated union nested inside a route's
  // input/output never gets its members added to `registries[io]` — see
  // `discriminator-registration.ts` for why, and why this closes the gap.
  for (const io of ["input", "output"] as const)
    registerDiscriminatedUnionMembersForIo(registries[io], io, named.values());

  const emitted: Record<string, JsonSchema> = {};
  for (const io of ["input", "output"] as const) {
    const { schemas } = z.toJSONSchema(registries[io], {
      target: "draft-2020-12",
      io,
      reused: "ref",
      unrepresentable: "any",
      uri: (id) =>
        `#/components/schemas/${id === "__shared" ? `${io}___shared` : id}`,
      override: schemaOverride(io),
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
    nameStructuralComponents,
  ];
  const components = pruneUnreachableComponents(
    document,
    untypeJsonValueComponents(
      passes.reduce((current, pass) => pass(current), emitted),
    ),
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
   * the passes: anonymous names are normalized before sorting the document.
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
 * Lists render from the entity manifest: the Apple client reads these bodies
 * as `JSONValue` and the server parses each with the entity's own schema, so
 * their per-entity variants (~170 generated types) were compile cost only.
 */
const JSON_VALUE_COMPONENTS = [
  "EntityListBaseOutput",
  "EntityListEnrichmentInput",
  "EntityListEnrichmentOutput",
  "EntityListInput",
  "EntityListSummaryOutput",
] as const;

const untypeJsonValueComponents = (components: Record<string, JsonSchema>) => {
  const untyped = { ...components };
  for (const name of JSON_VALUE_COMPONENTS) {
    if (untyped[name] === undefined)
      throw new Error(
        `JSONValue component #/components/schemas/${name} is not in the document`,
      );
    untyped[name] = { type: "object", additionalProperties: true };
  }
  return untyped;
};

/**
 * Only the components some path reaches survive: every named export is
 * registered as a component whether or not a route uses it, and each unused
 * one is another type a generated client carries. The overrides must name
 * live components (a stale override makes swift-openapi-generator fail).
 */
const pruneUnreachableComponents = (
  document: OpenApiDocument,
  components: Record<string, JsonSchema>,
): Record<string, JsonSchema> => {
  const reachable = new Set<string>();
  const queue = [...refsIn(document.paths), ...NATIVE_TYPED_RECORDS];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (reachable.has(name)) continue;
    reachable.add(name);
    queue.push(...refsIn(components[name]));
  }
  const missingRecords = NATIVE_TYPED_RECORDS.filter(
    (name) => components[name] === undefined,
  );
  if (missingRecords.length > 0)
    throw new Error(
      `NATIVE_TYPED_RECORDS name missing components: ${missingRecords.join(", ")}`,
    );
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
 * Stage 3 of `pnpm generate`: the OpenAPI document and everything derived
 * from it. Imports stage 2's `http-contract.gen.ts` from disk, so it runs
 * after that file is written.
 */
export async function renderHttpApiArtifacts(
  actions: KernelActions,
  nativeOperations: readonly string[],
  entityOutputs: EntityOutputs,
): Promise<EntityArtifacts[]> {
  const { document, components, serialized } = await buildOpenApiDocument();
  return [
    // swift-openapi-generator's SwiftPM build plugin reads the document and
    // its config from the CubbyAPI target's own source directory.
    {
      relativePath: "apps/apple/CubbyKit/Sources/CubbyAPI/openapi.json",
      source: serialized,
    },
    ...renderNativeArtifacts(
      document,
      components,
      actions,
      nativeOperations,
      entityOutputs,
    ),
    ...renderEntityKernelArtifacts(actions, nativeOperations),
  ];
}
