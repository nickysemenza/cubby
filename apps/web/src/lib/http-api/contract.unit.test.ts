import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { httpContract } from "~/lib/generated/http-contract.gen";
import document from "~/lib/generated/http-openapi.gen.json";
import { START_OPERATIONS } from "~/lib/generated/start-operation-registry.gen";

import { httpMetadataSchema, httpQuery } from "./contract";
import { httpSchemaSources } from "./contract";
import { httpRoutes, checkHttpRoutes } from "./routes";

const routes = httpRoutes(httpContract);
const operations = routes
  .filter(
    (route) =>
      route.method === "POST" &&
      z.object({ http: httpMetadataSchema }).parse(route.metadata).http.mode ===
        "legacy",
  )
  .map((contract) => ({
    contract,
    id: z.object({ http: httpMetadataSchema }).parse(contract.metadata).http
      .operation,
  }));

describe("generated HTTP contract", () => {
  it("exposes and documents every ordinary operation exactly once", () => {
    const expected = Object.entries(START_OPERATIONS)
      .filter(([, value]) => value.kind !== "subscription")
      .map(([id]) => id)
      .sort();
    expect(operations.map(({ id }) => id).sort()).toEqual(expected);
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        ...new Set(
          routes.map((contract) => contract.path.replace(":id", "{id}")),
        ),
      ].sort(),
    );
    expect(document.security).toEqual([
      { apiKey: [] },
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
  });

  it("matches every documented method and rejects route collisions", () => {
    expect(() => checkHttpRoutes(httpContract)).not.toThrow();
    expect(() =>
      checkHttpRoutes({
        a: httpContract.resources.recipe.list,
        b: httpContract.resources.recipe.list,
      }),
    ).toThrow("collision");
    expect(() =>
      checkHttpRoutes({
        a: httpContract.resources.recipe.get,
        b: {
          ...httpContract.resources.recipe.list,
          path: "/api/v1/recipes/RCP-ABCD",
        },
      }),
    ).toThrow("collision");
    expect(() =>
      checkHttpRoutes({
        a: { ...httpContract.resources.recipe.list, path: "/api/v1/docs" },
      }),
    ).toThrow("collision");
    const documented = Object.entries(document.paths)
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    expect(
      routes
        .map((route) => `${route.method} ${route.path.replace(":id", "{id}")}`)
        .sort(),
    ).toEqual(documented);
    const queryOperations = Object.entries(START_OPERATIONS)
      .filter(([, definition]) => definition.kind === "query")
      .map(([id]) => id)
      .sort();
    expect(
      httpRoutes(httpContract.queries)
        .map(
          (route) =>
            z.object({ http: httpMetadataSchema }).parse(route.metadata).http
              .operation,
        )
        .sort(),
    ).toEqual(queryOperations);
    const pagination = document.paths["/api/v1/recipes"].get.parameters.find(
      (parameter) => parameter.name === "page",
    );
    expect(pagination).toMatchObject({
      in: "query",
      schema: { $ref: expect.any(String) },
    });
    const pageSchema = z
      .object({ schema: z.object({ $ref: z.string() }) })
      .parse(pagination).schema;
    const pageValidator = new Validator({
      ...pageSchema,
      components: document.components,
    });
    expect(pageValidator.validate(1).valid).toBe(true);
    expect(pageValidator.validate(0).valid).toBe(false);
    expect(document.paths["/api/v1/recipes/{id}"].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", in: "path", required: true }),
      ]),
    );
  });

  it("wraps scalar and array GET inputs while leaving object inputs as fields", () => {
    for (const input of [z.string(), z.array(z.string())]) {
      const route = httpQuery("example.read", input, z.string());
      expect(route.metadata.http.mode).toBe("wrapped");
      const schema = httpSchemaSources.get(route.query)!.schema;
      expect(
        schema.safeParse({
          input: input instanceof z.ZodString ? "value" : ["value"],
        }).success,
      ).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
    }
    expect(
      httpQuery("example.read", z.object({ search: z.string() }), z.string())
        .metadata.http.mode,
    ).toBe("object");
    expect(
      httpQuery("example.read", z.null(), z.string()).metadata.http.mode,
    ).toBe("null");
  });

  it("preserves concrete input validation and output date schemas", () => {
    const input = httpSchemaSources.get(
      httpContract.entity.detail.body,
    )!.schema;
    expect(
      input.safeParse({ input: { entity: "vendor", shortcode: "not-a-code" } })
        .success,
    ).toBe(false);
    expect(
      input.safeParse({ input: { entity: "vendor", shortcode: "VEN-ABCD" } })
        .success,
    ).toBe(true);
    const output = httpSchemaSources.get(
      httpContract.auditLog.list.responses[200],
    )!.schema;
    expect(output).toBeInstanceOf(z.ZodType);
    expect(JSON.stringify(document)).toContain('"format":"date-time"');
  });

  it("accepts ISO input timestamps consistently with the documented JSON shape", () => {
    const schema = httpSchemaSources.get(
      httpContract.inventory.reconcileSession.body,
    )!.schema;
    const input = {
      input: {
        locationId: "LOC-HM3E",
        expectedInventoryEntryIds: [],
        snapshotUpdatedAt: "2026-09-10T00:00:00.000Z",
        resolutions: [],
      },
    };
    const validator = new Validator({
      $ref: "#/components/schemas/input_inventory.reconcileSession_body",
      components: document.components,
    });
    expect(validator.validate(input).valid).toBe(true);
    expect(schema.safeParse(input).success).toBe(true);
    const invalid = { input: { ...input.input, snapshotUpdatedAt: "invalid" } };
    expect(validator.validate(invalid).valid).toBe(false);
    expect(schema.safeParse(invalid).success).toBe(false);
  });

  it("contains only resolvable local references and no Zod-only metadata", () => {
    const serialized = JSON.stringify(document);
    const references = [
      ...serialized.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/gu),
    ].map((match) => match[1]!);
    const names = new Set(Object.keys(document.components.schemas));
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((name) => !names.has(name))).toEqual([]);
    expect(serialized).not.toMatch(/"(?:mock|mockValue|\$id)":/u);
  });
});
