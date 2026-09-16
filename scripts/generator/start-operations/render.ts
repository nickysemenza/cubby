import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type {
  HttpResources,
  HttpResourceVerb,
} from "../entities/render/index.ts";
import {
  collectDeclaredOperations,
  collectNativeOperationIds,
  collectStartOperationHandlers,
  collectStartOperations,
  type HandlerDefinition,
  SOURCE_ROOT,
} from "./collect.ts";

const renderStartOperationRegistry = async (): Promise<string> => {
  const operations = [...(await collectStartOperations())].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    generatedHeader +
    `export const START_OPERATIONS = {\n${operations
      .map(([operation, { kind, observability }]) => {
        const metadata = [
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
    `import type { StartOperationResult, UnparsedStartOperationData } from "~/server/start-operation.contract";\n` +
    `import type { StartOperationRequest } from "~/server/start-operation.server";\n` +
    `import type { WorkflowStreamHandler } from "~/server/subscription-domain.server";\n` +
    `\nexport type StartOperationHandler<Output = UnparsedStartOperationData> = (options: { data: UnparsedStartOperationData; request: StartOperationRequest }) => Promise<StartOperationResult<Output>>;\n` +
    `export type StartOperationHandlerLoader<Output = UnparsedStartOperationData> = () => Promise<StartOperationHandler<Output>>;\n` +
    `export type WorkflowStreamHandlerLoader = () => Promise<WorkflowStreamHandler>;\n` +
    `\nexport const START_OPERATION_HANDLER_LOADERS = {\n${loaders(operations, "operations")}\n} as const satisfies Record<StartOperationIdOfKind<"query" | "mutation">, StartOperationHandlerLoader>;\n` +
    `\nexport type LoadedStartOperationHandler<Operation extends StartOperationIdOfKind<"query" | "mutation">> = Awaited<ReturnType<(typeof START_OPERATION_HANDLER_LOADERS)[Operation]>>;\n` +
    `export type StartOperationDispatchResult<Operation extends StartOperationIdOfKind<"query" | "mutation">> = Awaited<ReturnType<LoadedStartOperationHandler<Operation>>>;\n` +
    `\nexport const WORKFLOW_STREAM_HANDLER_LOADERS = {\n${loaders(subscriptions, "streams")}\n} as const satisfies Record<StartOperationIdOfKind<"subscription">, WorkflowStreamHandlerLoader>;\n`
  );
};

const RESOURCE_HELPERS = {
  list: "resourceList",
  timeline: "resourceTimeline",
  get: "resourceGet",
  create: "resourceCreate",
  update: "resourceUpdate",
  delete: "resourceDelete",
} as const satisfies Record<HttpResourceVerb, string>;

/** The wire projection the router itself uses, for the transport decision. */
type WireModule = {
  toWire: (schema: z.ZodType, io: "input") => z.ZodType;
  isFlatQueryInput: (wire: z.ZodType) => boolean;
};

const loadWire = async (): Promise<WireModule> => {
  const wire: object = await import(
    pathToFileURL(join(SOURCE_ROOT, "lib/http-api/wire.ts")).href
  );
  // SAFETY: the module is the router's own wire projection; a missing export
  // fails at the first call below, at generation time.
  return wire as WireModule;
};

/**
 * A query travels as GET parameters when its input is flat (scalars, enums,
 * dates, lists of those) and as a POST body otherwise.
 */
const queryHelper = (
  wire: WireModule,
  input: z.ZodType | undefined,
): "rpcQuery" | "rpcQueryPost" =>
  input === undefined ||
  input instanceof z.ZodUndefined ||
  wire.isFlatQueryInput(wire.toWire(input, "input"))
    ? "rpcQuery"
    : "rpcQueryPost";

/**
 * The HTTP contract is a real ts-rest router whose routes reference contract
 * members and generated entity bindings by name, so the generated file stays
 * statically typed without copying any schema source. Entity operations keep
 * their explicit wire schemas inside the router helpers because their
 * contract members are type-only carriers.
 */
const renderHttpContract = async (
  resources: HttpResources,
): Promise<string> => {
  const declarations = [...(await collectDeclaredOperations())].sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const wire = await loadWire();
  const domains = new Map<string, string[]>();
  for (const [id, declaration] of declarations) {
    if (declaration.kind === "subscription" || !declaration.http) continue;
    const domain = id.slice(0, id.length - declaration.member.length - 1);
    if (domain === "resources")
      throw new Error(`Reserved HTTP client namespace: ${domain}`);
    const helper =
      declaration.kind === "query"
        ? queryHelper(wire, declaration.input)
        : "rpcMutation";
    const members = domains.get(domain) ?? [];
    members.push(
      `${JSON.stringify(declaration.member)}: ${helper}(${JSON.stringify(domain)}, ${JSON.stringify(declaration.member)}, contracts.${declaration.exportName}.ops[${JSON.stringify(declaration.member)}]),`,
    );
    domains.set(domain, members);
  }
  const resourceRoutes = Object.entries(resources)
    .map(
      ([entity, { basePath, verbs }]) =>
        `${JSON.stringify(entity)}: {\n${verbs
          .map(
            (verb) =>
              `${verb}: ${RESOURCE_HELPERS[verb]}(${JSON.stringify(entity)}, ${JSON.stringify(basePath)}),`,
          )
          .join("\n")}\n},`,
    )
    .join("\n");
  return (
    generatedHeader +
    `import * as contracts from "~/contracts/index";\n` +
    `import { httpContractBuilder, httpRouterOptions, rpcMutation, rpcQuery, rpcQueryPost, resourceCreate, resourceDelete, resourceGet, resourceList, resourceTimeline, resourceUpdate } from "~/lib/http-api/router";\n` +
    `export const httpContract = httpContractBuilder.router({\n` +
    [...domains]
      .map(
        ([name, members]) =>
          `${JSON.stringify(name)}: {\n${members.join("\n")}\n},`,
      )
      .join("\n") +
    `\nresources: {\n${resourceRoutes}\n},\n}, httpRouterOptions);\n`
  );
};

/**
 * Stage 2 of `pnpm generate`: the Start operation registry, the lazy handler
 * loaders, and the ts-rest HTTP contract. Runs after stage 1's files are on
 * disk (the contracts runtime-import `~/entities/generated/*.gen.ts`) and
 * takes stage 1's `HTTP_RESOURCES` in memory rather than re-parsing its
 * artifact.
 */
export const renderStartOperationArtifacts = async (
  resources: HttpResources,
): Promise<{
  artifacts: EntityArtifacts[];
  /** RPC ids flagged `native:`, for the OpenAPI stage's client filter. */
  nativeOperations: string[];
}> => ({
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
    {
      relativePath: "apps/web/src/lib/generated/http-contract.gen.ts",
      source: await renderHttpContract(resources),
    },
  ],
  nativeOperations: await collectNativeOperationIds(),
});
