import { describe, expect, it } from "vitest";
import type { OpenApiDocument } from "./openapi.ts";
import { renderSwiftClient } from "./swift-client.ts";
import { collectSwiftRoutes } from "./swift-routes.ts";

const document = {
  openapi: "3.0.3",
  info: { title: "Example API", version: "1.0.0" },
  paths: {
    "/api/v1/example/read": {
      get: {
        operationId: "example.read",
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Example" },
              },
            },
          },
          default: {
            description: "Failure",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ApiError" },
              },
            },
          },
        },
      },
    },
  },
} satisfies OpenApiDocument;

const render = (input: OpenApiDocument) =>
  renderSwiftClient(input, collectSwiftRoutes(input));

describe("shared native client wire boundary", () => {
  it("rejects a new success status instead of decoding it as an ApiError", () => {
    const operation = document.paths["/api/v1/example/read"].get;
    expect(() =>
      render({
        ...document,
        paths: {
          "/api/v1/example/read": {
            get: {
              ...operation,
              responses: {
                ...operation.responses,
                "202": operation.responses["200"],
              },
            },
          },
        },
      }),
    ).toThrow(/202/u);
  });

  it("rejects response headers the shared decoder would otherwise discard", () => {
    const operation = document.paths["/api/v1/example/read"].get;
    expect(() =>
      render({
        ...document,
        paths: {
          "/api/v1/example/read": {
            get: {
              ...operation,
              responses: {
                ...operation.responses,
                "200": {
                  ...operation.responses["200"],
                  headers: {
                    "x-example": { schema: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow(/headers/u);
  });

  it("rejects alternate media types rather than silently changing decoding", () => {
    const operation = document.paths["/api/v1/example/read"].get;
    expect(() =>
      render({
        ...document,
        paths: {
          "/api/v1/example/read": {
            get: {
              ...operation,
              responses: {
                ...operation.responses,
                "200": {
                  ...operation.responses["200"],
                  content: {
                    "application/json":
                      operation.responses["200"].content["application/json"],
                    "text/plain": { schema: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow(/text\/plain/u);
  });
});
