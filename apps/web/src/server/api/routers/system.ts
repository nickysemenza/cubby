import { configSchema, transformConfig } from "~/schemas/config";
import { systemProcedure, createTRPCRouter } from "../trpc";
import { insertDataConfig } from "~/server/repo/system";

const loadConfig = systemProcedure
  .input(configSchema)
  .mutation(async ({ ctx, input }) => {
    const transformedInput = transformConfig(input);
    return await insertDataConfig(ctx.db, transformedInput, ctx.projectId);
  });

export const systemRouter = createTRPCRouter({
  loadConfig,
});
