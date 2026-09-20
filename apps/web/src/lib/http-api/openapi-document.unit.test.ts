import { describe, expect, it } from "vitest";
import { z } from "zod";

import document from "~/lib/generated/http-openapi.gen.json";

/**
 * The document contract the native client relies on. Everything asserted
 * here is what swift-openapi-generator needs to produce a usable client:
 * plain query parameters, no envelope, one error body, explicit nulls,
 * discriminators with mappings, and stable component names.
 */

const schemaNode = z.looseObject({
  $ref: z.string().optional(),
  type: z.union([z.string(), z.array(z.string())]).optional(),
  required: z.array(z.string()).optional(),
  enum: z.array(z.unknown()).optional(),
  const: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  items: z.unknown().optional(),
  additionalProperties: z.unknown().optional(),
  anyOf: z.array(z.unknown()).optional(),
  oneOf: z.array(z.unknown()).optional(),
  allOf: z.array(z.unknown()).optional(),
  discriminator: z
    .object({
      propertyName: z.string(),
      mapping: z.record(z.string(), z.string()),
    })
    .optional(),
});
type SchemaNode = z.output<typeof schemaNode>;

const parameter = z.looseObject({
  name: z.string(),
  in: z.string(),
  required: z.boolean().optional(),
  style: z.string().optional(),
  explode: z.boolean().optional(),
  schema: z.unknown().optional(),
  content: z.unknown().optional(),
});
const response = z.looseObject({
  content: z
    .record(z.string(), z.looseObject({ schema: schemaNode.optional() }))
    .optional(),
});
const operation = z.looseObject({
  operationId: z.string(),
  parameters: z.array(parameter).optional(),
  requestBody: z.unknown().optional(),
  responses: z.record(z.string(), response),
});

const schemas = z
  .record(z.string(), schemaNode)
  .parse(document.components.schemas);
const paths = z
  .record(z.string(), z.record(z.string(), operation))
  .parse(document.paths);
const operations = Object.entries(paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, value]) => ({
    path,
    method,
    ...value,
  })),
);
const text = JSON.stringify(document);
const nativeProtocolRoots = [
  "BrowserBridgeClientMessage",
  "BrowserBridgeRunCompletion",
  "BrowserBridgeServerMessage",
] as const;

it("retains native WebSocket protocol components without fake HTTP routes", () => {
  expect(schemas.BrowserBridgeClientMessage).toBeDefined();
  expect(schemas.BrowserBridgeServerMessage).toBeDefined();
  expect(JSON.stringify(document.paths)).not.toContain("BrowserBridge");
});

const COMPONENT = "#/components/schemas/";
const componentName = (ref: string | undefined) =>
  ref?.startsWith(COMPONENT) ? ref.slice(COMPONENT.length) : undefined;
const resolve = (ref: string) => {
  const name = componentName(ref);
  const schema = name === undefined ? undefined : schemas[name];
  if (name === undefined || schema === undefined)
    throw new Error(`Unresolved component reference ${ref}`);
  return { name, schema };
};
const responseRef = (value: z.output<typeof response> | undefined) =>
  value?.content?.["application/json"]?.schema?.$ref;
const isPositional = (name: string) =>
  /^(?:input|output)_schema\d+$/u.test(name);

/** Every schema node in the components map, with its JSON pointer. */
function* nodes(): Generator<[string, SchemaNode]> {
  const walk = function* (
    node: unknown,
    pointer: string,
  ): Generator<[string, SchemaNode]> {
    const parsed = schemaNode.safeParse(node);
    if (!parsed.success) return;
    yield [pointer, parsed.data];
    for (const [key, value] of Object.entries(parsed.data.properties ?? {}))
      yield* walk(value, `${pointer}/properties/${key}`);
    yield* walk(parsed.data.items, `${pointer}/items`);
    yield* walk(
      parsed.data.additionalProperties,
      `${pointer}/additionalProperties`,
    );
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const)
      for (const [index, member] of (parsed.data[keyword] ?? []).entries())
        yield* walk(member, `${pointer}/${keyword}/${index}`);
  };
  for (const [name, schema] of Object.entries(schemas))
    yield* walk(schema, `${COMPONENT}${name}`);
}

/** Nullability the emitter deliberately leaves as a union (see the emitter). */
const RESIDUAL_NULL_ALLOWLIST = new Set([
  `${COMPONENT}ProductFoodSummariesOut/additionalProperties`,
]);

/** Structured-input queries travel as POST bodies; everything else is GET. */
const POST_QUERIES = [
  "/api/v1/collection/detail",
  "/api/v1/collection/matrix",
  "/api/v1/collection/smartDetail",
  "/api/v1/collection/smartList",
  "/api/v1/entity/filterOptions",
  "/api/v1/entity/graph",
  "/api/v1/entity/graphPaths",
  "/api/v1/expense/analytics",
  "/api/v1/expense/analyze",
  "/api/v1/expense/chartData",
  "/api/v1/expense/facetCounts",
  "/api/v1/expense/monthlySummary",
  "/api/v1/image/list",
  "/api/v1/ingredient/enrichmentWorkbench",
  "/api/v1/location/search",
  "/api/v1/product/search",
  "/api/v1/project/getDependencyGraph",
  "/api/v1/project/toolGallery",
  "/api/v1/project/tree",
  "/api/v1/recipe/getDependencyGraph",
  "/api/v1/recipe/getIngredientCooccurrence",
  "/api/v1/recipe/getIngredientUsage",
  "/api/v1/relatedData/summary",
  "/api/v1/statementRow/list",
  "/api/v1/statementRow/summary",
  "/api/v1/task/board",
  "/api/v1/task/chartData",
  "/api/v1/task/listActionable",
  "/api/v1/task/timeline",
  "/api/v1/usda-food/alternateId",
  "/api/v1/usda-food/list",
];

describe("generated HTTP OpenAPI document", () => {
  it("is OpenAPI 3.1 without 3.0 keywords or JSON Schema plumbing", () => {
    expect(document.openapi).toBe("3.1.0");
    for (const keyword of ['"nullable"', '"$defs"', '"$id"', '"$schema"'])
      expect(text).not.toContain(keyword);
    expect(schemas).not.toHaveProperty("ErrorEnvelope");
  });

  it("documents z.json() as one free-form JsonValue", () => {
    // A recursive anyOf with a null member is dropped by a generated client;
    // the empty schema is the same value space and generates as a container.
    expect(Object.keys(schemas.JsonValue ?? {})).toEqual(["description"]);
    expect(schemas).not.toHaveProperty("JsonValue2");
    expect(text).toContain(`"$ref":"${COMPONENT}JsonValue"`);
  });

  it("names components after their exports, with few positional survivors", () => {
    const positional = Object.keys(schemas).filter(isPositional);
    const named = Object.keys(schemas).filter((name) => !isPositional(name));
    for (const name of named) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/u);
    expect(named.length).toBeGreaterThan(900);
    // Unexported module-private schemas keep a positional name; each one
    // that appears here is a candidate for an export. This bound rose from
    // 40 once `foldPositionalDuplicates`'s canonicalization bug was fixed
    // (see the fold-bug regression test below): the old replacer-array
    // allowlist erased distinct nested shapes down to `{}`, so it had been
    // incorrectly folding distinct positionals together and undercounting.
    expect(positional.length).toBeLessThanOrEqual(70);
    expect(schemas).toHaveProperty("ProductTopLevelOut");
    expect(schemas).toHaveProperty("LocationShortcode");
    expect(schemas).toHaveProperty("VendorCreateInput");
    expect(schemas).toHaveProperty("RecipeListPage");
    expect(schemas).toHaveProperty("ProductListItem");
    expect(schemas).toHaveProperty("AiDescribeLocationOutput");
  });

  it("resolves every reference", () => {
    const references = new Set(
      [...text.matchAll(/"\$ref":"([^"]+)"/gu)].map((match) => match[1] ?? ""),
    );
    expect(references.size).toBeGreaterThan(0);
    for (const ref of references) resolve(ref);
  });

  it("carries no component unreachable from a path", () => {
    // Every component belongs either to an HTTP path or an explicit native
    // protocol root; anything else is dead weight in generated clients.
    const reachable = new Set<string>();
    const refsIn = (serialized: string): string[] =>
      [...serialized.matchAll(/"\$ref":"([^"]+)"/gu)].flatMap((match) => {
        const name = componentName(match[1]);
        return name === undefined ? [] : [name];
      });
    const queue = [
      ...refsIn(JSON.stringify(document.paths)),
      ...nativeProtocolRoots,
    ];
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      if (reachable.has(name)) continue;
      reachable.add(name);
      queue.push(...refsIn(JSON.stringify(schemas[name])));
    }
    const orphans = Object.keys(schemas).filter((name) => !reachable.has(name));
    expect(orphans).toEqual([]);
  });

  it("returns every success body without an envelope", () => {
    for (const entry of operations) {
      const successes = Object.keys(entry.responses).filter((status) =>
        ["200", "201"].includes(status),
      );
      expect(successes).toHaveLength(1);
      const ref = responseRef(entry.responses[successes[0] ?? ""]);
      if (ref === undefined) continue;
      const { name, schema } = resolve(ref);
      expect(name).not.toBe("ApiError");
      expect(
        schema.properties?.data === undefined ||
          schema.properties.ok === undefined,
      ).toBe(true);
    }
  });

  it("documents one default error response per operation, all ApiError", () => {
    const apiError = schemas.ApiError;
    expect(apiError?.required).toEqual(
      expect.arrayContaining(["code", "message"]),
    );
    expect(apiError?.properties).not.toHaveProperty("ok");
    for (const entry of operations) {
      const statuses = Object.keys(entry.responses).filter(
        (status) => !["200", "201"].includes(status),
      );
      expect(statuses).toEqual(["default"]);
      expect(resolve(responseRef(entry.responses.default) ?? "").name).toBe(
        "ApiError",
      );
    }
    expect(operations).toHaveLength(332);
  });

  it("carries query parameters as plain form values", () => {
    for (const entry of operations) {
      for (const value of entry.parameters ?? []) {
        if (value.in !== "query") continue;
        expect(value).toMatchObject({
          style: "form",
          explode: true,
        });
        expect(value.schema).toBeDefined();
        expect(value).not.toHaveProperty("content");
        expect(JSON.stringify(value.schema)).not.toContain('"$ref"');
      }
    }
    expect(
      (paths["/api/v1/tasks"]?.get?.parameters ?? [])
        .map((value) => value.name)
        .filter((name) => name.startsWith("projectScope")),
    ).toEqual([
      "projectScopeStatuses",
      "projectScopeKinds",
      "projectScopeLocations",
      "projectScopeSearch",
      "projectScopeDateFrom",
      "projectScopeDateTo",
      "projectScopeCompletionYear",
    ]);
  });

  it("enumerates every groupBy roster with identifier-safe values", () => {
    // swift-openapi-generator turns the enum into Swift cases, so a future
    // `:`/`.` groupable field (product sorts on `related:product.projects`)
    // must stay out of the roster rather than break the native client.
    const groupBys = operations.flatMap((entry) =>
      (entry.parameters ?? [])
        .filter((value) => value.name === "groupBy")
        .map((value) => [entry.operationId, value.schema] as const),
    );
    expect(groupBys.length).toBeGreaterThan(0);
    const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u);
    const unsafe = groupBys.flatMap(([operationId, schema]) => {
      const { enum: values } = schemaNode.parse(schema);
      return values === undefined || values.length === 0
        ? [`${operationId}: no enum`]
        : values
            .filter((field) => !identifier.safeParse(field).success)
            .map((field) => `${operationId}: ${JSON.stringify(field)}`);
    });
    expect(unsafe).toEqual([]);
  });

  it("serves structured queries as POST bodies and everything else as GET", () => {
    const methods = { get: 0, post: 0, patch: 0, delete: 0 };
    for (const entry of operations)
      methods[z.enum(["get", "post", "patch", "delete"]).parse(entry.method)] +=
        1;
    expect(methods).toEqual({ get: 154, post: 138, patch: 20, delete: 20 });
    for (const path of POST_QUERIES) {
      const posted = paths[path]?.post;
      expect(posted).toBeDefined();
      expect(posted?.requestBody).toBeDefined();
      expect(posted?.parameters ?? []).toEqual([]);
    }
  });

  it("spells nullability the way a generated client keeps it", () => {
    const residual: string[] = [];
    for (const [pointer, node] of nodes()) {
      for (const keyword of ["anyOf", "oneOf"] as const)
        if (
          (node[keyword] ?? []).some(
            (member) => schemaNode.safeParse(member).data?.type === "null",
          ) &&
          !RESIDUAL_NULL_ALLOWLIST.has(pointer)
        )
          residual.push(pointer);
      if (node.allOf?.length === 1) residual.push(`${pointer} (allOf of one)`);
      if (Array.isArray(node.enum) && node.enum.includes(null))
        residual.push(`${pointer} (enum with null)`);
    }
    expect(residual).toEqual([]);
    expect(text.match(/"type":\["[a-z]+","null"\]/gu)?.length).toBeGreaterThan(
      500,
    );
  });

  it("maps every discriminated union onto named member components", () => {
    let count = 0;
    for (const [, node] of nodes()) {
      if (!node.discriminator) continue;
      count += 1;
      const { propertyName, mapping } = node.discriminator;
      const members = (node.oneOf ?? []).map(
        (member) => schemaNode.parse(member).$ref ?? "",
      );
      expect(Object.values(mapping).sort()).toEqual([...members].sort());
      for (const [tag, ref] of Object.entries(mapping)) {
        const member = resolve(ref).schema;
        const tagSchema = schemaNode.parse(member.properties?.[propertyName]);
        expect(tagSchema.const ?? tagSchema.enum?.[0]).toBe(tag);
      }
    }
    expect(count).toBeGreaterThanOrEqual(30);
  });

  it("does not fold distinct positional schemas onto each other (PR #1024's fold bug)", () => {
    // `foldPositionalDuplicates` used to canonicalize a schema with
    // `JSON.stringify(rest, Object.keys(rest).sort())`, whose array second
    // argument is a property ALLOWLIST applied at *every* nesting depth, not
    // just the top. Distinct anyOf members (a nullable number vs. a nullable
    // string with a uri format) and distinct property types both erased down
    // to `{}` and compared equal, folding unrelated schemas together: 242
    // properties across the document ended up wrongly typed as a nullable
    // string with format "uri". Guard both the specific known casualties and
    // the aggregate count.
    const valuationRef = schemaNode.parse(
      schemas.InventoryWithLocationAndProductOut?.properties?.valuation,
    ).$ref;
    expect(resolve(valuationRef ?? "").schema).toMatchObject({
      type: "number",
    });
    expect(schemas.ProductListItemOut?.properties?.stockTracked).toMatchObject({
      type: expect.arrayContaining(["boolean"]),
    });
    const uriPropertyCount = Object.values(schemas)
      .flatMap((schema) => Object.values(schema.properties ?? {}))
      .filter(
        (value) => schemaNode.safeParse(value).data?.format === "uri",
      ).length;
    expect(uriPropertyCount).toBeLessThanOrEqual(50);
  });

  it("shares one ListPageMeta across every list page", () => {
    const pages = Object.entries(schemas).filter(([name]) =>
      name.endsWith("ListPage"),
    );
    expect(pages).toHaveLength(19);
    for (const [, page] of pages)
      expect(schemaNode.parse(page.properties?.meta).$ref).toBe(
        `${COMPONENT}ListPageMeta`,
      );
  });
});
