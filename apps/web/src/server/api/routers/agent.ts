import { agentAskInputSchema, agentResultSchema } from "@cubby/schemas/agent";
import { runAgent, runAgentStream } from "~/server/agent/runtime";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/**
 * Build a tRPC caller for the MCP tools to invoke. This lives in a closure so
 * the `appRouter` reference is cast to `any` at the boundary — `agentRouter`
 * is itself part of `appRouter`, so referencing the typed router here would
 * create a circular type and collapse the whole API to `any`. The procedure's
 * input/output are still pinned by the schemas below, so client types are
 * unaffected. Dynamic import mirrors routes/api/mcp.ts and avoids a static
 * import cycle.
 */
async function buildCaller(ctx: unknown): Promise<unknown> {
  const { createCallerFactory } = await import("../trpc");
  const { appRouter } = await import("../root");
  // biome-ignore lint/suspicious/noExplicitAny: severs circular type ref (agent is part of appRouter)
  return createCallerFactory(appRouter as any)(ctx as any);
}

export const agentRouter = createTRPCRouter({
  /**
   * Natural-language query over Cubby's data. Runs an agent loop over the
   * read-only MCP tool surface and returns a synthesized answer + citations.
   */
  ask: protectedProcedure
    .input(agentAskInputSchema)
    .output(agentResultSchema)
    .mutation(async ({ ctx, input }) => {
      const caller = await buildCaller(ctx);
      return runAgent(caller, ctx.db, input.query);
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
      const caller = await buildCaller(ctx);
      yield* runAgentStream(caller, ctx.db, input.query);
    }),
});
