import { describe, expect, it } from "vitest";
import { z } from "zod";

import { entityKernelObject } from "~/contracts/entity-kernel-wire";
import * as contracts from "~/contracts/index";
import { httpContract } from "~/lib/generated/http-contract.gen";
import { START_OPERATIONS } from "~/lib/generated/start-operation-registry.gen";

import document from "../../../../apple/CubbyKit/Sources/CubbyAPI/openapi.json";
import { httpMetadataSchema, rpcMutation, rpcQuery } from "./router";
import { checkHttpRoutes, httpRoutes } from "./routes";
import { toWire } from "./wire";

const routes = httpRoutes(httpContract);
const metadataOf = (route: (typeof routes)[number]) =>
  httpMetadataSchema.parse(route.metadata);
const rpc = routes;

describe("HTTP contract", () => {
  it("exposes every native operation exactly once, queries as GET or POST and mutations as POST", () => {
    const expected = Object.values(contracts)
      .flatMap((contract) =>
        Object.entries(contract.ops).flatMap(([member, operation]) =>
          operation.kind === "subscription" || operation.native === undefined
            ? []
            : [`${contract.domain}.${member}`],
        ),
      )
      .sort();
    expect(rpc.map((route) => metadataOf(route).operation).sort()).toEqual(
      expected,
    );
    // Type-only carriers reach HTTP only through their loose kernel wire.
    for (const kernel of [
      "entity.list",
      "entity.detail",
      "entity.mutate",
      "entity.timeline",
    ]) {
      const route = rpc.find((entry) => metadataOf(entry).operation === kernel);
      expect(route?.method).toBe("POST");
    }
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
      expect(route.path).toBe(
        `/api/v1/${metadata.operation.replace(".", "/")}`,
      );
    }
    expect(mismatches).toEqual([]);
    const operationIds = rpc.map((route) => metadataOf(route).operation);
    expect(new Set(operationIds).size).toBe(operationIds.length);
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
      [...new Set(routes.map((route) => route.path))].sort(),
    );
    expect(document.security).toEqual([
      { apiKey: [] },
      { sessionCookie: [] },
      { bearerAuth: [] },
    ]);
  });

  it("rejects route collisions", () => {
    expect(() => checkHttpRoutes(httpContract)).not.toThrow();
    const clash = rpcQuery("ai", "docs", contracts.aiContract.ops.usageSummary);
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
    expect(carriers.get("auditLog.list")).toBe("object");
    // A `z.null()` input takes no parameters and dispatches null.
    const nullInput = rpcQuery("demo", "null", {
      kind: "query",
      input: z.null(),
      output: z.number(),
    });
    expect(nullInput.metadata.input).toBe("null");
    expect(nullInput.query.safeParse({}).success).toBe(true);
    expect(nullInput.query.safeParse({ input: null }).success).toBe(false);
    // The kernel wire is a free-form object; the handler parses the command.
    const mutate = rpc.find(
      (route) => metadataOf(route).operation === "entity.mutate",
    );
    const mutateBody =
      mutate && "body" in mutate && mutate.body instanceof z.ZodType
        ? mutate.body
        : undefined;
    expect(
      mutateBody?.safeParse({
        action: "create",
        entity: "vendor",
        data: { name: "Fixture" },
      }).success,
    ).toBe(true);
    expect(mutateBody?.safeParse(["create"]).success).toBe(false);
    expect(mutateBody).toBe(toWire(entityKernelObject, "input"));
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
