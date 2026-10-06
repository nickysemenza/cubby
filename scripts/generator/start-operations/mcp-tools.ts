import { pascalCase } from "../../../packages/shared/src/text-case.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { mcpOmission } from "../../../apps/web/src/contracts/define.ts";
import { kernelActionName } from "../../../apps/web/src/contracts/mcp-define.ts";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import {
  assertContractPurity,
  collectStartOperationHandlers,
  loadContracts,
  ROOT,
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
  kernel: kernelActionName,
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

const TODOS_PATH = "docs/todos.md";

/**
 * Every query and mutation is either an MCP tool action or declares why not
 * (`mcp` in `contracts/define.ts`), never both. An omission's reference must
 * hold: a kernel alternative names a verb some tool exposes, an agent twin is
 * itself an action, and a deferred capability names a docs/todos.md entry that
 * lists the operation. Subscriptions are not tool actions and are skipped.
 * Every violation is reported at once.
 */
export const assertMcpExposure = ({
  operations,
  exposedOperations,
  kernelActions,
  todos,
}: {
  operations: ReadonlyArray<{
    operation: string;
    kind: "query" | "mutation" | "subscription";
    mcp?: unknown;
  }>;
  exposedOperations: ReadonlySet<string>;
  kernelActions: ReadonlySet<string>;
  /** The text of docs/todos.md. */
  todos: string;
}): void => {
  const errors: string[] = [];
  for (const { operation, kind, mcp } of operations) {
    if (kind === "subscription") continue;
    const exposed = exposedOperations.has(operation);
    if (mcp === undefined) {
      if (!exposed)
        errors.push(
          `${operation} is not an MCP tool action and declares no \`mcp: { omit }\` reason. Add it to apps/web/src/contracts/mcp-tools.ts or declare why agents do without it (\`mcpOmission\` in contracts/define.ts).`,
        );
      continue;
    }
    const parsed = mcpOmission.safeParse(mcp);
    if (!parsed.success) {
      errors.push(
        `${operation} declares an invalid \`mcp\` omission: ${z.prettifyError(parsed.error)}`,
      );
      continue;
    }
    const omission = parsed.data;
    if (exposed) {
      errors.push(
        `${operation} is an MCP tool action but declares \`mcp: { omit: ${omission.omit} }\`; remove one.`,
      );
      continue;
    }
    if (omission.omit === "kernel_alternative")
      for (const verb of omission.kernel)
        if (!kernelActions.has(verb))
          errors.push(
            `${operation} names kernel action ${verb}, which no MCP tool exposes.`,
          );
    if (omission.omit === "agent_twin" && !exposedOperations.has(omission.twin))
      errors.push(
        `${operation} names agent twin ${omission.twin}, which is not an MCP tool action.`,
      );
    if (omission.omit === "deferred_capability") {
      const start = todos.indexOf(`**${omission.todo}.**`);
      if (start === -1) {
        errors.push(
          `${operation} defers to ${TODOS_PATH} entry **${omission.todo}.**, which does not exist.`,
        );
        continue;
      }
      // The entry runs to the next top-level bullet or heading.
      const rest = todos.slice(start);
      const end = rest.search(/\n(?:- |#)/u);
      const entry = end === -1 ? rest : rest.slice(0, end);
      if (!entry.includes(`\`${operation}\``))
        errors.push(
          `${TODOS_PATH} does not name \`${operation}\` in its **${omission.todo}.** entry.`,
        );
    }
  }
  if (errors.length > 0)
    throw new Error(
      `MCP exposure declarations are incomplete:\n- ${errors.join("\n- ")}`,
    );
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
  const declared: Parameters<
    typeof assertMcpExposure
  >[0]["operations"][number][] = [];
  for (const { contract } of await loadContracts())
    for (const [member, definition] of Object.entries(contract.ops)) {
      const operation = `${contract.domain}.${member}`;
      members.set(definition, { operation, kind: definition.kind });
      declared.push({ operation, kind: definition.kind, mcp: definition.mcp });
    }
  const { operations } = await collectStartOperationHandlers();

  const resolved = Object.entries(tools).map(([name, tool]) => {
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
  const actions = resolved.flatMap((tool) => tool.actions);
  assertMcpExposure({
    operations: declared,
    exposedOperations: new Set(
      actions.flatMap((action) =>
        "operation" in action ? [action.operation] : [],
      ),
    ),
    kernelActions: new Set(
      actions.flatMap((action) => ("kernel" in action ? [action.kernel] : [])),
    ),
    todos: readFileSync(join(ROOT, TODOS_PATH), "utf8"),
  });
  return resolved;
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
