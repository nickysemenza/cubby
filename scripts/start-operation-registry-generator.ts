import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { parseSync } from "oxc-parser";

const ROOT = new URL("..", import.meta.url).pathname;
const SOURCE_ROOT = join(ROOT, "apps/web/src");
const OUTPUT = join(
  SOURCE_ROOT,
  "lib/generated/start-operation-registry.gen.ts",
);
const HANDLER_OUTPUT = join(
  SOURCE_ROOT,
  "server/generated/start-operation-handlers.gen.ts",
);

type Kind = "query" | "mutation" | "subscription";
type Definition = { kind: Kind; entities: Set<string> };
type HandlerDefinition = {
  kind?: Exclude<Kind, "subscription">;
  module: string;
  exportName: string;
};
type AstNode = { type: string; [key: string]: unknown };

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[jt]sx?$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name)
      ? [path]
      : [];
  });

const propertyString = (
  object: AstNode,
  name: string,
): string | undefined => {
  const properties = Array.isArray(object.properties)
    ? (object.properties as AstNode[])
    : [];
  const property = properties.find((candidate) => {
    if (candidate.type !== "Property") return false;
    const key = candidate.key as AstNode | undefined;
    return key?.name === name || key?.value === name;
  });
  const value = property?.value as AstNode | undefined;
  return value?.type === "Literal" && typeof value.value === "string"
    ? value.value
    : undefined;
};

const calledName = (expression: AstNode): string | undefined =>
  expression.type === "Identifier"
    ? (expression.name as string | undefined)
    : expression.type === "MemberExpression"
      ? ((expression.property as AstNode | undefined)?.name as
          | string
          | undefined)
      : undefined;

const OBJECT_CALLS = new Set([
  "runStartOperation",
  "startOperation",
  "operation",
  "workflowStreamResponse",
  "openWorkflowStream",
]);
const QUERY_CALLS = new Set(["defineQuery", "noInputOperation"]);
const MUTATION_CALLS = new Set(["defineMutation"]);

const walk = (node: AstNode, visit: (node: AstNode) => void): void => {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          walk(child as AstNode, visit);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      walk(value as AstNode, visit);
    }
  }
};

const serverHandlerSource = (path: string): boolean =>
  path.endsWith("-browser.server.ts") ||
  path.endsWith("/server/entity-runtime.server.ts");

const moduleSpecifier = (path: string): string =>
  `~/${relative(SOURCE_ROOT, path)
    .replaceAll("\\", "/")
    .replace(/\.[cm]?[jt]sx?$/u, "")}`;

/**
 * Browser projections already declare the authoritative operation id inside
 * each exported handler. Compile those declarations into lazy adapters rather
 * than maintaining a second handwritten dispatcher registry.
 */
export const collectStartOperationHandlers = (): Map<
  string,
  HandlerDefinition
> => {
  const handlers = new Map<string, HandlerDefinition>();
  for (const path of sourceFiles(SOURCE_ROOT).filter(serverHandlerSource)) {
    const program = parseSync(path, readFileSync(path, "utf8"), {
      lang: path.endsWith("x") ? "tsx" : "ts",
    }).program as unknown as AstNode;
    const body = Array.isArray(program.body) ? (program.body as AstNode[]) : [];
    for (const statement of body) {
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? (statement.declaration as AstNode | undefined)
          : undefined;
      if (!declaration) continue;

      const exports: { exportName: string; implementation: AstNode }[] = [];
      if (declaration.type === "VariableDeclaration") {
        const declarations = Array.isArray(declaration.declarations)
          ? (declaration.declarations as AstNode[])
          : [];
        for (const variable of declarations) {
          const id = variable.id as AstNode | undefined;
          const implementation = variable.init as AstNode | undefined;
          if (typeof id?.name === "string" && implementation) {
            exports.push({ exportName: id.name, implementation });
          }
        }
      } else if (declaration.type === "FunctionDeclaration") {
        const id = declaration.id as AstNode | undefined;
        if (typeof id?.name === "string") {
          exports.push({ exportName: id.name, implementation: declaration });
        }
      }

      for (const candidate of exports) {
        const operationIds = new Set<string>();
        const kinds = new Set<Exclude<Kind, "subscription">>();
        walk(candidate.implementation, (node) => {
          if (node.type !== "Property") return;
          const key = node.key as AstNode | undefined;
          const value = node.value as AstNode | undefined;
          const keyName = key?.name ?? key?.value;
          if (
            (keyName === "operation" || keyName === "name") &&
            value?.type === "Literal" &&
            typeof value.value === "string" &&
            value.value.includes(".")
          ) {
            operationIds.add(value.value);
          }
          if (
            keyName === "type" &&
            value?.type === "Literal" &&
            (value.value === "query" || value.value === "mutation")
          ) {
            kinds.add(value.value);
          }
        });
        if (operationIds.size === 0) continue;
        if (operationIds.size !== 1 || kinds.size > 1) {
          throw new Error(
            `Unable to compile browser operation ${relative(ROOT, path)}:${candidate.exportName}`,
          );
        }
        const operation = [...operationIds][0];
        if (!operation) continue;
        const definition = {
          kind: [...kinds][0],
          module: moduleSpecifier(path),
          exportName: candidate.exportName,
        } satisfies HandlerDefinition;
        const existing = handlers.get(operation);
        if (existing) {
          throw new Error(
            `Duplicate browser operation ${operation}: ${existing.module}.${existing.exportName} and ${definition.module}.${definition.exportName}`,
          );
        }
        handlers.set(operation, definition);
      }
    }
  }
  return handlers;
};

export const collectStartOperations = (): Map<string, Definition> => {
  const operations = new Map<string, Definition>();
  const add = (
    operation: string,
    kind: Kind,
    path: string,
    entity?: string,
  ) => {
    const definition = operations.get(operation) ?? {
      kind,
      entities: new Set<string>(),
    };
    if (definition.kind !== kind) {
      throw new Error(
        `${operation} has conflicting Start kinds (${definition.kind} and ${kind}) in ${relative(ROOT, path)}`,
      );
    }
    if (entity) definition.entities.add(entity);
    operations.set(operation, definition);
  };

  for (const path of sourceFiles(SOURCE_ROOT)) {
    const source = parseSync(
      path,
      readFileSync(path, "utf8"),
      { lang: path.endsWith("x") ? "tsx" : "ts" },
    ).program as unknown as AstNode;
    walk(source, (node) => {
      if (node.type === "CallExpression") {
        const name = calledName(node.callee as AstNode);
        const args = node.arguments as AstNode[];
        const first = args[0];
        if (
          name === "defineOperationDomain" &&
          first?.type === "Literal" &&
          typeof first.value === "string" &&
          args[1]?.type === "ObjectExpression"
        ) {
          const definitions = Array.isArray(args[1].properties)
            ? (args[1].properties as AstNode[])
            : [];
          for (const property of definitions) {
            if (property.type !== "Property") continue;
            const key = property.key as AstNode | undefined;
            const value = property.value as AstNode | undefined;
            if (value?.type !== "CallExpression") continue;
            const operationName = key?.name ?? key?.value;
            const definitionKind = calledName(value.callee as AstNode);
            if (
              typeof operationName === "string" &&
              (definitionKind === "query" || definitionKind === "mutation")
            ) {
              add(
                `${first.value}.${operationName}`,
                definitionKind,
                path,
              );
            }
          }
          return;
        }
        if (name && OBJECT_CALLS.has(name) && first?.type === "ObjectExpression") {
          const operation = propertyString(first, "operation");
          if (operation) {
            const kind =
              name === "workflowStreamResponse" || name === "openWorkflowStream"
                ? "subscription"
                : ((propertyString(first, "type") ??
                    propertyString(first, "kind") ??
                    "query") as Kind);
            add(operation, kind, path, propertyString(first, "entity"));
          }
        } else if (
          name &&
          first?.type === "Literal" &&
          typeof first.value === "string" &&
          (QUERY_CALLS.has(name) ||
            MUTATION_CALLS.has(name) ||
            ((name === "defineOperation" || name === "operation") &&
              first.value.includes(".")))
        ) {
          const declaredKind = args.find(
            (argument) =>
              argument.type === "Literal" &&
              (argument.value === "query" || argument.value === "mutation"),
          );
          add(
            first.value,
            MUTATION_CALLS.has(name) || declaredKind?.value === "mutation"
              ? "mutation"
              : "query",
            path,
          );
        }
      }
    });
  }
  for (const [operation, handler] of collectStartOperationHandlers()) {
    const declared = operations.get(operation);
    if (declared && handler.kind && declared.kind !== handler.kind) {
      throw new Error(
        `${operation} is declared as ${declared.kind} but its server handler is ${handler.kind}`,
      );
    }
    if (!declared) {
      add(
        operation,
        handler.kind ?? "query",
        join(SOURCE_ROOT, handler.module.slice(2)),
      );
    }
  }
  return operations;
};

export const renderStartOperationRegistry = (): string => {
  const operations = [...collectStartOperations()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `/** Generated by scripts/start-operation-registry-generator.ts. */\n` +
    `export const START_OPERATIONS = {\n${operations
      .map(
        ([operation, definition]) => {
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
            : [...definition.entities].sort();
          const phases = operation === "entity.detail"
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
          return `  ${JSON.stringify(operation)}: { kind: ${JSON.stringify(definition.kind)}, entities: ${JSON.stringify(entities)}, productPhases: ${JSON.stringify(phases)} },`;
        },
      )
      .join("\n")}\n} as const;\n\n` +
    `export type StartOperationId = keyof typeof START_OPERATIONS;\n` +
    `export type RegisteredStartOperationKind<Id extends StartOperationId> =\n` +
    `  (typeof START_OPERATIONS)[Id]["kind"];\n` +
    `export type StartOperationIdOfKind<Kind extends "query" | "mutation" | "subscription"> = {\n` +
    `  [Id in StartOperationId]: RegisteredStartOperationKind<Id> extends Kind ? Id : never;\n` +
    `}[StartOperationId];\n`;
};

export const renderStartOperationHandlers = (): string => {
  const handlers = [...collectStartOperationHandlers()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    `/** Generated by scripts/start-operation-registry-generator.ts. */\n` +
    `import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";\n` +
    `import type { StartOperationResult } from "~/server/start-operation.contract";\n` +
    `import type { StartOperationRequest } from "~/server/start-operation.server";\n` +
    `\nexport type StartOperationHandler = (options: { data: unknown; request: StartOperationRequest }) => Promise<StartOperationResult<unknown>>;\n` +
    `export type StartOperationHandlerLoader = () => Promise<StartOperationHandler>;\n` +
    `\nexport const START_OPERATION_HANDLER_LOADERS = {\n${handlers
      .map(
        ([operation, handler]) =>
          `  ${JSON.stringify(operation)}: async () => { const module = await import(${JSON.stringify(handler.module)}); return module.${handler.exportName} as unknown as StartOperationHandler; },`,
      )
      .join("\n")}\n} as const satisfies Record<StartOperationIdOfKind<"query" | "mutation">, StartOperationHandlerLoader>;\n`
  );
};

const format = (path: string, source: string): string => {
  const formatted = spawnSync(
    "pnpm",
    ["exec", "biome", "format", "--stdin-file-path", path],
    { input: source, encoding: "utf8" },
  );
  if (formatted.status !== 0) {
    throw new Error(formatted.stderr || `Unable to format ${relative(ROOT, path)}`);
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
