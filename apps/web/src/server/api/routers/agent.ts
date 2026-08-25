import { agentAskInputSchema, agentResultSchema } from "@cubby/schemas/agent";
import { runAgent, runAgentStream } from "~/server/agent/runtime";
import { domainRouter } from "../domain";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const agentRouter = createTRPCRouter({
  /**
   * Natural-language query over Cubby's data. Runs an agent loop over the
   * read-only MCP tool surface and returns a synthesized answer + citations.
   */
  ask: protectedProcedure
    .input(agentAskInputSchema)
    .output(strictOutput(agentResultSchema))
    .mutation(async ({ ctx, input }) => {
      const caller = domainRouter.createCaller({
        ...ctx,
        requestOrigin: "agent" as const,
        readDb: ctx.db,
        readConsistency: {
          consistency: "strong" as const,
          reason: "non-browser-origin" as const,
        },
      });
      return runAgent(caller, ctx.db, ctx.actorContext.userId, input.query);
    }),

  /**
   * Streaming variant: yields tool/delta/done events as the agent loop runs,
   * for a progressive "typing" reveal. Streams over httpBatchStreamLink (no
   * subscription/SSE infra needed). Consumed via the vanilla client's
   * `for await`. No `.output()` — the generator's return type drives client
   * inference.
   */
  askStream: protectedProcedure
    .input(agentAskInputSchema)
    .query(async function* ({ ctx, input }) {
      const caller = domainRouter.createCaller({
        ...ctx,
        requestOrigin: "agent" as const,
        readDb: ctx.db,
        readConsistency: {
          consistency: "strong" as const,
          reason: "non-browser-origin" as const,
        },
      });
      yield* runAgentStream(
        caller,
        ctx.db,
        ctx.actorContext.userId,
        input.query,
      );
    }),
});
