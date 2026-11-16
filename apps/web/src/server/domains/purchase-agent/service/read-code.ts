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
    // Ordinary schemas already describe visible tools; discover deferred reads
    // inside the script rather than copying their declarations into the prompt.
    inlineBudget: 0,
  });
  return {
    ...extension,
    name: "cubby.read-code",
    tools: extension.tools?.map(boundedReadCodeTool),
    wraps: [
      wrapSection("codemode", (section) => ({
        ...section,
        render: (input, context) =>
          !input.agent.tools.some((tool) => tool.name === "codemode")
            ? undefined
            : section.render(
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
    deferred: true,
    description: `Compose read-only tools with top-level await and text(value). Exact script names: tools.mcp__cubby__entity_read and tools.mcp__cubby__purchase_import_read. Prefer ordinary bulk queries for simple batches; load entity_read with tool_search. Use code for dependent reads or filtering results, and return only needed evidence, never full candidate records. Ordinary tool schemas apply; discover others with await describeTool(name). Tools return JSON text. No network, modules or models. Memory resets per invocation. Limits: 32 reads, 30 seconds, 32,000 source characters, 2000 output tokens. Lower limits with // @options: {"max_output_tokens":1000,"timeout_ms":10000}. Use ordinary tools for attachment media, writes and recovery after a script error.`,
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
      // Pi retains detailed call records outside the model-visible content.
      // The Run projection exposes them; the model only needs counts and errors.
      const details = nestedCalls.safeParse(result.details);
      return details.success
        ? {
            ...result,
            output: [
              ...(result.output ?? []),
              {
                type: "text" as const,
                text: JSON.stringify({
                  readCalls: {
                    ok: details.data.calls.filter(
                      (call) => call.status === "ok",
                    ).length,
                    failed: details.data.calls.filter(
                      (call) => call.status !== "ok",
                    ).length,
                  },
                  failures: details.data.calls
                    .filter((call) => call.status !== "ok")
                    .slice(0, 8),
                }),
              },
            ],
          }
        : result;
    },
  } satisfies typeof tool;
}
