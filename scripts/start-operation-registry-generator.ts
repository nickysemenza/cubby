import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  type Expression,
  parseSync,
  type Program,
  type PropertyKey,
  type StringLiteral,
} from "oxc-parser";

const ROOT = new URL("..", import.meta.url).pathname;
const SOURCE_ROOT = join(ROOT, "apps/web/src");
const SERVER_ROOT = join(SOURCE_ROOT, "server");
const CONTRACTS_ROOT = join(SOURCE_ROOT, "contracts");
const OUTPUT = join(
  SOURCE_ROOT,
  "lib/generated/start-operation-registry.gen.ts",
);
const HANDLER_OUTPUT = join(
  SOURCE_ROOT,
  "server/generated/start-operation-handlers.gen.ts",
);
const HTTP_OUTPUT = join(SOURCE_ROOT, "lib/generated/http-contract.gen.ts");

type Kind = "query" | "mutation" | "subscription";
const KINDS = new Set<string>(["query", "mutation", "subscription"]);
type OperationObservability = {
  entities: readonly string[];
  productPhases: readonly string[];
};
type HandlerDefinition = {
  module: string;
  exportName: string;
  /**
   * The handler is `<exportName>.<table>[<member>]`, already
   * `StartOperationHandler` / `WorkflowStreamHandler`-shaped, so the emitted
   * loader needs no cast.
   */
  member: string;
};

/** The runtime shape of a `defineContract(...)` value, as the generator reads it. */
type ContractMember = {
  kind: Kind;
  observability?: {
    entities?: readonly string[];
    productPhases?: readonly string[];
  };
  /** `false` keeps the member off the HTTP API (see contracts/define.ts). */
  http?: false;
};
type Contract = { domain: string; ops: Record<string, ContractMember> };
type LoadedContract = { exportName: string; contract: Contract };
type DeclaredOperation = {
  kind: Kind;
  observability: OperationObservability;
  http: boolean;
  exportName: string;
  member: string;
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[jt]sx?$/u.test(entry.name) &&
      !/\.(?:test|spec)\./u.test(entry.name)
      ? [path]
      : [];
  });

const isStringLiteral = (
  expression: Expression | PropertyKey,
): expression is StringLiteral =>
  expression.type === "Literal" && typeof expression.value === "string";

const propertyName = (key: PropertyKey): string | undefined => {
  if (key.type === "Identifier") return key.name;
  return isStringLiteral(key) ? key.value : undefined;
};

const calledName = (expression: Expression): string | undefined => {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type !== "MemberExpression") return undefined;
  return propertyName(expression.property);
};

const moduleSpecifier = (path: string): string =>
  `~/${relative(SOURCE_ROOT, path)
    .replaceAll("\\", "/")
    .replace(/\.[cm]?[jt]sx?$/u, "")}`;

const programCache = new Map<string, Program>();
const parseFile = (path: string): Program => {
  const cached = programCache.get(path);
  if (cached) return cached;
  const program = parseSync(path, readFileSync(path, "utf8"), {
    lang: path.endsWith("x") ? "tsx" : "ts",
  }).program;
  programCache.set(path, program);
  return program;
};

const topLevelVariableDeclarators = (
  program: Program,
): { exportName: string; init: Expression }[] => {
  const declarators: { exportName: string; init: Expression }[] = [];
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement.type === "VariableDeclaration"
          ? statement
          : undefined;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const variable of declaration.declarations) {
      if (variable.id.type === "Identifier" && variable.init) {
        declarators.push({ exportName: variable.id.name, init: variable.init });
      }
    }
  }
  return declarators;
};

/** Named-import bindings of a module: local name -> imported name + source. */
const importBindings = (
  body: Program["body"],
): Map<string, { source: string; imported: string }> => {
  const bindings = new Map<string, { source: string; imported: string }>();
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration") continue;
    const source = statement.source.value;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      const imported = propertyName(specifier.imported);
      if (imported) bindings.set(specifier.local.name, { source, imported });
    }
  }
  return bindings;
};

const runtimeImportSources = (body: Program["body"]): string[] =>
  body.flatMap((statement) =>
    statement.type === "ImportDeclaration" && statement.importKind !== "type"
      ? [statement.source.value]
      : [],
  );

/**
 * Contract modules are imported by the browser catalog, the server
 * implementers, the ts-rest router, and this generator, so they may depend
 * only on schema code. A runtime import outside this list would either drag
 * server code into the client bundle or make the generator's import fail.
 */
const CONTRACT_IMPORT_ALLOWLIST = [
  /^zod$/u,
  /^@cubby\//u,
  /^~\/contracts\//u,
  /^~\/entities\/generated\//u,
  /^\.\/[^/]+$/u,
];

const assertContractPurity = (path: string): void => {
  for (const source of runtimeImportSources(parseFile(path).body)) {
    if (CONTRACT_IMPORT_ALLOWLIST.some((pattern) => pattern.test(source)))
      continue;
    throw new Error(
      `${relative(ROOT, path)} has a runtime import of ${JSON.stringify(source)}. Contract modules may import only zod, @cubby/* packages, other contracts, and generated entity artifacts; use \`import type\` for anything else.`,
    );
  }
};

/**
 * `defineOperationDomain` modules are loaded by the browser bundle, so a
 * runtime dependency on server-only code (or node builtins) would either crash
 * the client build or silently pull server modules into it. Type-only imports
 * are erased and stay legal. `import { type X } from "~/server/…"` is still
 * rejected: under verbatimModuleSyntax it emits a runtime `import {}` for its
 * side effects.
 */
const assertClientSafeImports = (path: string): void => {
  const program = parseFile(path);
  const declaresDomain = topLevelVariableDeclarators(program).some(
    ({ init }) =>
      init.type === "CallExpression" &&
      calledName(init.callee) === "defineOperationDomain",
  );
  if (!declaresDomain) return;
  for (const source of runtimeImportSources(program.body)) {
    if (/^~\/server(?:\/|$)/u.test(source) || source.startsWith("node:")) {
      throw new Error(
        `${relative(ROOT, path)} declares a Start operation domain but has a runtime import of ${JSON.stringify(source)}. Domain modules load in the browser; use \`import type\`, or move the runtime dependency into the domain's implementOperationDomain module.`,
      );
    }
  }
};

const isContractMember = (value: unknown): value is ContractMember =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  typeof value.kind === "string" &&
  KINDS.has(value.kind);

const isContract = (value: unknown): value is Contract =>
  typeof value === "object" &&
  value !== null &&
  "domain" in value &&
  typeof value.domain === "string" &&
  "ops" in value &&
  typeof value.ops === "object" &&
  value.ops !== null &&
  Object.values(value.ops).every(isContractMember);

let cachedContracts: Promise<LoadedContract[]> | undefined;

/**
 * Contracts are the single authority for which operations exist. They are
 * imported at build time rather than parsed: the schemas are real values, so
 * the HTTP contract can reference them by name instead of copying source.
 * Every `*.contract.ts` file must be re-exported from the index barrel, and
 * every export of the barrel must be a contract.
 */
export const loadContracts = (): Promise<LoadedContract[]> => {
  cachedContracts ??= (async () => {
    const indexPath = join(CONTRACTS_ROOT, "index.ts");
    const files = readdirSync(CONTRACTS_ROOT)
      .filter((name) => name.endsWith(".contract.ts"))
      .sort();
    const reexported = new Set(
      parseFile(indexPath).body.flatMap((statement) =>
        statement.type === "ExportNamedDeclaration" && statement.source
          ? [statement.source.value.replace(/^\.\//u, "")]
          : [],
      ),
    );
    for (const file of files) {
      assertContractPurity(join(CONTRACTS_ROOT, file));
      if (!reexported.has(file.replace(/\.ts$/u, "")))
        throw new Error(
          `apps/web/src/contracts/${file} is not exported from apps/web/src/contracts/index.ts.`,
        );
    }
    const index: object = await import(pathToFileURL(indexPath).href);
    const loaded: LoadedContract[] = [];
    for (const [exportName, value] of Object.entries(index)) {
      if (!isContract(value))
        throw new Error(
          `apps/web/src/contracts/index.ts export ${exportName} is not a defineContract() value.`,
        );
      loaded.push({ exportName, contract: value });
    }
    return loaded.sort((a, b) => a.exportName.localeCompare(b.exportName));
  })();
  return cachedContracts;
};

let cachedOperations: Promise<Map<string, DeclaredOperation>> | undefined;

/**
 * Every declared operation id with its kind. A second declaration of the same
 * id is a fail-fast error: whichever schema the single handler used would win
 * silently otherwise.
 */
export const collectDeclaredOperations = (): Promise<
  Map<string, DeclaredOperation>
> => {
  cachedOperations ??= (async () => {
    const byOperation = new Map<string, DeclaredOperation>();
    for (const { exportName, contract } of await loadContracts()) {
      for (const [member, definition] of Object.entries(contract.ops)) {
        const operation = `${contract.domain}.${member}`;
        const existing = byOperation.get(operation);
        if (existing)
          throw new Error(
            `${operation} is declared more than once: ${existing.exportName} and ${exportName}. Each Start operation id may have exactly one contract member.`,
          );
        byOperation.set(operation, {
          kind: definition.kind,
          observability: {
            entities: [...(definition.observability?.entities ?? [])],
            productPhases: [...(definition.observability?.productPhases ?? [])],
          },
          http: definition.http !== false,
          exportName,
          member,
        });
      }
    }
    return byOperation;
  })();
  return cachedOperations;
};

/** Resolve an `implement*Domain` argument to its contract. */
const resolveContractBinding = async (
  path: string,
  implementer: string,
  bindings: Map<string, { source: string; imported: string }>,
  identifier: string,
): Promise<LoadedContract> => {
  const binding = bindings.get(identifier);
  if (!binding || !binding.source.startsWith("~/contracts/")) {
    throw new Error(
      `${relative(ROOT, path)} passes ${identifier} to ${implementer}, but it is not a named import from a "~/contracts/" module.`,
    );
  }
  const target = `${join(SOURCE_ROOT, binding.source.slice(2))}.ts`;
  if (!existsSync(target))
    throw new Error(
      `${relative(ROOT, path)} imports ${binding.source}, which does not exist.`,
    );
  const loaded = (await loadContracts()).find(
    (candidate) => candidate.exportName === binding.imported,
  );
  if (!loaded) {
    throw new Error(
      `${relative(ROOT, path)} implements ${identifier}, but ${binding.source} does not export a contract named ${binding.imported} through apps/web/src/contracts/index.ts.`,
    );
  }
  return loaded;
};

/**
 * The two implementer tables, and the descriptor table each one reads from.
 * A member's declared kind decides which implementer owns it, so implementing
 * a subscription with `implementOperationDomain` (or the reverse) fails here
 * rather than at whichever runtime first notices the shape mismatch.
 */
const IMPLEMENTERS = {
  implementOperationDomain: {
    table: "operations",
  },
  implementSubscriptionDomain: { table: "streams" },
} as const satisfies Record<string, { table: string }>;
type ImplementerName = keyof typeof IMPLEMENTERS;

const implementerForKind = (kind: Kind): ImplementerName =>
  kind === "subscription"
    ? "implementSubscriptionDomain"
    : "implementOperationDomain";

const isImplementer = (name: string | undefined): name is ImplementerName =>
  name !== undefined && Object.hasOwn(IMPLEMENTERS, name);

export type CollectedHandlers = {
  /** `query` | `mutation` members, dispatched by `dispatchStartOperation`. */
  operations: Map<string, HandlerDefinition>;
  /** `subscription` members, dispatched by `dispatchWorkflowStream`. */
  subscriptions: Map<string, HandlerDefinition>;
};

let cachedHandlers: Promise<CollectedHandlers> | undefined;

/**
 * Handlers are exported `implementOperationDomain` / `implementSubscriptionDomain`
 * tables under `apps/web/src/server` — a typed bijection with the contracts,
 * so discovery needs no filename convention and no string heuristics: compile
 * the tables into lazy adapters rather than maintaining a second handwritten
 * dispatcher registry.
 */
export const collectStartOperationHandlers = (): Promise<CollectedHandlers> => {
  cachedHandlers ??= (async () => {
    const collected: CollectedHandlers = {
      operations: new Map(),
      subscriptions: new Map(),
    };
    for (const path of sourceFiles(SERVER_ROOT)) {
      const program = parseFile(path);
      const bindings = importBindings(program.body);
      for (const statement of program.body) {
        const declaration =
          statement.type === "ExportNamedDeclaration"
            ? statement.declaration
            : undefined;
        if (declaration?.type !== "VariableDeclaration") continue;
        for (const variable of declaration.declarations)
          await collectHandlerVariable(path, variable, bindings, collected);
      }
    }
    return collected;
  })();
  return cachedHandlers;
};

function registerHandler(
  collected: CollectedHandlers,
  kind: Kind,
  operation: string,
  definition: HandlerDefinition,
): void {
  const handlers =
    kind === "subscription" ? collected.subscriptions : collected.operations;
  const existing =
    collected.operations.get(operation) ??
    collected.subscriptions.get(operation);
  if (existing)
    throw new Error(
      `Duplicate browser operation ${operation}: ${existing.module}.${existing.exportName} and ${definition.module}.${definition.exportName}`,
    );
  handlers.set(operation, definition);
}

async function collectHandlerVariable(
  path: string,
  variable: Extract<
    Program["body"][number],
    { type: "VariableDeclaration" }
  >["declarations"][number],
  bindings: Map<string, { source: string; imported: string }>,
  collected: CollectedHandlers,
): Promise<void> {
  const id = variable.id;
  const implementation = variable.init;
  if (id.type !== "Identifier" || implementation?.type !== "CallExpression")
    return;
  const implementer = calledName(implementation.callee);
  if (!isImplementer(implementer)) return;
  const [contractArg, tableArg] = implementation.arguments;
  if (
    contractArg?.type !== "Identifier" ||
    tableArg?.type !== "ObjectExpression"
  )
    throw new Error(
      `Unable to compile ${relative(ROOT, path)}:${id.name} — ${implementer} takes an imported contract identifier and an inline handler table.`,
    );
  const { contract } = await resolveContractBinding(
    path,
    implementer,
    bindings,
    contractArg.name,
  );
  for (const property of tableArg.properties) {
    if (property.type !== "Property") continue;
    const memberName = propertyName(property.key);
    if (memberName === undefined) continue;
    const member = contract.ops[memberName];
    if (!member)
      throw new Error(
        `${relative(ROOT, path)}:${id.name} implements ${contract.domain}.${memberName}, which ${contractArg.name} does not declare.`,
      );
    if (implementerForKind(member.kind) !== implementer)
      throw new Error(
        `${relative(ROOT, path)}:${id.name} implements ${contract.domain}.${memberName} with ${implementer}, but its contract declares it as a ${member.kind}.`,
      );
    registerHandler(
      collected,
      member.kind,
      `${contract.domain}.${memberName}`,
      {
        module: moduleSpecifier(path),
        exportName: id.name,
        member: memberName,
      },
    );
  }
}

/**
 * The registry: every declared operation, with the kind its contract gave it.
 * A declared operation nobody implements is a broken client call, not a type
 * puzzle, so it fails here, earlier and more clearly than the generated
 * loader's `satisfies` exhaustiveness failure (which stays as belt-and-braces).
 */
export const collectStartOperations = async (): Promise<
  Map<string, { kind: Kind; observability: OperationObservability }>
> => {
  const declarations = await collectDeclaredOperations();
  const handlers = await collectStartOperationHandlers();
  for (const [operation, declared] of declarations) {
    const implementer = implementerForKind(declared.kind);
    const table =
      declared.kind === "subscription"
        ? handlers.subscriptions
        : handlers.operations;
    if (!table.has(operation)) {
      throw new Error(
        `${operation} is declared by ${declared.exportName} in apps/web/src/contracts but has no ${implementer} handler under apps/web/src/server. Implement the member there, or delete the declaration.`,
      );
    }
  }
  for (const path of sourceFiles(SOURCE_ROOT)) assertClientSafeImports(path);
  return new Map(
    [...declarations].map(([operation, declared]) => [
      operation,
      { kind: declared.kind, observability: declared.observability },
    ]),
  );
};

export const renderStartOperationRegistry = async (): Promise<string> => {
  const operations = [...(await collectStartOperations())].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    `/** Generated by scripts/start-operation-registry-generator.ts. */\n` +
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

export const renderStartOperationHandlers = async (): Promise<string> => {
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
    `/** Generated by scripts/start-operation-registry-generator.ts. */\n` +
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

const httpResourceVerbs = [
  "list",
  "get",
  "create",
  "update",
  "delete",
] as const;
type HttpResourceVerb = (typeof httpResourceVerbs)[number];
const httpResourcesSchema = z.record(
  z.string(),
  z.object({ basePath: z.string(), verbs: z.array(z.enum(httpResourceVerbs)) }),
);

const RESOURCE_HELPERS = {
  list: "resourceList",
  get: "resourceGet",
  create: "resourceCreate",
  update: "resourceUpdate",
  delete: "resourceDelete",
} as const satisfies Record<HttpResourceVerb, string>;

/**
 * The HTTP contract is a real ts-rest router whose routes reference contract
 * members and generated entity bindings by name, so the generated file stays
 * statically typed without copying any schema source. Entity operations keep
 * their explicit wire schemas inside the router helpers because their
 * contract members are type-only carriers.
 */
export const renderHttpContract = async (): Promise<string> => {
  const declarations = [...(await collectDeclaredOperations())].sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const resourcesModule: object = await import(
    pathToFileURL(join(SOURCE_ROOT, "lib/generated/http-resources.gen.ts")).href
  );
  const resources = httpResourcesSchema.parse(
    "HTTP_RESOURCES" in resourcesModule ? resourcesModule.HTTP_RESOURCES : null,
  );
  const domains = new Map<string, string[]>();
  for (const [id, declaration] of declarations) {
    if (declaration.kind === "subscription" || !declaration.http) continue;
    const domain = id.slice(0, id.length - declaration.member.length - 1);
    if (domain === "resources")
      throw new Error(`Reserved HTTP client namespace: ${domain}`);
    const helper = declaration.kind === "query" ? "rpcQuery" : "rpcMutation";
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
    `/** Generated by scripts/start-operation-registry-generator.ts. */\n` +
    `import * as contracts from "~/contracts/index";\n` +
    `import { httpContractBuilder, httpRouterOptions, rpcMutation, rpcQuery, resourceCreate, resourceDelete, resourceGet, resourceList, resourceUpdate } from "~/lib/http-api/router";\n` +
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

const format = (path: string, source: string): string => {
  const formatted = spawnSync(
    "pnpm",
    ["exec", "oxfmt", "--stdin-filepath", path],
    { input: source, encoding: "utf8" },
  );
  if (formatted.status !== 0) {
    throw new Error(
      formatted.stderr || `Unable to format ${relative(ROOT, path)}`,
    );
  }
  return formatted.stdout;
};

const outputs = [
  [OUTPUT, await renderStartOperationRegistry()],
  [HANDLER_OUTPUT, await renderStartOperationHandlers()],
  [HTTP_OUTPUT, await renderHttpContract()],
] as const;
for (const [path, source] of outputs) {
  const rendered = format(path, source);
  if (process.argv.includes("--check")) {
    const current = readFileSync(path, "utf8");
    if (current !== rendered) {
      console.error(
        `${relative(ROOT, path)} is stale. Run pnpm start-operations:generate.`,
      );
      process.exitCode = 1;
    }
  } else {
    writeFileSync(path, rendered);
  }
}
