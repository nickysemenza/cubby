import { createTRPCRouter } from "~/server/api/trpc";
import { domainRouterRecord } from "./domain";
import { agentRouter } from "./routers/agent";

/** Public app router; paths are unchanged from the former single record. */
export const appRouter = createTRPCRouter({
  ...domainRouterRecord,
  agent: agentRouter,
});

export type AppRouter = typeof appRouter;
