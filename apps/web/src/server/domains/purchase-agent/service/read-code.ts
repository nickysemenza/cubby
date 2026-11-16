import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { wrapSection, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  createCodemodeExtension,
  CodemodeStoreDoc,
} from "@earendil-works/pi-durable/codemode";
import { z } from "zod";

import { codeReadableTool } from "./tool-protocol";

const codeInput = z.object({ code: z.string().min(1).max(32_000) });
const nestedCalls = z.object({
  calls: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      durationMs: z.number().optional(),
      error: z.string().optional(),
    }),
  ),
});

/** Pi owns discovery, prompt rendering and replay; wrappers narrow script authority. */
export function readCodeExtension(sandbox: CodemodeSandboxBase) {
  const extension = createCodemodeExtension({
    sandbox,
    models: false,
    inlineBudget: 800,
  });
  return {
    ...extension,
    name: "cubby.read-code",
    tools: extension.tools?.map(boundedReadCodeTool),
    wraps: [
      wrapSection("codemode", (section) => ({
        ...section,
        render: (input, context) =>
          section.render(
            {
              ...input,
              agent: {
                ...input.agent,
                callable: input.agent.callable.filter((tool) =>
                  codeReadableTool(tool.name),
                ),
              },
            },
            context,
          ),
      })),
    ],
  };
}

function boundedReadCodeTool(tool: ToolRegistration) {
  return {
    ...tool,
    description: `Compose authorized read-only tools with JavaScript; return selected evidence with text(value). Prefer ordinary bulk queries for simple batches. Use code for dependent reads or filtering intermediate results. Available signatures are in the codemode prompt section; await searchTools() or describeTool(name) for others. Tools return JSON text. No network, modules or models. Script memory resets per invocation. Limits: 32 reads, 30 seconds, 32,000 source characters, 2000 output tokens. Lower limits with // @options: {"max_output_tokens":1000,"timeout_ms":10000}. Read attachment media and perform writes through ordinary tools.`,
    execute: async (raw, api, context) => {
      const input = codeInput.parse(raw);
      const source = parseCodemodeSource(input.code);
      const options = {
        timeout_ms: Math.min(source.options.timeoutMs ?? 30_000, 30_000),
        max_output_tokens: Math.min(
          source.options.maxOutputTokens ?? 2000,
          2000,
        ),
      };
      // Pi's store is conversation-scoped. Reset it before every invocation,
      // including recovery, so one Email cannot seed a later script's memory.
      await api.commit(async (tx) => {
        const store = await tx.doc(CodemodeStoreDoc, api.conversationId);
        store.values = {};
      }, context);
      let calls = 0;
      const result = await tool.execute(
        { code: `// @options: ${JSON.stringify(options)}\n${source.code}` },
        {
          ...api,
          agent: async (ctx) => {
            const agent = await api.agent(ctx);
            return {
              ...agent,
              callable: agent.callable.filter((item) =>
                codeReadableTool(item.name),
              ),
            };
          },
          executeTool: (name, args, ctx, callOptions) => {
            const refusal = !codeReadableTool(name)
              ? `Code Mode cannot call ${name}`
              : ++calls > 32
                ? "Code Mode read limit reached"
                : undefined;
            if (refusal)
              return Promise.resolve({
                taskId: api.taskId,
                isError: true,
                diagnostics: [{ severity: "error" as const, message: refusal }],
              });
            return api.executeTool(name, args, ctx, callOptions);
          },
        },
        context,
      );
      // Nested results stay out of model context; their names and outcomes
      // remain inspectable in the ordinary Run transcript, even on failure.
      const details = nestedCalls.safeParse(result.details);
      return details.success
        ? {
            ...result,
            output: [
              ...(result.output ?? []),
              {
                type: "text" as const,
                text: JSON.stringify({
                  readCalls: details.data.calls.slice(0, 32),
                  omittedReadCalls: Math.max(0, details.data.calls.length - 32),
                }),
              },
            ],
          }
        : result;
    },
  } satisfies typeof tool;
}
