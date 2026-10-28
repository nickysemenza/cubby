import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { tsModule, tsReference } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import {
  collectOperationIds,
  collectOperationHandlers,
  validateStrongQueryOperations,
  collectOperations,
  loadContracts,
} from "./collect.ts";

const renderOperationRegistry = async (): Promise<string> => {
  const operations = [...(await collectOperations())].sort(([a], [b]) =>
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
        name: "OPERATIONS",
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
        name: "OperationId",
        target: "RegistryKeys<typeof OPERATIONS>",
      },
      {
        name: "RegisteredOperationKind<Id extends OperationId>",
        target: "RegisteredKind<typeof OPERATIONS, Id>",
      },
      {
        name: 'OperationIdOfKind<Kind extends "query" | "mutation" | "subscription">',
        target: "RegistryIdOfKind<typeof OPERATIONS, Kind>",
      },
    ],
  });
};

const renderOperationHandlers = async (): Promise<string> => {
  const { operations, subscriptions } = await collectOperationHandlers();
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
        name: "OPERATION_HANDLERS",
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

const OVERRIDES_ROOT = fileURLToPath(
  new URL(
    "../../src/integrations/tanstack-query/operation-overrides/",
    import.meta.url,
  ),
);

/** One browser domain module per contract, so a route bundles only its own. */
const renderOperationDomains = async (): Promise<EntityArtifacts[]> => {
  const overrides = new Set(
    readdirSync(OVERRIDES_ROOT)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => file.replace(/\.ts$/u, "")),
  );
  const contracts = await loadContracts();
  const names = new Set(
    contracts.map(({ exportName }) => exportName.replace(/Contract$/u, "")),
  );
  for (const override of overrides)
    if (!names.has(override))
      throw new Error(
        `operation-overrides/${override}.ts does not match a contract.`,
      );
  return contracts.map(({ exportName, module }) => {
    const name = exportName.replace(/Contract$/u, "");
    const overridden = overrides.has(name);
    return {
      relativePath: `apps/web/src/integrations/tanstack-query/generated/domains/${name}.gen.ts`,
      source: tsModule({
        imports: [
          { from: module, names: [exportName] },
          {
            from: "~/integrations/tanstack-query/operation-catalog",
            names: ["defineOperationDomain"],
          },
          ...(overridden
            ? [
                {
                  from: `~/integrations/tanstack-query/operation-overrides/${name}`,
                  names: [`${name}Overrides`],
                },
              ]
            : []),
        ],
        bindings: [
          {
            name,
            factory: "defineOperationDomain",
            args: [
              tsReference(exportName),
              ...(overridden ? [tsReference(`${name}Overrides`)] : []),
            ],
          },
        ],
      }),
    };
  });
};

export const renderOperationArtifacts = async (): Promise<{
  artifacts: EntityArtifacts[];
  operationIds: string[];
}> => ({
  artifacts: [
    {
      relativePath: "apps/web/src/lib/generated/operation-registry.gen.ts",
      source: await renderOperationRegistry(),
    },
    {
      relativePath:
        "apps/web/src/server/generated/operation-handler-data.gen.ts",
      source: await renderOperationHandlers(),
    },
    ...(await renderOperationDomains()),
  ],
  operationIds: await collectOperationIds(),
});
