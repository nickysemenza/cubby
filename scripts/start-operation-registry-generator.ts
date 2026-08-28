import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { parseSync } from "oxc-parser";

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
type AstNode = { type: string; [key: string]: unknown };

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[jt]sx?$/u.test(entry.name) &&
      !/\.(?:test|spec)\./u.test(entry.name)
      ? [path]
      : [];
  });

const calledName = (expression: AstNode): string | undefined =>
  expression.type === "Identifier"
    ? (expression.name as string | undefined)
    : expression.type === "MemberExpression"
      ? ((expression.property as AstNode | undefined)?.name as
          | string
          | undefined)
      : undefined;

const moduleSpecifier = (path: string): string =>
  `~/${relative(SOURCE_ROOT, path)
    .replaceAll("\\", "/")
    .replace(/\.[cm]?[jt]sx?$/u, "")}`;

const programCache = new Map<string, AstNode>();
const parseFile = (path: string): AstNode => {
  const cached = programCache.get(path);
  if (cached) return cached;
  const program = parseSync(path, readFileSync(path, "utf8"), {
    lang: path.endsWith("x") ? "tsx" : "ts",
  }).program as unknown as AstNode;
  programCache.set(path, program);
  return program;
};

const topLevelVariableDeclarators = (
  program: AstNode,
): { exportName: string; init: AstNode }[] => {
  const body = Array.isArray(program.body) ? (program.body as AstNode[]) : [];
  const declarators: { exportName: string; init: AstNode }[] = [];
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? (statement.declaration as AstNode | undefined)
        : statement.type === "VariableDeclaration"
          ? statement
          : undefined;
    if (declaration?.type !== "VariableDeclaration") continue;
    const variables = Array.isArray(declaration.declarations)
      ? (declaration.declarations as AstNode[])
      : [];
    for (const variable of variables) {
      const id = variable.id as AstNode | undefined;
      const init = variable.init as AstNode | undefined;
      if (typeof id?.name === "string" && init) {
        declarators.push({ exportName: id.name, init });
      }
    }
  }
  return declarators;
};

type DomainMember = { operation: string; kind: Kind };
type DomainDeclaration = {
  path: string;
  domain: string;
  members: Map<string, DomainMember>;
};
type DomainDeclarations = {
  byOperation: Map<string, { kind: Kind; path: string; exportName: string }>;
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
const assertClientSafeImports = (path: string, body: AstNode[]): void => {
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (statement.importKind === "type") continue;
    const source = (statement.source as AstNode | undefined)?.value;
    if (typeof source !== "string") continue;
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
    for (const { exportName, init } of topLevelVariableDeclarators(program)) {
      if (
        init.type !== "CallExpression" ||
        calledName(init.callee as AstNode) !== "defineOperationDomain"
      ) {
        continue;
      }
      if (!auditedModules.has(path)) {
        auditedModules.add(path);
        assertClientSafeImports(
          path,
          Array.isArray(program.body) ? (program.body as AstNode[]) : [],
        );
      }
      const args = Array.isArray(init.arguments)
        ? (init.arguments as AstNode[])
        : [];
      const [domainArg, definitionsArg] = args;
      if (
        domainArg?.type !== "Literal" ||
        typeof domainArg.value !== "string" ||
        definitionsArg?.type !== "ObjectExpression"
      ) {
        continue;
      }
      const members = new Map<string, DomainMember>();
      const properties = Array.isArray(definitionsArg.properties)
        ? (definitionsArg.properties as AstNode[])
        : [];
      for (const property of properties) {
        if (property.type !== "Property") continue;
        const key = property.key as AstNode | undefined;
        const value = property.value as AstNode | undefined;
        const memberName = key?.name ?? key?.value;
        if (typeof memberName !== "string" || value?.type !== "CallExpression")
          continue;
        const kind = calledName(value.callee as AstNode);
        if (kind !== "query" && kind !== "mutation" && kind !== "subscription")
          continue;
        const operation = `${domainArg.value}.${memberName}`;
        const existing = byOperation.get(operation);
        if (existing) {
          throw new Error(
            `${operation} is declared more than once: ${relative(ROOT, existing.path)} and ${relative(ROOT, path)}. Each Start operation id may have exactly one client declaration; whichever schema the single handler used would win silently.`,
          );
        }
        byOperation.set(operation, { kind, path, exportName });
        members.set(memberName, { operation, kind });
      }
      if (members.size > 0) {
        byBinding.set(`${path}#${exportName}`, {
          path,
          domain: domainArg.value,
          members,
        });
      }
    }
  }
  cachedDomainDeclarations = { byOperation, byBinding };
  return cachedDomainDeclarations;
};

/** Named-import bindings of a module: local name -> imported name + source. */
const importBindings = (
  body: AstNode[],
): Map<string, { source: string; imported: string }> => {
  const bindings = new Map<string, { source: string; imported: string }>();
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration") continue;
    const source = (statement.source as AstNode | undefined)?.value;
    if (typeof source !== "string") continue;
    const specifiers = Array.isArray(statement.specifiers)
      ? (statement.specifiers as AstNode[])
      : [];
    for (const specifier of specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      const local = (specifier.local as AstNode | undefined)?.name;
      const importedNode = specifier.imported as AstNode | undefined;
      const imported = importedNode?.name ?? importedNode?.value;
      if (typeof local === "string" && typeof imported === "string") {
        bindings.set(local, { source, imported });
      }
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
    kinds: ["query", "mutation"],
  },
  implementSubscriptionDomain: { table: "streams", kinds: ["subscription"] },
} as const satisfies Record<string, { table: string; kinds: readonly Kind[] }>;
type ImplementerName = keyof typeof IMPLEMENTERS;

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
  const register = (
    kind: Kind,
    operation: string,
    definition: HandlerDefinition,
  ) => {
    const handlers =
      kind === "subscription" ? collected.subscriptions : collected.operations;
    const existing =
      collected.operations.get(operation) ??
      collected.subscriptions.get(operation);
    if (existing) {
      throw new Error(
        `Duplicate browser operation ${operation}: ${existing.module}.${existing.exportName} and ${definition.module}.${definition.exportName}`,
      );
    }
    handlers.set(operation, definition);
  };
  for (const path of sourceFiles(SERVER_ROOT)) {
    const program = parseFile(path);
    const body = Array.isArray(program.body) ? (program.body as AstNode[]) : [];
    const bindings = importBindings(body);
    for (const statement of body) {
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? (statement.declaration as AstNode | undefined)
          : undefined;
      if (declaration?.type !== "VariableDeclaration") continue;
      const variables = Array.isArray(declaration.declarations)
        ? (declaration.declarations as AstNode[])
        : [];
      for (const variable of variables) {
        const id = variable.id as AstNode | undefined;
        const implementation = variable.init as AstNode | undefined;
        if (typeof id?.name !== "string") continue;
        const implementer =
          implementation?.type === "CallExpression"
            ? calledName(implementation.callee as AstNode)
            : undefined;
        if (!isImplementer(implementer)) continue;
        const args = Array.isArray(implementation?.arguments)
          ? (implementation.arguments as AstNode[])
          : [];
        const [domainArg, tableArg] = args;
        if (
          domainArg?.type !== "Identifier" ||
          typeof domainArg.name !== "string" ||
          tableArg?.type !== "ObjectExpression"
        ) {
          throw new Error(
            `Unable to compile ${relative(ROOT, path)}:${id.name} — ${implementer} takes an imported domain identifier and an inline handler table.`,
          );
        }
        const domain = resolveDomainBinding(
          path,
          implementer,
          bindings,
          domainArg.name,
        );
        const allowed: readonly Kind[] = IMPLEMENTERS[implementer].kinds;
        const properties = Array.isArray(tableArg.properties)
          ? (tableArg.properties as AstNode[])
          : [];
        for (const property of properties) {
          if (property.type !== "Property") continue;
          const key = property.key as AstNode | undefined;
          const memberName = key?.name ?? key?.value;
          if (typeof memberName !== "string") continue;
          const member = domain.members.get(memberName);
          if (!member) {
            throw new Error(
              `${relative(ROOT, path)}:${id.name} implements ${domain.domain}.${memberName}, which is not declared in ${relative(ROOT, domain.path)}.`,
            );
          }
          if (!allowed.includes(member.kind)) {
            throw new Error(
              `${relative(ROOT, path)}:${id.name} implements ${member.operation} with ${implementer}, but ${relative(ROOT, domain.path)} declares it as a ${member.kind}.`,
            );
          }
          register(member.kind, member.operation, {
            module: moduleSpecifier(path),
            exportName: id.name,
            member: memberName,
          });
        }
      }
    }
  }
  cachedHandlers = collected;
  return collected;
};

/**
 * The registry: every client-declared operation, with the kind its declaration
 * gave it. `defineOperationDomain` is now the ONLY source — the heuristic
 * call-site harvest that used to mint the subscription rows is gone, along with
 * the class of bug where a hand-written stream wrapper's operation string was
 * the registry entry.
 */
export const collectStartOperations = (): Map<string, Kind> => {
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
      declared.kind,
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
      .map(([operation, kind]) => {
        const entities = operation.startsWith("entity.")
          ? [
              "ingredient",
              "product",
              "recipe",
              "cookbook",
              "location",
              "inventory",
              "ledgerParty",
              "ledgerTransfer",
              "meal",
              "project",
              "task",
              "vendor",
              "purchase",
              "expense",
              "financialAccount",
              "financialTransaction",
              "wish",
              "usda-food",
              "image",
            ]
          : [];
        const phases =
          operation === "entity.detail"
            ? [
                "resolve",
                "base",
                "pricing",
                "quantity",
                "breadcrumbs",
                "quality",
                "recipe_usages",
                "food",
              ]
            : [];
        return `  ${JSON.stringify(operation)}: { kind: ${JSON.stringify(kind)}, entities: ${JSON.stringify(entities)}, productPhases: ${JSON.stringify(phases)} },`;
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
    `import type { StartOperationResult } from "~/server/start-operation.contract";\n` +
    `import type { StartOperationRequest } from "~/server/start-operation.server";\n` +
    `import type { WorkflowStreamHandler } from "~/server/subscription-domain.server";\n` +
    `\nexport type StartOperationHandler = (options: { data: unknown; request: StartOperationRequest }) => Promise<StartOperationResult<unknown>>;\n` +
    `export type StartOperationHandlerLoader = () => Promise<StartOperationHandler>;\n` +
    `export type WorkflowStreamHandlerLoader = () => Promise<WorkflowStreamHandler>;\n` +
    `\nexport const START_OPERATION_HANDLER_LOADERS = {\n${loaders(operations, "operations")}\n} as const satisfies Record<StartOperationIdOfKind<"query" | "mutation">, StartOperationHandlerLoader>;\n` +
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
