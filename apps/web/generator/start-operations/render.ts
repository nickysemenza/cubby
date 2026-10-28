import { tsModule } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import {
  collectOperationIds,
  collectStartOperationHandlers,
  validateStrongQueryOperations,
  collectStartOperations,
  loadContracts,
} from "./collect.ts";

const renderStartOperationRegistry = async (): Promise<string> => {
  const operations = [...(await collectStartOperations())].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  await validateStrongQueryOperations();
  const commands = new Map<
    string,
    {
      command: NonNullable<import("./collect.ts").ContractMember["command"]>;
      clientDomain: string;
    }
  >(
    (await loadContracts()).flatMap(({ exportName, contract }) =>
      Object.entries(contract.ops).flatMap(([member, definition]) =>
        definition.command === undefined
          ? []
          : [
              [
                `${contract.domain}.${member}`,
                {
                  command: definition.command,
                  clientDomain: exportName.replace(/Contract$/u, ""),
                },
              ] as const,
            ],
      ),
    ),
  );
  return tsModule({
    imports: [
      {
        from: "~/lib/operation-registry-types",
        typeOnly: true,
        names: [
          "OperationRegistry",
          "RegistryKeys",
          "RegisteredKind",
          "RegistryIdOfKind",
        ],
      },
    ],
    consts: [
      {
        name: "START_OPERATIONS",
        value: Object.fromEntries(
          operations.map(([operation, { kind, exposure, observability }]) => [
            operation,
            {
              kind,
              ...(exposure === undefined ? {} : { exposure }),
              ...(observability.entities.length
                ? { entities: observability.entities }
                : {}),
              ...(observability.productPhases.length
                ? { productPhases: observability.productPhases }
                : {}),
              ...commands.get(operation),
            },
          ]),
        ),
        satisfies: "OperationRegistry",
      },
    ],
    types: [
      {
        name: "StartOperationId",
        target: "RegistryKeys<typeof START_OPERATIONS>",
      },
      {
        name: "RegisteredStartOperationKind<Id extends StartOperationId>",
        target: "RegisteredKind<typeof START_OPERATIONS, Id>",
      },
      {
        name: 'StartOperationIdOfKind<Kind extends "query" | "mutation" | "subscription">',
        target: "RegistryIdOfKind<typeof START_OPERATIONS, Kind>",
      },
    ],
  });
};

const renderStartOperationHandlers = async (): Promise<string> => {
  const { operations, subscriptions } = await collectStartOperationHandlers();
  const table = (handlers: typeof operations) =>
    Object.fromEntries(
      [...handlers]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, handler]) => [
          id,
          [
            // Keys match `import.meta.glob` in operation-handlers.server.ts,
            // which resolves relative to server/operation-runtime/.
            handler.module
              .replace(/^~\/server\/operation-runtime\//u, "./")
              .replace(/^~\/server\//u, "../") + ".ts",
            handler.exportName,
          ],
        ]),
    );
  return tsModule({
    imports: [
      {
        from: "~/server/operation-runtime/operation-handlers.server",
        typeOnly: true,
        names: ["UnaryHandlerTable", "StreamHandlerTable"],
      },
    ],
    consts: [
      {
        name: "START_OPERATION_HANDLERS",
        value: table(operations),
        satisfies: "UnaryHandlerTable",
      },
      {
        name: "WORKFLOW_STREAM_HANDLERS",
        value: table(subscriptions),
        satisfies: "StreamHandlerTable",
      },
    ],
  });
};

export const renderStartOperationArtifacts = async (): Promise<{
  artifacts: EntityArtifacts[];
  operationIds: string[];
}> => ({
  artifacts: [
    {
      relativePath:
        "apps/web/src/lib/generated/start-operation-registry.gen.ts",
      source: await renderStartOperationRegistry(),
    },
    {
      relativePath:
        "apps/web/src/server/generated/start-operation-handler-data.gen.ts",
      source: await renderStartOperationHandlers(),
    },
  ],
  operationIds: await collectOperationIds(),
});
