import { z } from "zod";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { OpenApiDocument } from "./openapi.ts";
import { type SwiftRoute, swiftString } from "./swift-routes.ts";

const jsonComponent = z.object({ schema: z.object({ $ref: z.string() }) });
const errorResponseSchema = z.object({
  headers: z.never().optional(),
  content: z.strictObject({
    "application/json": z.object({
      schema: z.object({ $ref: z.literal("#/components/schemas/ApiError") }),
    }),
  }),
});
const responseSchema = z.object({
  parameters: z
    .array(
      z.object({
        in: z.literal("query"),
        name: z.string(),
        style: z.literal("form").optional(),
        explode: z.literal(true).optional(),
      }),
    )
    .optional(),
  requestBody: z
    .object({
      required: z.literal(false).optional(),
      content: z.strictObject({ "application/json": jsonComponent }),
    })
    .optional(),
  responses: z.strictObject({
    "200": z.object({
      headers: z.never().optional(),
      content: z.strictObject({ "application/json": jsonComponent }),
    }),
    default: z.strictObject({
      $ref: z.literal("#/components/responses/ApiError"),
    }),
  }),
});

/** Keep Apple's typed API surface and codecs; share its uniform JSON HTTP machinery. */
export const renderSwiftClient = (
  document: OpenApiDocument,
  routes: readonly SwiftRoute[],
): EntityArtifacts => {
  errorResponseSchema.parse(document.components?.responses?.ApiError);
  const methods = routes.map((route) => {
    if (route.pathParameters.length > 0)
      throw new Error(
        `${route.id}: native client does not support path parameters`,
      );
    const raw = document.paths[route.route]?.[route.method.slice(1)];
    const operation = responseSchema.parse(raw);
    const ref =
      operation.responses["200"].content["application/json"].schema.$ref;
    const component = ref.replace("#/components/schemas/", "");
    if (!/^[A-Z][A-Za-z0-9]*$/u.test(component))
      throw new Error(
        `${route.id}: native response must reference a named component`,
      );
    const method = route.id
      .replaceAll(".", "_")
      .replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
    if (!/^[a-z][A-Za-z0-9_]*$/u.test(method))
      throw new Error(`${route.id}: unsupported Swift operation identifier`);
    const type = `Operations.${method[0]!.toUpperCase()}${method.slice(1)}`;
    const query = (operation.parameters ?? []).map(({ name }) => {
      if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(name))
        throw new Error(`${route.id}: unsupported Swift query name ${name}`);
      return `                try converter.setQueryItemAsURI(in: &request, style: .form, explode: true, name: ${swiftString(name)}, value: input.query.\`${name}\`)`;
    });
    const body = route.hasBody
      ? [
          "                switch input.body {",
          "                case .none: return (request, nil)",
          "                case .json(let value):",
          '                    let body = try converter.setOptionalRequestBodyAsJSON(value, headerFields: &request.headerFields, contentType: "application/json; charset=utf-8")',
          "                    return (request, body)",
          "                }",
        ]
      : ["                return (request, nil)"];
    return [
      `    public func ${method}(_ input: ${type}.Input) async throws -> ${type}.Output {`,
      `        try await send(input, operationID: ${type}.id, response: Components.Schemas.${component}.self,`,
      "            serializer: { input in",
      `                var request = HTTPRequest(soar_path: ${swiftString(route.route)}, method: ${route.method})`,
      ...query,
      "                converter.setAcceptHeader(in: &request.headerFields, contentTypes: input.headers.accept)",
      ...body,
      "            },",
      "            success: { .ok(.init(body: .json($0))) },",
      "            failure: { .default(statusCode: $0, .init(body: .json($1))) })",
      "    }",
    ].join("\n");
  });
  return {
    relativePath: "apps/apple/CubbyKit/Sources/CubbyAPI/Client.gen.swift",
    source: `${generatedHeader}
// swift-format-ignore-file

@_spi(Generated) import OpenAPIRuntime
import Foundation
import HTTPTypes

public struct Client: APIProtocol {
    private let client: UniversalClient
    private var converter: Converter { client.converter }

    public init(serverURL: URL, configuration: Configuration = .init(), transport: any ClientTransport, middlewares: [any ClientMiddleware] = []) {
        client = UniversalClient(serverURL: serverURL, configuration: configuration, transport: transport, middlewares: middlewares)
    }

    // All native routes share a JSON 200 success and the same default ApiError.
    // UniversalClient retains middleware, cancellation and diagnostic error wrapping.
    private func send<Input: Sendable, Value: Decodable & Sendable, Output: Sendable>(
        _ input: Input, operationID: String, response: Value.Type,
        serializer: @Sendable (Input) throws -> (HTTPRequest, HTTPBody?),
        success: @Sendable @escaping (Value) -> Output,
        failure: @Sendable @escaping (Int, Components.Schemas.ApiError) -> Output
    ) async throws -> Output {
        try await client.send(input: input, forOperation: operationID, serializer: serializer, deserializer: { response, body in
            _ = try converter.bestContentType(received: converter.extractContentTypeIfPresent(in: response.headerFields), options: ["application/json"])
            if response.status.code == 200 {
                return try await converter.getResponseBodyAsJSON(Value.self, from: body, transforming: success)
            }
            return try await converter.getResponseBodyAsJSON(Components.Schemas.ApiError.self, from: body, transforming: { failure(response.status.code, $0) })
        })
    }

${methods.join("\n\n")}
}
`,
  };
};
