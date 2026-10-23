import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { NativeContract, NativeOperation } from "./native-contract.ts";
import { CLIENT_PASSTHROUGH_METHODS } from "./native-methods.ts";
import type { SwiftModels } from "./swift-models.ts";

const swiftId = (id: string) =>
  id
    .replaceAll(".", "_")
    .replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

export function renderNativeOperations(
  contract: NativeContract,
  models: SwiftModels,
): EntityArtifacts[] {
  const type = (key: string) => {
    const name = models.types.get(`native://${key}`);
    if (!name) throw new Error(`Missing Swift type for ${key}`);
    return name;
  };
  const queryParameters = (operation: NativeOperation) =>
    Object.keys(
      operation.query
        ? (contract.models[operation.query]?.properties ?? {})
        : {},
    );
  const parameter = (operation: NativeOperation) =>
    operation.input === "none" || operation.input === "null"
      ? ""
      : operation.body
        ? `body: ${type(operation.body)}`
        : operation.query && queryParameters(operation).length
          ? `query: ${type(operation.query)}`
          : "";
  const argument = (operation: NativeOperation) =>
    operation.body && (operation.input === "none" || operation.input === "null")
      ? ", body: JSONValue.object([:])"
      : operation.body
        ? ", body: body"
        : operation.query && queryParameters(operation).length
          ? ", query: query"
          : "";
  const methods = contract.operations
    .map(
      (operation) =>
        `    func native_${swiftId(operation.id)}(${parameter(operation)}) async throws -> ${type(operation.output)} {\n        try await request(${JSON.stringify(operation.id)}${argument(operation)})\n    }`,
    )
    .join("\n\n");
  const conveniences = Object.entries(CLIENT_PASSTHROUGH_METHODS)
    .map(([id, entry]) => {
      const operation = contract.operations.find(
        (operation) => operation.id === id,
      );
      if (!operation)
        throw new Error(`${id}: native convenience has no operation`);
      const input =
        operation.input === "none" || operation.input === "null"
          ? undefined
          : (operation.body ??
            (queryParameters(operation).length ? operation.query : undefined));
      const label = operation.body ? "body" : "query";
      const alias =
        operation.query && input
          ? `    public typealias ${entry.method[0]!.toUpperCase()}${entry.method.slice(1)}Query = CubbyAPI.${type(input)}\n`
          : "";
      return `${alias}${entry.doc ? `    /// ${entry.doc}\n` : ""}    public func ${entry.method}(${input ? `_ input: ${type(input)}` : ""}) async throws -> ${type(operation.output)} {\n        try await native_${swiftId(id)}(${input ? `${label}: input` : ""})\n    }`;
    })
    .join("\n\n");
  const routes = contract.operations
    .map(
      (operation) =>
        `        (${JSON.stringify(operation.id)}, .init(operationID: ${JSON.stringify(operation.id)}, method: .${operation.method.toLowerCase()}, path: ${JSON.stringify(operation.path)}, queryParameters: ${JSON.stringify(queryParameters(operation))}, hasBody: ${operation.body !== undefined}))`,
    )
    .join(",\n");
  return [
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/NativeOperations.swift",
      source: `${generatedHeader}// swift-format-ignore-file\nimport CubbyAPI\n\nextension CubbyClient {\n${methods}\n\n${conveniences}\n}\n`,
    },
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/OperationRoutes.swift",
      source: `${generatedHeader}// swift-format-ignore-file\nextension OperationRoute {\n    public static let all: [String: OperationRoute] = Dictionary(uniqueKeysWithValues: [\n${routes}\n    ])\n}\n`,
    },
  ];
}
