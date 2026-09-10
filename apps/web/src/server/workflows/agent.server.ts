import type { AgentAskInput, AgentStreamEvent } from "@cubby/schemas/agent";

import { createAgentToolset } from "~/server/agent/mcp-bridge";
import {
  collectAgentAnswer,
  extractSources,
  streamAgentChat,
} from "~/server/agent/runtime";
import { createMcpWorkflowCaller } from "~/server/mcp/workflow-caller";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";
import {
  bindEventStream,
  defineEventStream,
} from "~/server/workflow-runtime/event-stream";

const createAgentCaller = (context: AuthenticatedStartOperationContext) =>
  createMcpWorkflowCaller({
    ...context,
    readDb: context.db,
    readConsistency: {
      consistency: "strong" as const,
      reason: "non-browser-origin" as const,
    },
  });

type AgentContext = AuthenticatedStartOperationContext;
type AgentResource = Awaited<ReturnType<typeof createAgentToolset>>;
type AgentEvent =
  ReturnType<typeof streamAgentChat> extends AsyncGenerator<infer Event>
    ? Event
    : never;
type AgentResourceInput = { input: AgentAskInput; resource: AgentResource };

export const askAgentStreamWorkflow = bindEventStream(
  defineEventStream({
    name: "agent.askStream",
    acquire: workflow<AgentContext, AgentAskInput>("agent.askStream.acquire")
      .call("readOnlyTools", async ({ context }) =>
        createAgentToolset(
          createAgentCaller(context),
          context.db,
          context.actorContext.userId,
        ),
      )
      .output(({ readOnlyTools }) => readOnlyTools),
    source: workflow<AgentContext, AgentResourceInput>("agent.askStream.source")
      .call("provider", async ({ context, signal }, { input }) =>
        streamAgentChat(context.db, input.input.query, input.resource, signal),
      )
      .output(({ provider }) => provider),
    event: workflow<AgentContext, AgentResourceInput & { event: AgentEvent }>(
      "agent.askStream.event",
    )
      .call(
        "publicEvent",
        async (_, { input }): Promise<AgentStreamEvent[]> => {
          if (input.event.type === "TEXT_MESSAGE_CONTENT")
            return [{ type: "delta", text: input.event.delta ?? "" }];
          if (input.event.type === "TOOL_CALL_START")
            return [{ type: "tool", tool: input.event.toolCallName ?? "" }];
          return [];
        },
      )
      .output(({ publicEvent }) => publicEvent),
    complete: workflow<AgentContext, AgentResourceInput>(
      "agent.askStream.complete",
    )
      .call("citations", async (_, { input }): Promise<AgentStreamEvent[]> => [
        {
          type: "done",
          sources: extractSources(input.resource.records),
          toolCalls: input.resource.records.map((record) => ({
            tool: record.tool,
            args: record.args,
            durationMs: record.durationMs,
            ok: record.ok,
          })),
        },
      ])
      .output(({ citations }) => citations),
    release: workflow<AgentContext, AgentResourceInput>(
      "agent.askStream.release",
    )
      .call("closeTools", async (_, { input }) => input.resource.close())
      .output(({ closeTools }) => closeTools),
  }),
  (context: AgentContext, input: AgentAskInput, signal?: AbortSignal) => ({
    context,
    input,
    signal,
  }),
);

export const askAgentWorkflow = bindWorkflow(
  workflow<AgentContext, AgentAskInput>("agent.ask")
    .call("answer", async ({ context, signal }, { input }) =>
      collectAgentAnswer(askAgentStreamWorkflow(context, input, signal)),
    )
    .output(({ answer }) => answer),
  (context: AgentContext, input: AgentAskInput) => ({ context, input }),
);
