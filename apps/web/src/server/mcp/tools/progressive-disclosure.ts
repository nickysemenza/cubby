import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { safeToJsonSchema } from "~/server/mcp/tools/tool-json-schema";
import type {
  CompiledTool,
  ToolArguments,
  ToolExtra,
} from "~/server/mcp/tools/tool-registration";

const describeInputSchema = z.object({ actions: z.array(z.string()).min(1) });

export const describeToolOutputSchema = z.object({
  actions: z.array(
    z.object({
      action: z.string(),
      description: z.string(),
      inputSchema: z.json(),
      outputSchema: z.json(),
    }),
  ),
});

const shortName = (action: { name: string }) => action.name.split(".")[1]!;

/** Full schema details for requested actions in a generated capability tool. */
export function describeMcpActions(
  tool: Pick<CompiledTool, "actions" | "actionJson">,
  names: readonly string[],
  visible?: ReadonlySet<string>,
) {
  if (names.length === 0)
    throw new Error(
      "describe needs input.actions with at least one action name",
    );
  // A delegated agent may describe only the actions its Run mounts; hidden
  // actions are reported as unknown and left out of the available list.
  const shown = (key: string) => visible === undefined || visible.has(key);
  return {
    actions: names.map((name) => {
      const action = tool.actions.get(name);
      if (!action || !shown(action.name)) {
        const available = [...tool.actions.keys()]
          .filter(shown)
          .map((key) => key.split(".")[1]!)
          .join(", ");
        throw new Error(
          `Unknown action ${JSON.stringify(name)}. Available actions: ${available}.`,
        );
      }
      return {
        action: shortName(action),
        description: action.spec.description,
        inputSchema: tool.actionJson.get(shortName(action))!,
        outputSchema: safeToJsonSchema(action.output, "output"),
      };
    }),
  };
}

/** Adapt compact published calls to the unchanged action callback contract. */
export function withProgressiveDisclosure(
  callback: (
    params: ToolArguments,
    extra: ToolExtra,
  ) => Promise<CallToolResult>,
  tool: CompiledTool,
  visibleActions?: (
    extra: ToolExtra,
  ) => Promise<ReadonlySet<string> | undefined>,
) {
  return async (
    params: ToolArguments,
    extra: ToolExtra,
  ): Promise<CallToolResult> => {
    const action = z.object({ action: z.string() }).safeParse(params)
      .data?.action;
    if (action === "describe") {
      try {
        const input = describeInputSchema.parse(params.input);
        const output = describeToolOutputSchema.parse(
          describeMcpActions(
            tool,
            input.actions,
            await visibleActions?.(extra),
          ),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "describe needs input.actions with one or more available action names",
            },
          ],
          isError: true,
        };
      }
    }

    const nestedInput = z.looseObject({}).safeParse(params.input);
    const body = nestedInput.success
      ? nestedInput.data
      : (() => {
          const { action: _action, ...legacy } = params;
          return legacy;
        })();
    const runExecution = params._runExecution;
    return callback(
      {
        ...body,
        ...(runExecution === undefined ? {} : { _runExecution: runExecution }),
        action,
      },
      extra,
    );
  };
}
