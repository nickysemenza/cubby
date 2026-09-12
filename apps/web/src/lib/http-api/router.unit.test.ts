import { Validator } from "@cfworker/json-schema";
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
    const expected = Object.entries(START_OPERATIONS)
      .filter(([, { kind }]) => kind !== "subscription")
      .map(([id]) => id)
      .sort();
    expect(rpc.map((route) => metadataOf(route).operation).sort()).toEqual(
      expected,
    );
    for (const route of rpc) {
      const kind = z
        .enum(["query", "mutation", "subscription"])
        .parse(
          Object.entries(START_OPERATIONS).find(
            ([id]) => id === metadataOf(route).operation,
          )?.[1].kind,
        );
      expect(route.method).toBe(kind === "query" ? "GET" : "POST");
      expect(route.path).toBe(
        `/api/v1/${metadataOf(route).operation.replace(".", "/")}`,
      );
    }
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

  it("carries object inputs as fields and wraps scalar inputs", () => {
    const carriers = new Map(
      rpc.map((route) => [
        metadataOf(route).operation,
        metadataOf(route).input,
      ]),
    );
    expect(carriers.get("dashboard.counts")).toBe("none");
    expect(carriers.get("entity.detail")).toBe("object");
    // A union of per-entity unions is still an object carrier (regression:
    // the e2e mutate body was rejected as `{ input }`-wrapped).
    expect(carriers.get("entity.mutate")).toBe("object");
    const mutate = rpc.find(
      (route) => metadataOf(route).operation === "entity.mutate",
    );
    expect(
      mutate && "body" in mutate && mutate.body instanceof z.ZodType
        ? mutate.body.safeParse({
            action: "create",
            entity: "vendor",
            data: { name: "Fixture" },
          }).success
        : "no body",
    ).toBe(true);
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
    const pageSchema =
      page && "schema" in page
        ? page.schema
        : page?.content?.["application/json"]?.schema;
    if (!pageSchema) throw new Error("page parameter has no schema");
    const validator = new Validator(pageSchema, "4");
    expect(validator.validate(1).valid).toBe(true);
    expect(validator.validate(0).valid).toBe(false);
    expect(document.paths["/api/v1/recipes/{id}"].get.parameters).toEqual([
      expect.objectContaining({ in: "path", name: "id", required: true }),
    ]);
  });

  it("emits ISO timestamps and a shared error envelope", () => {
    expect(JSON.stringify(document)).toContain('"format":"date-time"');
    expect(document.components.schemas.ErrorEnvelope).toBeDefined();
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
