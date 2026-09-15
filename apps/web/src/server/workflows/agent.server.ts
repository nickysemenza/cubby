import type { AgentAskInput, AgentStreamEvent } from "@cubby/schemas/agent";

import { createAgentToolset } from "~/server/agent/mcp-bridge";
import {
  collectAgentAnswer,
  extractSources,
  streamAgentChat,
} from "~/server/agent/runtime";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import {
  bindWorkflow,
  WorkflowCancelledError,
  workflow,
} from "~/server/workflow-runtime";

type AgentContext = AuthenticatedStartOperationContext;
type AgentToolset = Awaited<ReturnType<typeof createAgentToolset>>;
export type AgentStreamDependencies = {
  acquire: typeof createAgentToolset;
  stream: typeof streamAgentChat;
};

const productionAgentStreamDependencies: AgentStreamDependencies = {
  acquire: createAgentToolset,
  stream: streamAgentChat,
};

export async function* askAgentStreamWorkflow(
  context: AgentContext,
  input: AgentAskInput,
  signal?: AbortSignal,
  dependencies: AgentStreamDependencies = productionAgentStreamDependencies,
): AsyncGenerator<AgentStreamEvent> {
  const abort = signal ?? new AbortController().signal;
  const checkCancelled = () => {
    if (abort.aborted)
      throw new WorkflowCancelledError({
        committed: false,
        effectsPending: false,
      });
  };
  checkCancelled();
  const resource: AgentToolset = await dependencies.acquire(context);
  try {
    checkCancelled();
    for await (const event of dependencies.stream(
      context.db,
      input.query,
      resource,
      abort,
    )) {
      checkCancelled();
      if (event.type === "TEXT_MESSAGE_CONTENT")
        yield { type: "delta", text: event.delta ?? "" };
      else if (event.type === "TOOL_CALL_START")
        yield { type: "tool", tool: event.toolCallName ?? "" };
    }
    checkCancelled();
    yield {
      type: "done",
      sources: extractSources(resource.records),
      toolCalls: resource.records.map((record) => ({
        tool: record.tool,
        args: record.args,
        durationMs: record.durationMs,
        ok: record.ok,
      })),
    };
  } finally {
    await resource.close();
  }
}

export const askAgentWorkflow = bindWorkflow(
  workflow<AgentContext, AgentAskInput>("agent.ask")
    .call("answer", async ({ context, signal }, { input }) =>
      collectAgentAnswer(askAgentStreamWorkflow(context, input, signal)),
    )
    .output(({ answer }) => answer),
  (context: AgentContext, input: AgentAskInput) => ({ context, input }),
);
