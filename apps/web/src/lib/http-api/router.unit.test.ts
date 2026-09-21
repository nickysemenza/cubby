import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as contracts from "~/contracts/index";
import { httpContract } from "~/lib/generated/http-contract.gen";
import document from "~/lib/generated/http-openapi.gen.json";
import { START_OPERATIONS } from "~/lib/generated/start-operation-registry.gen";

import { httpMetadataSchema, rpcMutation, rpcQuery } from "./router";
import { checkHttpRoutes, httpRoutes } from "./routes";

const routes = httpRoutes(httpContract);
const metadataOf = (route: (typeof routes)[number]) =>
  httpMetadataSchema.parse(route.metadata);
const rpc = routes.filter((route) => metadataOf(route).resource === undefined);

describe("HTTP contract", () => {
  it("exposes every ordinary operation exactly once, queries as GET and mutations as POST", () => {
    const expected = Object.values(contracts)
      .flatMap((contract) =>
        Object.entries(contract.ops).flatMap(([member, operation]) =>
          operation.kind === "subscription" || operation.http === false
            ? []
            : [`${contract.domain}.${member}`],
        ),
      )
      .sort();
    expect(rpc.map((route) => metadataOf(route).operation).sort()).toEqual(
      expected,
    );
    // Opted out of HTTP, still a Start operation.
    for (const excluded of [
      "entity.list",
      "entity.detail",
      "entity.mutate",
      "entity.timeline",
    ]) {
      expect(expected).not.toContain(excluded);
      expect(START_OPERATIONS).toHaveProperty(excluded);
    }
    const transports = { get: 0, post: 0, mutation: 0 };
    const mismatches: string[] = [];
    for (const route of rpc) {
      const metadata = metadataOf(route);
      const kind = z
        .enum(["query", "mutation", "subscription"])
        .parse(
          Object.entries(START_OPERATIONS).find(
            ([id]) => id === metadata.operation,
          )?.[1].kind,
        );
      const transport = route.method === "GET" ? "get" : "post";
      // A mutation is always POST with no transport tag; a query's method
      // agrees with its transport tag.
      const consistent =
        kind === "mutation"
          ? route.method === "POST" && metadata.transport === undefined
          : metadata.transport === transport;
      if (!consistent) mismatches.push(metadata.operation);
      transports[kind === "mutation" ? "mutation" : transport] += 1;
      expect(route.path).toBe(
        `/api/v1/${metadata.operation.replace(".", "/")}`,
      );
    }
    expect(mismatches).toEqual([]);
    // Flat-input queries are GET; the structured ones travel as POST bodies.
    expect(transports).toEqual({ get: 117, post: 34, mutation: 96 });
    expect(Object.keys(document.paths)).toHaveLength(290);
    const analytics = rpc.find(
      (route) => metadataOf(route).operation === "expense.analytics",
    );
    expect(analytics).toMatchObject({ method: "POST" });
    expect(analytics && "body" in analytics).toBe(true);
    const flat = rpc.find(
      (route) => metadataOf(route).operation === "auditLog.list",
    );
    expect(flat).toMatchObject({ method: "GET" });
    expect(flat?.query instanceof z.ZodType).toBe(true);
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        ...new Set(routes.map((route) => route.path.replace(":id", "{id}"))),
      ].sort(),
    );
    expect(document.security).toEqual([
      { apiKey: [] },
      { sessionCookie: [] },
      { bearerAuth: [] },
    ]);
  });

  it("rejects route collisions and reserved paths", () => {
    expect(() => checkHttpRoutes(httpContract)).not.toThrow();
    const clash = rpcQuery("ai", "docs", contracts.aiContract.ops.usageSummary);
    expect(() =>
      checkHttpRoutes({ a: { ...clash, path: "/api/v1/docs" } }),
    ).toThrow("Reserved");
    expect(() =>
      checkHttpRoutes({ a: clash, b: { ...clash, path: clash.path } }),
    ).toThrow("collision");
  });

  it("registers a collection's static timeline route before its /:id route", () => {
    // Regression guard: itty-router takes the first match, so a contract
    // whose `get` precedes `timeline` would answer `/products/timeline` with
    // a 404 for the shortcode "timeline".
    const { timeline, get } = httpContract.resources.product;
    expect(() => checkHttpRoutes({ get, timeline })).toThrow("shadow");
    expect(() => checkHttpRoutes({ timeline, get })).not.toThrow();
    const paths = httpRoutes(httpContract).map((route) => route.path);
    expect(paths.indexOf("/api/v1/products/timeline")).toBeLessThan(
      paths.indexOf("/api/v1/products/:id"),
    );
  });

  it("carries object inputs as fields and wraps scalar inputs", () => {
    const carriers = new Map(
      rpc.map((route) => [
        metadataOf(route).operation,
        metadataOf(route).input,
      ]),
    );
    expect(carriers.get("dashboard.counts")).toBe("none");
    expect(carriers.get("auditLog.list")).toBe("object");
    // A `z.null()` input takes no parameters and dispatches null.
    expect(carriers.get("collection.list")).toBe("null");
    const nullInput = rpc.find(
      (route) => metadataOf(route).operation === "collection.list",
    );
    const nullQuery =
      nullInput?.query instanceof z.ZodType ? nullInput.query : undefined;
    expect(nullQuery?.safeParse({}).success).toBe(true);
    expect(nullQuery?.safeParse({ input: null }).success).toBe(false);
    // A resource body is the entity's own create input, never a command.
    const create = routes.find(
      (route) =>
        metadataOf(route).entity === "vendor" &&
        metadataOf(route).resource === "create",
    );
    const createBody =
      create && "body" in create && create.body instanceof z.ZodType
        ? create.body
        : undefined;
    expect(createBody?.safeParse({ name: "Fixture" }).success).toBe(true);
    expect(
      createBody?.safeParse({
        action: "create",
        entity: "vendor",
        data: { name: "Fixture" },
      }).success,
    ).toBe(false);
    const wrapped = rpcMutation("demo", "wrapped", {
      kind: "mutation",
      input: z.array(z.string()),
      output: z.number(),
    });
    expect(wrapped.metadata.input).toBe("wrapped");
    expect(wrapped.body.safeParse({ input: ["a"] }).success).toBe(true);
    expect(wrapped.body.safeParse(["a"]).success).toBe(false);
    const none = rpcQuery("demo", "none", {
      kind: "query",
      input: z.undefined(),
      output: z.number(),
    });
    expect(none.query.safeParse({}).success).toBe(true);
    expect(none.query.safeParse({ input: 1 }).success).toBe(false);
  });

  it("documents resource lists as flat parameters with validated controls", () => {
    const list = document.paths["/api/v1/recipes"].get;
    const names = list.parameters.map((parameter) => parameter.name);
    expect(names).toEqual(expect.arrayContaining(["page", "pageSize", "sort"]));
    const page = list.parameters.find((parameter) => parameter.name === "page");
    expect(page).toMatchObject({ in: "query" });
    expect(page).not.toHaveProperty("required", true);
    // Parameters carry a plain `schema`, never JSON `content`, and document
    // the logical type the query projection coerces to.
    expect(page).toMatchObject({
      style: "form",
      explode: true,
      schema: { type: "integer", minimum: 1 },
    });
    expect(page).not.toHaveProperty("content");
    expect(document.paths["/api/v1/recipes/{id}"].get.parameters).toEqual([
      expect.objectContaining({ in: "path", name: "id", required: true }),
    ]);
  });

  it("narrows sort and groupBy to the entity's declared roster", () => {
    // The live route schema is what the document is generated from, so the
    // same roster shows in both: the contract now, the document after
    // `pnpm generate`.
    const listQueryOf = (path: string) => {
      const route = routes.find(
        (candidate) => candidate.path === path && candidate.method === "GET",
      );
      if (!route || !("query" in route) || !(route.query instanceof z.ZodType))
        throw new Error(`${path} has no list query schema`);
      return z
        .record(
          z.string(),
          z.looseObject({
            type: z.string().optional(),
            enum: z.array(z.string()).optional(),
            description: z.string().optional(),
          }),
        )
        .parse(z.toJSONSchema(route.query, { io: "input" }).properties);
    };
    const products = listQueryOf("/api/v1/products");
    expect(products.groupBy).toMatchObject({
      type: "string",
      enum: ["category"],
      description: "Group rows by one field. One of: category",
    });
    expect(products.sort).toMatchObject({ type: "string" });
    expect(products.sort?.description).toContain("Fields: ");
    expect(products.sort?.description).toContain("related:product.projects");
    expect(products.sort?.description).toContain("Default: -createdAt");
    // Empty `groupable` means every sortable field groups, as in the kernel.
    expect(listQueryOf("/api/v1/vendors").groupBy).toMatchObject({
      enum: [
        "name",
        "purchaseCount",
        "spend",
        "latestPurchaseDate",
        "createdAt",
        "updatedAt",
      ],
    });
    const documented = (name: string) =>
      document.paths["/api/v1/products"].get.parameters.find(
        (parameter) => parameter.name === name,
      );
    expect(documented("groupBy")).toMatchObject({
      schema: { type: "string", enum: ["category"] },
    });
    expect(documented("sort")).toMatchObject({
      schema: { type: "string" },
      description: expect.stringContaining("Fields: "),
    });
  });

  it("emits ISO timestamps and a shared error body", () => {
    expect(JSON.stringify(document)).toContain('"format":"date-time"');
    expect(document.components.schemas.ApiError).toBeDefined();
    const references = [
      ...JSON.stringify(document).matchAll(
        /"\$ref":"#\/components\/schemas\/([^"]+)"/gu,
      ),
    ].map((match) => match[1] ?? "");
    expect(references.length).toBeGreaterThan(0);
    for (const name of new Set(references))
      expect(document.components.schemas).toHaveProperty(name);
    expect(JSON.stringify(document)).not.toContain('"mock"');
  });
});
