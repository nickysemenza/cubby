import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
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
const OUTPUT = join(
  SOURCE_ROOT,
  "lib/generated/start-operation-registry.gen.ts",
);
const HANDLER_OUTPUT = join(
  SOURCE_ROOT,
  "server/generated/start-operation-handlers.gen.ts",
);

type Kind = "query" | "mutation" | "subscription";
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

type OperationObservability = {
  entities: readonly string[];
  productPhases: readonly string[];
};
type DomainMember = {
  operation: string;
  kind: Kind;
  observability: OperationObservability;
};
type DomainDeclaration = {
  path: string;
  domain: string;
  members: Map<string, DomainMember>;
};
type DomainDeclarations = {
  byOperation: Map<
    string,
    {
      kind: Kind;
      path: string;
      exportName: string;
      observability: OperationObservability;
    }
  >;
  byBinding: Map<string, DomainDeclaration>;
};

let cachedDomainDeclarations: DomainDeclarations | undefined;

/**
 * `defineOperationDomain` modules are loaded by the browser bundle, so a
 * runtime dependency on server-only code (or node builtins) would either crash
 * the client build or silently pull server modules into it. Type-only imports
 * are erased and stay legal. `import { type X } from "~/server/…"` is still
 * rejected: under verbatimModuleSyntax it emits a runtime `import {}` for its
 * side effects.
 */
const assertClientSafeImports = (path: string, body: Program["body"]): void => {
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (statement.importKind === "type") continue;
    const source = statement.source.value;
    if (/^~\/server(?:\/|$)/u.test(source) || source.startsWith("node:")) {
      throw new Error(
        `${relative(ROOT, path)} declares a Start operation domain but has a runtime import of ${JSON.stringify(source)}. Domain modules load in the browser; use \`import type\`, or move the runtime dependency into the domain's implementOperationDomain module.`,
      );
    }
  }
};

/**
 * Client `defineOperationDomain` declarations are the single authority for
 * which browser operations exist. Every server handler must map onto exactly
 * one of them: a handler member without a declaration and a second declaration
 * of the same operation id are both fail-fast errors, because either would
 * otherwise mint a registry entry (or merge two schemas) silently while
 * `pnpm check` stays green.
 */
export const collectDomainDeclarations = (): DomainDeclarations => {
  if (cachedDomainDeclarations) return cachedDomainDeclarations;
  const byOperation: DomainDeclarations["byOperation"] = new Map();
  const byBinding: DomainDeclarations["byBinding"] = new Map();
  const auditedModules = new Set<string>();
  for (const path of sourceFiles(SOURCE_ROOT)) {
    const program = parseFile(path);
    collectDomainsFromProgram(
      path,
      program,
      auditedModules,
      byOperation,
      byBinding,
    );
  }
  cachedDomainDeclarations = { byOperation, byBinding };
  return cachedDomainDeclarations;
};

function collectDomainsFromProgram(
  path: string,
  program: Program,
  auditedModules: Set<string>,
  byOperation: DomainDeclarations["byOperation"],
  byBinding: DomainDeclarations["byBinding"],
): void {
  for (const declarator of topLevelVariableDeclarators(program)) {
    const domain = declaredDomain(declarator.init);
    if (domain === null) continue;
    if (!auditedModules.has(path)) {
      auditedModules.add(path);
      assertClientSafeImports(path, program.body);
    }
    const members = collectDomainMembers(
      path,
      program,
      declarator.exportName,
      domain.name,
      domain.definitions,
      byOperation,
    );
    if (members.size > 0)
      byBinding.set(`${path}#${declarator.exportName}`, {
        path,
        domain: domain.name,
        members,
      });
  }
}

function declaredDomain(expression: Expression): {
  name: string;
  definitions: Extract<Expression, { type: "ObjectExpression" }>;
} | null {
  if (
    expression.type !== "CallExpression" ||
    calledName(expression.callee) !== "defineOperationDomain"
  ) {
    return null;
  }
  const [name, definitions] = expression.arguments;
  return name !== undefined &&
    name.type !== "SpreadElement" &&
    isStringLiteral(name) &&
    definitions?.type === "ObjectExpression"
    ? { name: name.value, definitions }
    : null;
}

function collectDomainMembers(
  path: string,
  program: Program,
  exportName: string,
  domain: string,
  definitions: Extract<Expression, { type: "ObjectExpression" }>,
  byOperation: DomainDeclarations["byOperation"],
): Map<string, DomainMember> {
  const members = new Map<string, DomainMember>();
  for (const property of definitions.properties) {
    const member = declaredDomainMember(path, program, property);
    if (member === null) continue;
    const operation = `${domain}.${member.name}`;
    const existing = byOperation.get(operation);
    if (existing) {
      throw new Error(
        `${operation} is declared more than once: ${relative(ROOT, existing.path)} and ${relative(ROOT, path)}. Each Start operation id may have exactly one client declaration; whichever schema the single handler used would win silently.`,
      );
    }
    byOperation.set(operation, {
      kind: member.kind,
      path,
      exportName,
      observability: member.observability,
    });
    members.set(member.name, {
      operation,
      kind: member.kind,
      observability: member.observability,
    });
  }
  return members;
}

const unwrapExpression = (expression: Expression): Expression =>
  expression.type === "TSAsExpression" ||
  expression.type === "TSSatisfiesExpression"
    ? unwrapExpression(expression.expression)
    : expression;

const sourcePath = (path: string, source: string): string | undefined => {
  const base = source.startsWith("~/")
    ? join(SOURCE_ROOT, source.slice(2))
    : source.startsWith(".")
      ? join(path, "..", source)
      : undefined;
  return base
    ? [".ts", ".tsx", "/index.ts", "/index.tsx"]
        .map((extension) => `${base}${extension}`)
        .find((candidate) => existsSync(candidate))
    : undefined;
};

const staticStringArray = (
  path: string,
  program: Program,
  rawExpression: Expression,
  seen = new Set<string>(),
): readonly string[] => {
  const expression = unwrapExpression(rawExpression);
  if (expression.type === "ArrayExpression") {
    return expression.elements.flatMap((element) => {
      if (element === null) return [];
      if (element.type === "SpreadElement")
        return staticStringArray(path, program, element.argument, seen);
      const value = unwrapExpression(element);
      if (isStringLiteral(value)) return [value.value];
      throw new Error(
        `${relative(ROOT, path)} observability arrays may contain only strings or static string-array spreads.`,
      );
    });
  }
  if (expression.type !== "Identifier") {
    throw new Error(
      `${relative(ROOT, path)} observability metadata must be a static string array.`,
    );
  }
  const key = `${path}#${expression.name}`;
  if (seen.has(key)) throw new Error(`Circular static array reference: ${key}`);
  seen.add(key);
  const local = topLevelVariableDeclarators(program).find(
    ({ exportName }) => exportName === expression.name,
  );
  if (local) return staticStringArray(path, program, local.init, seen);
  const binding = importBindings(program.body).get(expression.name);
  const target = binding ? sourcePath(path, binding.source) : undefined;
  if (!binding || !target) {
    throw new Error(
      `${relative(ROOT, path)} observability metadata references unresolved array ${expression.name}.`,
    );
  }
  const targetProgram = parseFile(target);
  const exported = topLevelVariableDeclarators(targetProgram).find(
    ({ exportName }) => exportName === binding.imported,
  );
  if (!exported) {
    throw new Error(
      `${relative(ROOT, target)} does not export static array ${binding.imported}.`,
    );
  }
  return staticStringArray(target, targetProgram, exported.init, seen);
};

const observabilityMetadata = (
  path: string,
  program: Program,
  definition: Expression | undefined,
): OperationObservability => {
  const value = definition ? unwrapExpression(definition) : undefined;
  if (value?.type !== "ObjectExpression")
    return { entities: [], productPhases: [] };
  const observability = value.properties.find(
    (property) =>
      property.type === "Property" &&
      propertyName(property.key) === "observability",
  );
  if (observability?.type !== "Property")
    return { entities: [], productPhases: [] };
  const metadata = unwrapExpression(observability.value);
  if (metadata.type !== "ObjectExpression") {
    throw new Error(
      `${relative(ROOT, path)} observability metadata must be an inline object.`,
    );
  }
  const array = (name: keyof OperationObservability) => {
    const property = metadata.properties.find(
      (candidate) =>
        candidate.type === "Property" && propertyName(candidate.key) === name,
    );
    return property?.type === "Property"
      ? staticStringArray(path, program, property.value, new Set())
      : [];
  };
  return { entities: array("entities"), productPhases: array("productPhases") };
};

function declaredDomainMember(
  path: string,
  program: Program,
  property: Extract<
    Expression,
    { type: "ObjectExpression" }
  >["properties"][number],
): { name: string; kind: Kind; observability: OperationObservability } | null {
  if (property.type !== "Property" || property.value.type !== "CallExpression")
    return null;
  const name = propertyName(property.key);
  const kind = calledName(property.value.callee);
  return name !== undefined &&
    (kind === "query" || kind === "mutation" || kind === "subscription")
    ? {
        name,
        kind,
        observability: observabilityMetadata(
          path,
          program,
          property.value.arguments[0]?.type === "SpreadElement"
            ? undefined
            : property.value.arguments[0],
        ),
      }
    : null;
}

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

/** Resolve an `implement*Domain` argument to its client declaration. */
const resolveDomainBinding = (
  path: string,
  implementer: string,
  bindings: Map<string, { source: string; imported: string }>,
  identifier: string,
): DomainDeclaration => {
  const binding = bindings.get(identifier);
  if (!binding || !binding.source.startsWith("~/")) {
    throw new Error(
      `${relative(ROOT, path)} passes ${identifier} to ${implementer}, but it is not a named import from a "~/" module.`,
    );
  }
  const base = join(SOURCE_ROOT, binding.source.slice(2));
  const target = [".ts", ".tsx"]
    .map((extension) => `${base}${extension}`)
    .find((candidate) => existsSync(candidate));
  const declaration = target
    ? collectDomainDeclarations().byBinding.get(`${target}#${binding.imported}`)
    : undefined;
  if (!declaration) {
    throw new Error(
      `${relative(ROOT, path)} implements ${identifier}, but ${binding.source} does not export a defineOperationDomain declaration named ${binding.imported}.`,
    );
  }
  return declaration;
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

let cachedHandlers: CollectedHandlers | undefined;

/**
 * Handlers are exported `implementOperationDomain` / `implementSubscriptionDomain`
 * tables under `apps/web/src/server` — a typed bijection with the client
 * declarations, so discovery needs no filename convention and no string
 * heuristics: compile the tables into lazy adapters rather than maintaining a
 * second handwritten dispatcher registry.
 */
export const collectStartOperationHandlers = (): CollectedHandlers => {
  if (cachedHandlers) return cachedHandlers;
  const collected: CollectedHandlers = {
    operations: new Map(),
    subscriptions: new Map(),
  };
  for (const path of sourceFiles(SERVER_ROOT)) {
    const program = parseFile(path);
    const bindings = importBindings(program.body);
    collectHandlersFromProgram(path, program, bindings, collected);
  }
  cachedHandlers = collected;
  return collected;
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

function collectHandlersFromProgram(
  path: string,
  program: Program,
  bindings: Map<string, { source: string; imported: string }>,
  collected: CollectedHandlers,
): void {
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : undefined;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const variable of declaration.declarations)
      collectHandlerVariable(path, variable, bindings, collected);
  }
}

function collectHandlerVariable(
  path: string,
  variable: Extract<
    Program["body"][number],
    { type: "VariableDeclaration" }
  >["declarations"][number],
  bindings: Map<string, { source: string; imported: string }>,
  collected: CollectedHandlers,
): void {
  const id = variable.id;
  const implementation = variable.init;
  if (id.type !== "Identifier" || implementation?.type !== "CallExpression")
    return;
  const implementer = calledName(implementation.callee);
  if (!isImplementer(implementer)) return;
  const [domainArg, tableArg] = implementation.arguments;
  if (domainArg?.type !== "Identifier" || tableArg?.type !== "ObjectExpression")
    throw new Error(
      `Unable to compile ${relative(ROOT, path)}:${id.name} — ${implementer} takes an imported domain identifier and an inline handler table.`,
    );
  const domain = resolveDomainBinding(
    path,
    implementer,
    bindings,
    domainArg.name,
  );
  for (const property of tableArg.properties)
    collectHandlerProperty(
      path,
      id.name,
      implementer,
      domain,
      property,
      collected,
    );
}

function collectHandlerProperty(
  path: string,
  exportName: string,
  implementer: ImplementerName,
  domain: DomainDeclaration,
  property: Extract<
    Expression,
    { type: "ObjectExpression" }
  >["properties"][number],
  collected: CollectedHandlers,
): void {
  if (property.type !== "Property") return;
  const memberName = propertyName(property.key);
  if (memberName === undefined) return;
  const member = domain.members.get(memberName);
  if (!member)
    throw new Error(
      `${relative(ROOT, path)}:${exportName} implements ${domain.domain}.${memberName}, which is not declared in ${relative(ROOT, domain.path)}.`,
    );
  if (implementerForKind(member.kind) !== implementer)
    throw new Error(
      `${relative(ROOT, path)}:${exportName} implements ${member.operation} with ${implementer}, but ${relative(ROOT, domain.path)} declares it as a ${member.kind}.`,
    );
  registerHandler(collected, member.kind, member.operation, {
    module: moduleSpecifier(path),
    exportName,
    member: memberName,
  });
}

/**
 * The registry: every client-declared operation, with the kind its declaration
 * gave it. `defineOperationDomain` is now the ONLY source — the heuristic
 * call-site harvest that used to mint the subscription rows is gone, along with
 * the class of bug where a hand-written stream wrapper's operation string was
 * the registry entry.
 */
export const collectStartOperations = (): Map<
  string,
  { kind: Kind; observability: OperationObservability }
> => {
  const declarations = collectDomainDeclarations();

  // Fires earlier and more clearly than the generated loader's `satisfies`
  // exhaustiveness failure (which stays as belt-and-braces): a declared
  // operation nobody implements is a broken client call, not a type puzzle.
  const handlers = collectStartOperationHandlers();
  for (const [operation, declared] of declarations.byOperation) {
    const implementer =
      declared.kind === "subscription"
        ? "implementSubscriptionDomain"
        : "implementOperationDomain";
    const table =
      declared.kind === "subscription"
        ? handlers.subscriptions
        : handlers.operations;
    if (!table.has(operation)) {
      throw new Error(
        `${operation} is declared by ${declared.exportName} in ${relative(ROOT, declared.path)} but has no ${implementer} handler under apps/web/src/server. Implement the member there, or delete the declaration.`,
      );
    }
  }
  return new Map(
    [...declarations.byOperation].map(([operation, declared]) => [
      operation,
      {
        kind: declared.kind,
        observability: declared.observability,
      },
    ]),
  );
};

export const renderStartOperationRegistry = (): string => {
  const operations = [...collectStartOperations()].sort(([a], [b]) =>
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

export const renderStartOperationHandlers = (): string => {
  const { operations, subscriptions } = collectStartOperationHandlers();
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
  [OUTPUT, renderStartOperationRegistry()],
  [HANDLER_OUTPUT, renderStartOperationHandlers()],
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
