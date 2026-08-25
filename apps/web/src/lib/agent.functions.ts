import {
  type agentAskInputSchema,
  agentResultSchema,
  agentStreamEventSchema,
} from "@cubby/schemas/agent";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { openWorkflowStream } from "~/lib/workflow-stream";
import * as browser from "~/server/agent-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const askTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof agentAskInputSchema>)
  .handler(({ data, context }) =>
    browser.askAgentForBrowser({ data, request: context.startOperation }),
  );
const askOperation = startOperation({
  operation: "agent.ask",
  kind: "mutation",
  transport: (data: z.input<typeof agentAskInputSchema>, { signal, headers }) =>
    askTransport({ data, signal, headers }),
  parse: (result) => agentResultSchema.parse(result),
});
export const askAgentForBrowser = (
  input: z.input<typeof agentAskInputSchema>,
  signal?: AbortSignal,
) => askOperation.call(input, { signal });
export const askAgentStream = (
  input: z.input<typeof agentAskInputSchema>,
  signal?: AbortSignal,
) =>
  openWorkflowStream({
    operation: "agent.askStream",
    kind: "mutation",
    url: "/api/agent-stream/ask",
    input,
    eventSchema: agentStreamEventSchema,
    signal,
  });
