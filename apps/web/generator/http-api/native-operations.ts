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
  const parameter = (operation: NativeOperation) =>
    operation.input === "body" ? `body: ${type(operation.body!)}` : "";
  const argument = (operation: NativeOperation) => {
    if (operation.input === "body") return ", body: body";
    if (operation.input === "null") return ", nullInput: true";
    return "";
  };
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
      const input = operation.input === "body" ? operation.body : undefined;
      return `${entry.doc ? `    /// ${entry.doc}\n` : ""}    public func ${entry.method}(${input ? `_ input: ${type(input)}` : ""}) async throws -> ${type(operation.output)} {\n        try await native_${swiftId(id)}(${input ? "body: input" : ""})\n    }`;
    })
    .join("\n\n");
  const ids = contract.operations.map(({ id }) => JSON.stringify(id));
  const nullInputs = contract.operations
    .filter(({ input }) => input === "null")
    .map(({ id }) => JSON.stringify(id));
  return [
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/NativeOperations.swift",
      source: `${generatedHeader}// swift-format-ignore-file\nimport CubbyAPI\n\nextension CubbyClient {\n${methods}\n\n${conveniences}\n}\n`,
    },
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/OperationCatalog.swift",
      source: `${generatedHeader}// swift-format-ignore-file\npublic enum OperationCatalog {\n    public static let all: [String] = [${ids.join(", ")}]\n    public static let nullInput: Set<String> = [${nullInputs.join(", ")}]\n}\n`,
    },
  ];
}
