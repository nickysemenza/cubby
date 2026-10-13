import assert from "node:assert/strict";

import { test } from "vitest";

import { projectNativeDocument } from "../../../../../scripts/generator/http-api/native-document.ts";
import type { OpenApiDocument } from "../../../../../scripts/generator/http-api/openapi.ts";

const document = (
  nativeType: "object" | "string" = "object",
  exportType: "string" | "integer" = "string",
) =>
  ({
    openapi: "3.1.0",
    info: { title: "Synthetic API", version: "1" },
    servers: [{ url: "https://example.invalid" }],
    security: [{ session: [] }],
    paths: {
      "/widgets": {
        summary: "Widgets",
        parameters: [{ $ref: "#/components/parameters/Page" }],
        get: {
          operationId: "resources.widget.list",
          responses: { "200": { $ref: "#/components/responses/Widgets" } },
        },
        post: {
          operationId: "widgets.export",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Export" },
                },
              },
            },
          },
        },
      },
      "/action": {
        post: {
          operationId: "widgets.action",
          responses: { "204": { description: "Done" } },
        },
      },
    },
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "session" },
      },
      parameters: {
        Page: { name: "page", in: "query", schema: { type: "integer" } },
      },
      responses: {
        Widgets: {
          description: "Widgets",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Widget" },
            },
          },
        },
      },
      schemas: {
        Widget: {
          type: "object",
          properties: { child: { $ref: "#/components/schemas/Child" } },
          discriminator: {
            propertyName: "kind",
            mapping: {
              variant: "#/components/schemas/Variant",
              plain: "#/components/schemas/Plain",
            },
          },
        },
        Child: {
          type: nativeType,
          properties: { parent: { $ref: "#/components/schemas/Widget" } },
        },
        Variant: { type: "object" },
        Plain: { type: "object" },
        Export: { type: exportType },
      },
    },
  }) satisfies OpenApiDocument;

// A full HTTP document churns the Apple build for unused contracts; dropping
// indirect refs instead silently breaks the generated native wire types.
test("non-native shape changes leave the native document unchanged", async () => {
  const before = document();
  const changed = document("object", "integer");
  assert.deepEqual(
    await projectNativeDocument(before, ["widgets.action"]),
    await projectNativeDocument(changed, ["widgets.action"]),
  );
  assert.equal(before.paths["/widgets"].post.operationId, "widgets.export");
});

test("native operations retain metadata, security and transitive reference cycles and mappings", async () => {
  const source = document();
  const projected = await projectNativeDocument(source, ["widgets.action"]);
  assert.deepEqual(Object.keys(projected.paths["/widgets"] ?? {}), [
    "summary",
    "parameters",
    "get",
  ]);
  assert.deepEqual(projected.paths["/action"], source.paths["/action"]);
  assert.deepEqual(projected.info, source.info);
  assert.deepEqual(projected.servers, source.servers);
  assert.deepEqual(projected.security, source.security);
  assert.deepEqual(
    projected.components?.securitySchemes,
    source.components.securitySchemes,
  );
  assert.deepEqual(Object.keys(projected.components?.schemas ?? {}), [
    "Widget",
    "Child",
    "Variant",
    "Plain",
  ]);
  assert.deepEqual(
    projected.components?.parameters,
    source.components.parameters,
  );
  assert.deepEqual(
    projected.components?.responses,
    source.components.responses,
  );
  const changed = document("string");
  assert.notDeepEqual(
    await projectNativeDocument(changed, ["widgets.action"]),
    projected,
  );
});

test("missing references and native flags fail before emitting an incomplete client", async () => {
  const source = document();
  Reflect.deleteProperty(source.components.schemas, "Child");
  await assert.rejects(() => projectNativeDocument(source, []), /resolve.*ref/);
  await assert.rejects(
    () => projectNativeDocument(document(), ["missing.action"]),
    /no HTTP route/,
  );
});
