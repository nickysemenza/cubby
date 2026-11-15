import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import {
  createCodemodeTool,
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

/** Pi owns validation, nested tasks and replay; this adapter limits its authority. */
export function readCodeTool(sandbox: CodemodeSandboxBase) {
  const tool = createCodemodeTool({ sandbox, models: false });
  return {
    ...tool,
    description: `Run JavaScript to compose read-only Mail import queries and filter intermediate results. Use top-level await and text(value) to return selected evidence. Only tools.mcp__cubby__entity_read and tools.mcp__cubby__purchase_import_read are available. Discover inputs with text(await describeTool("mcp__cubby__entity_read")); searchTools() and describeNamespace() are also async. Tool results are text: parse JSON when appropriate. Read attachment originals through the ordinary mcp__cubby__purchase_import_read tool to see their media. Writes, claims, escalation and settlement use their ordinary tools. No network, modules, bindings or model generation. store()/load() are cleared before each script; durable records are the only memory between Emails. Maximum 32 reads per execution attempt, 30 seconds per script, 32,000 source characters and 2000 selected-output tokens. An optional first line can lower these output and time limits: // @options: {"max_output_tokens":1000,"timeout_ms":10000}.`,
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
