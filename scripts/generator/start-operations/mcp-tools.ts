import { pascalCase } from "../../../packages/shared/src/text-case.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import {
  assertContractPurity,
  collectStartOperationHandlers,
  loadContracts,
  SOURCE_ROOT,
} from "./collect.ts";

type Kind = "query" | "mutation";

/** The runtime shape of `contracts/mcp-tools.ts`, as the generator reads it. */
type ActionSpec = {
  op: object;
  destructive?: true;
  openWorld?: true;
};
type ToolDeclaration = { actions: Record<string, ActionSpec> };

type ResolvedAction =
  | { name: string; kind: Kind; kernel: string }
  | {
      name: string;
      kind: Kind;
      operation: string;
      module: string;
      exportName: string;
      member: string;
    };

type ResolvedTool = {
  name: string;
  actions: ResolvedAction[];
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
};

const IDENTIFIER = /^[a-z][a-z0-9_]*$/u;
const ACTION_NAME = /^[a-z][A-Za-z0-9_]*$/u;

/** `kernelAction(verb, kind)` in `contracts/mcp-define.ts`. */
const kernelRef = z.object({
  kernel: z.string(),
  kind: z.enum(["query", "mutation"]),
});

/**
 * The one kind every action of a tool shares. MCP clients approve per tool,
 * so a single write action would make every read in a tool ask: a tool that
 * mixes queries and mutations fails generation.
 */
export const toolKind = (
  name: string,
  actions: ReadonlyArray<{ name: string; kind: Kind }>,
): Kind => {
  const [first] = actions;
  if (!first) throw new Error(`MCP tool ${name} declares no actions`);
  const byKind = (kind: Kind) =>
    actions
      .filter((action) => action.kind === kind)
      .map((action) => action.name)
      .join(", ");
  if (actions.some((action) => action.kind !== first.kind))
    throw new Error(
      `MCP tool ${name} mixes query actions (${byKind("query")}) and mutation actions (${byKind("mutation")}). A read-only tool must stay auto-approvable: move the actions into a tool of their own kind.`,
    );
  return first.kind;
};

/**
 * The declaration and its helpers load here, at generation time, with the
 * contracts: a runtime import of server code would drag the database layer
 * into the generator, so they are held to the contract import boundary.
 */
const MCP_DECLARATION_FILES = [
  "contracts/mcp-tools.ts",
  "contracts/mcp-define.ts",
  "contracts/mcp-projections.ts",
];

const loadMcpTools = async (): Promise<Record<string, ToolDeclaration>> => {
  for (const file of MCP_DECLARATION_FILES)
    assertContractPurity(join(SOURCE_ROOT, file));
  const module: { MCP_TOOLS?: Record<string, ToolDeclaration> } = await import(
    pathToFileURL(join(SOURCE_ROOT, "contracts/mcp-tools.ts")).href
  );
  if (!module.MCP_TOOLS)
    throw new Error(
      "apps/web/src/contracts/mcp-tools.ts must export MCP_TOOLS",
    );
  return module.MCP_TOOLS;
};

/**
 * Bind every declared action to the contract member it names (identity match
 * against the loaded contracts) and that member's `implementOperationDomain`
 * handler. Fails when a tool mixes queries and mutations: MCP clients approve
 * per tool, so one write action would make every read in the tool ask.
 */
const resolveMcpTools = async (): Promise<ResolvedTool[]> => {
  const tools = await loadMcpTools();
  const members = new Map<object, { operation: string; kind: string }>();
  for (const { contract } of await loadContracts())
    for (const [member, definition] of Object.entries(contract.ops))
      members.set(definition, {
        operation: `${contract.domain}.${member}`,
        kind: definition.kind,
      });
  const { operations } = await collectStartOperationHandlers();

  return Object.entries(tools).map(([name, tool]) => {
    if (!IDENTIFIER.test(name))
      throw new Error(`MCP tool name ${name} must be snake_case`);
    const actions = Object.entries(tool.actions).map(
      ([action, spec]): ResolvedAction => {
        if (!ACTION_NAME.test(action))
          throw new Error(`MCP action ${name}.${action} has an invalid name`);
        const kernel = kernelRef.safeParse(spec.op);
        if (kernel.success)
          return {
            name: action,
            kind: kernel.data.kind,
            kernel: kernel.data.kernel,
          };
        const member = members.get(spec.op);
        if (!member)
          throw new Error(
            `MCP action ${name}.${action} does not name a member of a contract exported from apps/web/src/contracts/index.ts`,
          );
        if (member.kind !== "query" && member.kind !== "mutation")
          throw new Error(
            `MCP action ${name}.${action} names ${member.operation}, a ${member.kind}; only queries and mutations can be tool actions`,
          );
        const handler = operations.get(member.operation);
        if (!handler)
          throw new Error(
            `MCP action ${name}.${action} names ${member.operation}, which has no implementOperationDomain handler`,
          );
        return {
          name: action,
          kind: member.kind,
          operation: member.operation,
          module: handler.module,
          exportName: handler.exportName,
          member: handler.member,
        };
      },
    );
    const specs = Object.values(tool.actions);
    return {
      name,
      actions,
      readOnly: toolKind(name, actions) === "query",
      destructive: specs.some((spec) => spec.destructive === true),
      openWorld: specs.some((spec) => spec.openWorld === true),
    };
  });
};

const property = (key: string) =>
  /^[A-Za-z_$][\w$]*$/u.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;

const renderServerBindings = (tools: ResolvedTool[]): string => {
  const imports = new Map<string, Set<string>>();
  for (const tool of tools)
    for (const action of tool.actions)
      if ("module" in action) {
        const names = imports.get(action.module) ?? new Set();
        names.add(action.exportName);
        imports.set(action.module, names);
      }
  const importLines = [...imports]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([module, names]) =>
        `import { ${[...names].sort().join(", ")} } from ${JSON.stringify(module)};`,
    );
  const body = tools
    .map((tool) => {
      const actions = tool.actions
        .map((action) => {
          const spec = `MCP_TOOLS${property(tool.name)}.actions${property(action.name)}`;
          const target =
            "kernel" in action
              ? `kernel: KERNEL_MCP_ACTIONS${property(action.kernel)}`
              : `operation: ${JSON.stringify(action.operation)}, run: ${action.exportName}.runs${property(action.member)}`;
          return `      ${JSON.stringify(action.name)}: { kind: ${JSON.stringify(action.kind)}, spec: ${spec}, ${target} },`;
        })
        .join("\n");
      return `  ${JSON.stringify(tool.name)}: {\n    readOnly: ${tool.readOnly},\n    destructive: ${tool.destructive},\n    openWorld: ${tool.openWorld},\n    actions: {\n${actions}\n    },\n  },`;
    })
    .join("\n");
  return (
    generatedHeader +
    `import { MCP_TOOLS } from "~/contracts/mcp-tools";\n` +
    `import { KERNEL_MCP_ACTIONS } from "~/server/mcp/kernel-actions";\n` +
    `import type { McpToolBindings } from "~/server/mcp/tools/tool-registration";\n` +
    `${importLines.join("\n")}\n\n` +
    `/** Every MCP tool with its actions bound to their handlers; read by \`registerMcpTools\`. */\n` +
    `export const MCP_TOOL_BINDINGS = {\n${body}\n} as const satisfies McpToolBindings;\n`
  );
};

const renderNames = (tools: ResolvedTool[]): string => {
  const table = tools
    .map(
      (tool) =>
        `  ${JSON.stringify(tool.name)}: [${tool.actions.map((action) => JSON.stringify(action.name)).join(", ")}],`,
    )
    .join("\n");
  const readOnly = tools
    .filter((tool) => tool.readOnly)
    .map((tool) => JSON.stringify(tool.name))
    .join(", ");
  const perTool = tools
    .map(
      (tool) =>
        `export type ${pascalCase(tool.name)}Action = CubbyMcpToolActionName<${JSON.stringify(tool.name)}>;`,
    )
    .join("\n");
  return (
    generatedHeader +
    `/** Every Cubby MCP tool and its actions, from \`apps/web/src/contracts/mcp-tools.ts\`. */\n` +
    `export const CUBBY_MCP_TOOL_ACTIONS = {\n${table}\n} as const;\n\n` +
    `/** Tools whose actions are all queries (MCP \`readOnlyHint\`). */\n` +
    `export const CUBBY_MCP_READ_ONLY_TOOLS = [${readOnly}] as const;\n\n` +
    `export type CubbyMcpToolName = keyof typeof CUBBY_MCP_TOOL_ACTIONS;\n` +
    `export type CubbyMcpToolActionName<Tool extends CubbyMcpToolName> =\n  (typeof CUBBY_MCP_TOOL_ACTIONS)[Tool][number];\n` +
    `/** \`\${tool}.\${action}\`: the unit the purchase agent is allowed and authorized by. */\n` +
    `export type CubbyMcpToolAction = {\n  [Tool in CubbyMcpToolName]: \`\${Tool}.\${CubbyMcpToolActionName<Tool>}\`;\n}[CubbyMcpToolName];\n` +
    `type CubbyMcpReadOnlyTool = (typeof CUBBY_MCP_READ_ONLY_TOOLS)[number];\n` +
    `/** Every write action — each needs a purchase-agent capability decision. */\n` +
    `export type CubbyMcpMutationAction = {\n  [Tool in Exclude<CubbyMcpToolName, CubbyMcpReadOnlyTool>]: \`\${Tool}.\${CubbyMcpToolActionName<Tool>}\`;\n}[Exclude<CubbyMcpToolName, CubbyMcpReadOnlyTool>];\n\n` +
    `${perTool}\n`
  );
};

/**
 * Stage 2b of `pnpm generate`: the MCP tool bindings (server) and the tool /
 * action name unions (`@cubby/schemas/mcp-tools`), both from
 * `contracts/mcp-tools.ts`.
 */
export const renderMcpToolArtifacts = async (): Promise<EntityArtifacts[]> => {
  const tools = await resolveMcpTools();
  return [
    {
      relativePath: "apps/web/src/server/generated/mcp-tools.gen.ts",
      source: renderServerBindings(tools),
    },
    {
      relativePath: "packages/schemas/src/generated/mcp-tool-names.gen.ts",
      source: renderNames(tools),
    },
  ];
};
