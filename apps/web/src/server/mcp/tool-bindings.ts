import * as contracts from "~/contracts";
import type { OperationContractMember } from "~/contracts/define";
import {
  mcpCapabilityAction,
  type McpActionOverride,
  type McpToolDeclaration,
} from "~/contracts/mcp-define";
import { MCP_ACTION_OVERRIDES, MCP_TOOLS } from "~/contracts/mcp-tools";
import type { OperationIdOfKind } from "~/lib/generated/operation-registry.gen";
import { MCP_TOOL_DATA } from "~/server/generated/mcp-tool-data.gen";
import { KERNEL_MCP_ACTIONS } from "~/server/mcp/kernel-actions";
import type { McpToolBindings } from "~/server/mcp/tools/tool-registration";

export { MCP_TOOL_DECLARATIONS } from "~/server/generated/mcp-tool-data.gen";

export type McpToolData = Readonly<
  Record<
    string,
    {
      readOnly: boolean;
      destructive: boolean;
      openWorld: boolean;
      actions: Readonly<
        Record<
          string,
          { kind: "query" | "mutation" } & (
            | { kernel: keyof typeof KERNEL_MCP_ACTIONS }
            | {
                operation: OperationIdOfKind<"query" | "mutation">;
                contract: keyof typeof contracts;
                member: string;
              }
          )
        >
      >;
    }
  >
>;
const data: McpToolData = MCP_TOOL_DATA;
const kernelTools: Readonly<Record<string, McpToolDeclaration>> = MCP_TOOLS;
const overrides: Readonly<Record<string, McpActionOverride>> =
  MCP_ACTION_OVERRIDES;

type BindingAction = McpToolBindings[string]["actions"][string];
const bindings: McpToolBindings = Object.fromEntries(
  Object.entries(data).map(([name, tool]) => [
    name,
    {
      ...tool,
      actions: Object.fromEntries(
        Object.entries(tool.actions).map(
          ([actionName, action]): [string, BindingAction] => {
            if ("kernel" in action) {
              const spec = kernelTools[name]?.actions[actionName];
              if (!spec)
                throw new Error(`No kernel spec for ${name}.${actionName}`);
              return [
                actionName,
                {
                  kind: action.kind,
                  spec,
                  kernel: KERNEL_MCP_ACTIONS[action.kernel],
                },
              ];
            }
            const members: Readonly<Record<string, OperationContractMember>> =
              contracts[action.contract].ops;
            const member = members[action.member];
            if (!member || member.kind === "subscription")
              throw new Error(`No MCP member for ${action.operation}`);
            return [
              actionName,
              {
                kind: action.kind,
                operation: action.operation,
                spec: mcpCapabilityAction(member, overrides[action.operation]),
              },
            ];
          },
        ),
      ),
    },
  ]),
);
// SAFETY: Object.fromEntries retains every generated tool key; the named action
// and binding contracts above check the runtime composition of each value.
export const MCP_TOOL_BINDINGS = bindings as {
  readonly [Tool in keyof typeof MCP_TOOL_DATA]: McpToolBindings[string];
};
