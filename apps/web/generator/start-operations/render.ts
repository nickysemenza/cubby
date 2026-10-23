import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import {
  collectOperationIds,
  collectStartOperationHandlers,
  validateStrongQueryOperations,
  collectStartOperations,
  type HandlerDefinition,
} from "./collect.ts";
import { renderClientCatalog } from "./client-catalog.ts";

const renderStartOperationRegistry = async (): Promise<string> => {
  const operations = [...(await collectStartOperations())].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  await validateStrongQueryOperations();
  return (
    generatedHeader +
    `export const START_OPERATIONS = {\n${operations
      .map(([operation, { kind, exposure, observability }]) => {
        const metadata = [
          exposure === undefined
            ? undefined
            : `exposure: ${JSON.stringify(exposure)}`,
          observability.entities.length > 0
            ? `entities: ${JSON.stringify(observability.entities)}`
            : undefined,
          observability.productPhases.length > 0
            ? `productPhases: ${JSON.stringify(observability.productPhases)}`
            : undefined,
        ].filter((field): field is string => field !== undefined);
        return `  ${JSON.stringify(operation)}: { kind: ${JSON.stringify(kind)}${metadata.length > 0 ? `, ${metadata.join(", ")}` : ""} },`;
      })
      .join("\n")}\n} as const;\n\n` +
    `export type StartOperationId = keyof typeof START_OPERATIONS;\n` +
    `export type RegisteredStartOperationKind<Id extends StartOperationId> =\n` +
    `  (typeof START_OPERATIONS)[Id]["kind"];\n` +
    `export type StartOperationIdOfKind<Kind extends "query" | "mutation" | "subscription"> = {\n` +
    `  [Id in StartOperationId]: RegisteredStartOperationKind<Id> extends Kind ? Id : never;\n` +
    `}[StartOperationId];\n`
  );
};

const renderStartOperationHandlers = async (): Promise<string> => {
  const { operations, subscriptions } = await collectStartOperationHandlers();
  const sorted = (handlers: Map<string, HandlerDefinition>) =>
    [...handlers].sort(([a], [b]) => a.localeCompare(b));
  const loaders = (
    handlers: Map<string, HandlerDefinition>,
    table: string,
  ): string =>
    sorted(handlers)
      .map(
        ([operation, handler]) =>
          `  ${JSON.stringify(operation)}: async () => (await import(${JSON.stringify(handler.module)})).${handler.exportName}.${table}${
            /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(handler.member)
              ? `.${handler.member}`
              : `[${JSON.stringify(handler.member)}]`
          },`,
      )
      .join("\n");
  return (
    generatedHeader +
    `import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";\n` +
    `import type { StartOperationResult, UnparsedStartOperationData } from "~/server/operation-runtime/start-operation.contract";\n` +
    `import type { StartOperationRequest } from "~/server/operation-runtime/start-operation.server";\n` +
    `import type { WorkflowStreamHandler } from "~/server/operation-runtime/subscription-domain.server";\n` +
    `\nexport type StartOperationHandler<Output = UnparsedStartOperationData> = (options: { data: UnparsedStartOperationData; request: StartOperationRequest }) => Promise<StartOperationResult<Output>>;\n` +
    `export type StartOperationHandlerLoader<Output = UnparsedStartOperationData> = () => Promise<StartOperationHandler<Output>>;\n` +
    `export type WorkflowStreamHandlerLoader = () => Promise<WorkflowStreamHandler>;\n` +
    `\nexport const START_OPERATION_HANDLER_LOADERS = {\n${loaders(operations, "operations")}\n} as const satisfies Record<StartOperationIdOfKind<"query" | "mutation">, StartOperationHandlerLoader>;\n` +
    `\nexport type LoadedStartOperationHandler<Operation extends StartOperationIdOfKind<"query" | "mutation">> = Awaited<ReturnType<(typeof START_OPERATION_HANDLER_LOADERS)[Operation]>>;\n` +
    `export type StartOperationDispatchResult<Operation extends StartOperationIdOfKind<"query" | "mutation">> = Awaited<ReturnType<LoadedStartOperationHandler<Operation>>>;\n` +
    `\nexport const WORKFLOW_STREAM_HANDLER_LOADERS = {\n${loaders(subscriptions, "streams")}\n} as const satisfies Record<StartOperationIdOfKind<"subscription">, WorkflowStreamHandlerLoader>;\n`
  );
};

/** Stage 2 of `pnpm generate`: operation catalogs, lazy handler loaders and MCP tools. */
export const renderStartOperationArtifacts = async (): Promise<{
  artifacts: EntityArtifacts[];
  operationIds: string[];
}> => {
  const catalog = await renderClientCatalog();
  return {
    artifacts: [
      {
        relativePath:
          "apps/web/src/lib/generated/start-operation-registry.gen.ts",
        source: await renderStartOperationRegistry(),
      },
      {
        relativePath:
          "apps/web/src/server/generated/start-operation-handlers.gen.ts",
        source: await renderStartOperationHandlers(),
      },
      ...catalog.domains,
      catalog.all,
      catalog.commands,
      catalog.commandRuntime,
    ],
    operationIds: await collectOperationIds(),
  };
};
