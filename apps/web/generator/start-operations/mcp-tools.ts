import { pascalCase } from "@cubby/shared/text-case";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  kernelActionName,
  type McpActionOverride,
} from "../../src/contracts/mcp-define.ts";
import { tsModule } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import {
  assertContractPurity,
  collectStartOperationHandlers,
  loadContracts,
  SOURCE_ROOT,
} from "./collect.ts";

type Kind = "query" | "mutation";

/** Kernel tool declarations remain hand-written; operation actions are generated. */
type ActionSpec = { op: object; destructive?: true; openWorld?: true };
type ToolDeclaration = { actions: Record<string, ActionSpec> };
type ActionOverride = McpActionOverride;

type ResolvedAction =
  | {
      name: string;
      kind: Kind;
      kernel: string;
      destructive?: boolean;
      openWorld?: boolean;
    }
  | {
      name: string;
      kind: Kind;
      operation: string;
      contractModule: string;
      contractExportName: string;
      contractMember: string;
      destructive?: boolean;
      openWorld?: boolean;
    };

type OperationAction = Extract<ResolvedAction, { operation: string }>;

type ResolvedTool = {
  name: string;
  description: string;
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

/**
 * A contract group holding both kinds splits into `<base>_read` for its reads
 * and the group (or `<base>` when the group is itself `<base>_read`) for its
 * writes, so every read tool stays auto-approvable without a per-member
 * declaration.
 */
export const splitByKind = (
  group: string,
  actions: ReadonlyMap<string, { kind: Kind }>,
): ReadonlyMap<string, Kind | null> => {
  const kinds = new Set([...actions.values()].map((action) => action.kind));
  if (kinds.size < 2) return new Map([[group, null]]);
  const base = group.replace(/_(read|write)$/u, "");
  return new Map<string, Kind | null>([
    [`${base}_read`, "query"],
    [group.endsWith("_read") ? base : group, "mutation"],
  ]);
};

/** Every query and mutation resolves to an exposure kind; capabilities need agent-facing copy. */
export const assertMcpExposure = ({
  operations,
}: {
  operations: ReadonlyArray<{
    operation: string;
    kind: "query" | "mutation" | "subscription";
    exposure?: string;
    description?: string;
  }>;
}): void => {
  const errors: string[] = [];
  for (const { operation, kind, exposure, description } of operations) {
    if (kind === "subscription") continue;
    if (
      exposure !== "capability" &&
      exposure !== "view" &&
      exposure !== "internal"
    ) {
      errors.push(
        `${operation} must declare an exposure kind (capability, view, or internal).`,
      );
      continue;
    }
    if (exposure === "capability" && !description?.trim())
      errors.push(
        `${operation} is a capability but has no agent-facing description.`,
      );
  }
  if (errors.length > 0)
    throw new Error(
      `Operation exposure declarations are incomplete:\n- ${errors.join("\n- ")}`,
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

const loadMcpTools = async (): Promise<{
  tools: Record<string, ToolDeclaration>;
  overrides: Record<string, ActionOverride>;
  descriptions: Record<string, { description: string }>;
}> => {
  for (const file of MCP_DECLARATION_FILES)
    assertContractPurity(join(SOURCE_ROOT, file));
  const module: {
    MCP_TOOLS?: Record<string, ToolDeclaration>;
    MCP_ACTION_OVERRIDES?: Record<string, ActionOverride>;
    MCP_TOOL_DESCRIPTIONS?: Record<string, { description: string }>;
  } = await import(
    pathToFileURL(join(SOURCE_ROOT, "contracts/mcp-tools.ts")).href
  );
  if (
    !module.MCP_TOOLS ||
    !module.MCP_ACTION_OVERRIDES ||
    !module.MCP_TOOL_DESCRIPTIONS
  )
    throw new Error(
      "apps/web/src/contracts/mcp-tools.ts must export MCP_TOOLS, MCP_ACTION_OVERRIDES, and MCP_TOOL_DESCRIPTIONS",
    );
  return {
    tools: module.MCP_TOOLS,
    overrides: module.MCP_ACTION_OVERRIDES,
    descriptions: module.MCP_TOOL_DESCRIPTIONS,
  };
};

const snakeCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1_$2")
    .toLowerCase();

/** Bind capability members and retained entity-kernel verbs into grouped tools. */
const resolveMcpTools = async (): Promise<ResolvedTool[]> => {
  const { tools: kernelTools, overrides, descriptions } = await loadMcpTools();
  const contracts = await loadContracts();
  const declared: Parameters<
    typeof assertMcpExposure
  >[0]["operations"][number][] = [];
  const operationNames = new Set<string>();
  const groups = new Map<string, Map<string, OperationAction>>();

  for (const { exportName, module, contract } of contracts) {
    for (const [member, definition] of Object.entries(contract.ops)) {
      const operation = `${contract.domain}.${member}`;
      const exposure = definition.exposure ?? contract.exposure;
      declared.push({
        operation,
        kind: definition.kind,
        exposure,
        description: definition.description,
      });
      if (definition.kind === "subscription" || exposure !== "capability")
        continue;
      const name = snakeCase(member);
      const tool = contract.mcpToolGroup ?? snakeCase(contract.domain);
      if (!IDENTIFIER.test(tool))
        throw new Error(
          `${exportName} declares invalid MCP tool group ${JSON.stringify(tool)}`,
        );
      if (!ACTION_NAME.test(name))
        throw new Error(
          `MCP action ${operation} has an invalid generated name ${JSON.stringify(name)}`,
        );
      const actions = groups.get(tool) ?? new Map<string, OperationAction>();
      if (actions.has(name))
        throw new Error(
          `MCP tool ${tool} has duplicate action ${name}; choose a different contract member name or mcpToolGroup.`,
        );
      actions.set(name, {
        name,
        kind: definition.kind,
        operation,
        contractModule: module,
        contractExportName: exportName,
        contractMember: member,
        destructive: definition.destructive === true,
        openWorld: definition.openWorld === true,
      });
      groups.set(tool, actions);
      operationNames.add(operation);
    }
  }
  assertMcpExposure({ operations: declared });

  const unknownOverrides = Object.keys(overrides).filter(
    (operation) => !operationNames.has(operation),
  );
  if (unknownOverrides.length > 0)
    throw new Error(
      `MCP overrides name operations that are not capabilities: ${unknownOverrides.join(", ")}`,
    );

  const { operations } = await collectStartOperationHandlers();
  const split = new Map<string, OperationAction[]>();
  /** A split tool's contract group and its sibling, for the inherited description. */
  const splitFrom = new Map<string, { group: string; sibling: string }>();
  for (const [group, groupedActions] of groups) {
    const tools = splitByKind(group, groupedActions);
    const names = [...tools.keys()];
    for (const [tool, kind] of tools) {
      if (split.has(tool))
        throw new Error(
          `MCP tool ${tool} is produced by two contract groups; rename one mcpToolGroup.`,
        );
      split.set(
        tool,
        [...groupedActions.values()].filter(
          (action) => kind === null || action.kind === kind,
        ),
      );
      if (kind !== null)
        splitFrom.set(tool, {
          group,
          sibling: names.find((name) => name !== tool)!,
        });
    }
  }
  const resolved: ResolvedTool[] = [];
  const missingDescriptions: string[] = [];
  for (const [name, groupedActions] of split) {
    const actions: ResolvedAction[] = [];
    for (const action of groupedActions) {
      if (!operations.has(action.operation))
        throw new Error(
          `MCP action ${name}.${action.name} names ${action.operation}, which has no implementOperationDomain handler`,
        );
      actions.push(action);
    }
    for (const [actionName, spec] of Object.entries(
      kernelTools[name]?.actions ?? {},
    )) {
      const kernel = kernelRef.safeParse(spec.op);
      if (!kernel.success)
        throw new Error(
          `MCP_TOOLS.${name}.${actionName} must declare a kernel action`,
        );
      if (actions.some((action) => action.name === actionName))
        throw new Error(`MCP tool ${name} has duplicate action ${actionName}`);
      actions.push({
        name: actionName,
        kind: kernel.data.kind,
        kernel: kernel.data.kernel,
        destructive: spec.destructive,
        openWorld: spec.openWorld,
      });
    }
    const origin = splitFrom.get(name);
    const own = descriptions[name]?.description?.trim();
    const inherited = origin && descriptions[origin.group]?.description?.trim();
    const description =
      own ??
      (inherited &&
        `${inherited} ${toolKind(name, actions) === "query" ? "Reads" : "Writes"} only; the ${toolKind(name, actions) === "query" ? "writes" : "reads"} are on \`${origin.sibling}\`.`);
    if (!description) missingDescriptions.push(name);
    resolved.push({
      name,
      description: description ?? "",
      actions: actions.sort((a, b) => a.name.localeCompare(b.name)),
      readOnly: toolKind(name, actions) === "query",
      destructive: actions.some((action) => action.destructive === true),
      openWorld: actions.some((action) => action.openWorld === true),
    });
  }

  if (missingDescriptions.length > 0)
    throw new Error(
      `MCP tools have no description in MCP_TOOL_DESCRIPTIONS: ${missingDescriptions.join(", ")}`,
    );
  for (const [name, tool] of Object.entries(kernelTools)) {
    if (split.has(name)) continue;
    if (!IDENTIFIER.test(name))
      throw new Error(`MCP tool name ${name} must be snake_case`);
    const actions = Object.entries(tool.actions).map(
      ([actionName, spec]): ResolvedAction => {
        const kernel = kernelRef.safeParse(spec.op);
        if (!kernel.success)
          throw new Error(
            `MCP_TOOLS.${name}.${actionName} must declare a kernel action`,
          );
        return {
          name: actionName,
          kind: kernel.data.kind,
          kernel: kernel.data.kernel,
          destructive: spec.destructive,
          openWorld: spec.openWorld,
        };
      },
    );
    const description = descriptions[name]?.description?.trim();
    if (!description)
      throw new Error(
        `MCP tool ${name} has no description in MCP_TOOL_DESCRIPTIONS`,
      );
    resolved.push({
      name,
      description,
      actions,
      readOnly: toolKind(name, actions) === "query",
      destructive: actions.some((action) => action.destructive === true),
      openWorld: actions.some((action) => action.openWorld === true),
    });
  }
  return resolved.sort((a, b) => a.name.localeCompare(b.name));
};

const renderServerBindings = (tools: ResolvedTool[]): string =>
  tsModule({
    imports: [
      {
        from: "~/server/mcp/tool-bindings",
        names: ["McpToolData"],
        typeOnly: true,
      },
    ],
    consts: [
      {
        name: "MCP_TOOL_DATA",
        satisfies: "McpToolData",
        value: Object.fromEntries(
          tools.map((tool) => [
            tool.name,
            {
              readOnly: tool.readOnly,
              destructive: tool.destructive,
              openWorld: tool.openWorld,
              actions: Object.fromEntries(
                tool.actions.map((action) => [
                  action.name,
                  "kernel" in action
                    ? { kind: action.kind, kernel: action.kernel }
                    : {
                        kind: action.kind,
                        operation: action.operation,
                        contract: action.contractExportName,
                        member: action.contractMember,
                      },
                ]),
              ),
            },
          ]),
        ),
      },
      {
        name: "MCP_TOOL_DECLARATIONS",
        value: Object.fromEntries(
          tools.map((tool) => [tool.name, { description: tool.description }]),
        ),
      },
    ],
  });

const renderNames = (tools: ResolvedTool[]): string =>
  tsModule({
    imports: [
      {
        from: "../mcp-tool-name-types",
        typeOnly: true,
        names: ["ToolName", "ToolActionName", "ToolAction", "TupleMember"],
      },
    ],
    consts: [
      {
        name: "CUBBY_MCP_TOOL_ACTIONS",
        value: Object.fromEntries(
          tools.map((tool) => [
            tool.name,
            tool.actions.map((action) => action.name),
          ]),
        ),
      },
      {
        name: "CUBBY_MCP_READ_ONLY_TOOLS",
        value: tools.filter((tool) => tool.readOnly).map((tool) => tool.name),
      },
      {
        name: "CUBBY_MCP_MUTATION_ACTIONS",
        value: tools.flatMap((tool) =>
          tool.actions
            .filter((action) => action.kind === "mutation")
            .map((action) => `${tool.name}.${action.name}`),
        ),
      },
    ],
    types: [
      {
        name: "CubbyMcpToolName",
        target: "ToolName<typeof CUBBY_MCP_TOOL_ACTIONS>",
      },
      {
        name: "CubbyMcpToolActionName<Tool extends CubbyMcpToolName>",
        target: "ToolActionName<typeof CUBBY_MCP_TOOL_ACTIONS, Tool>",
      },
      {
        name: "CubbyMcpToolAction",
        target: "ToolAction<typeof CUBBY_MCP_TOOL_ACTIONS>",
      },
      {
        name: "CubbyMcpMutationAction",
        target: "TupleMember<typeof CUBBY_MCP_MUTATION_ACTIONS>",
      },
      ...tools.map((tool) => ({
        name: `${pascalCase(tool.name)}Action`,
        target: `CubbyMcpToolActionName<${JSON.stringify(tool.name)}>`,
      })),
    ],
  });

/**
 * Stage 2b of `pnpm generate`: the MCP tool bindings (server) and the tool /
 * action name unions (`@cubby/schemas/mcp-tools`), both from
 * `contracts/mcp-tools.ts`.
 */
export const renderMcpToolArtifacts = async (): Promise<EntityArtifacts[]> => {
  const tools = await resolveMcpTools();
  return [
    {
      relativePath: "apps/web/src/server/generated/mcp-tool-data.gen.ts",
      source: renderServerBindings(tools),
    },
    {
      relativePath: "apps/web/src/server/generated/mcp-tools.gen.ts",
      source: tsModule({
        exports: [
          {
            from: "~/server/mcp/tool-bindings",
            names: ["MCP_TOOL_BINDINGS", "MCP_TOOL_DECLARATIONS"],
          },
        ],
      }),
    },
    {
      relativePath: "packages/schemas/src/generated/mcp-tool-names.gen.ts",
      source: renderNames(tools),
    },
  ];
};
