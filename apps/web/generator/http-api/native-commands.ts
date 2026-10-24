import * as commandContracts from "../../src/contracts/index.ts";
import type { OperationContract } from "../../src/contracts/define.ts";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { NativeContract } from "./native-contract.ts";

/** Command metadata and routing stay declared; composed bodies remain JSON end to end. */
export function renderNativeCommands(
  contract: NativeContract,
): EntityArtifacts {
  const operations = new Map(
    contract.operations.map((operation) => [operation.id, operation]),
  );
  const commands = Object.values<OperationContract>(commandContracts).flatMap(
    (declaration) =>
      Object.entries(declaration.ops).flatMap(([member, definition]) => {
        const id = `${declaration.domain}.${member}`;
        if (
          definition.kind !== "mutation" ||
          !definition.command ||
          !operations.has(id)
        )
          return [];
        const operation = operations.get(id)!;
        if (operation.input !== "body" || !operation.body)
          throw new Error(`${id}: native commands require a JSON body`);
        return [{ id, definition, command: definition.command }];
      }),
  );
  const metadata = commands
    .map(
      ({ id, definition, command: c }) =>
        `        case ${JSON.stringify(id)}: return .init(label: ${JSON.stringify(c.label)}, confirmation: ${c.confirmation === null ? "nil" : JSON.stringify(c.confirmation)}, booleanInputs: ${JSON.stringify(c.booleanInputs ?? [])}, runIdsPath: ${c.runIdsPath ? JSON.stringify(c.runIdsPath) : "nil"}, navigateRunPath: ${c.navigateRunPath ? JSON.stringify(c.navigateRunPath) : "nil"}, success: ${c.success ? JSON.stringify(c.success) : "nil"}, changed: ${JSON.stringify(c.affectedEntities ?? definition.invalidates ?? [])}, resultFields: [${(c.resultFields ?? []).map((field) => `.init(label: ${JSON.stringify(field.label)}, path: ${JSON.stringify(field.path)})`).join(", ")}])`,
    )
    .join("\n");
  return {
    relativePath:
      "apps/apple/CubbyKit/Sources/CubbyKit/Generated/WorkflowCommands.swift",
    source: `${generatedHeader}// swift-format-ignore-file
public struct WorkflowCommandResultField: Sendable {
    public let label: String
    public let path: String
}

public struct WorkflowCommandPresentation: Sendable {
    public let label: String
    public let confirmation: String?
    public let booleanInputs: [String]
    public let runIdsPath: String?
    public let navigateRunPath: String?
    public let success: String?
    public let changed: [String]
    public let resultFields: [WorkflowCommandResultField]
}

public enum WorkflowCommandCatalog {
    public static let operations: Set<String> = ${JSON.stringify(commands.map(({ id }) => id))}
    public static func presentation(for operation: String) -> WorkflowCommandPresentation? {
        switch operation {
${metadata}
        default: return nil
        }
    }
}

extension CubbyClient {
    public func executeCommand(operation: String, body: JSONValue) async throws -> JSONValue {
        guard WorkflowCommandCatalog.operations.contains(operation) else {
            throw ReportActionError.unavailable("Undeclared user command: \\(operation)")
        }
        return try await request(operation, body: body)
    }
}
`,
  };
}
