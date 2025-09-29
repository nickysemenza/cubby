import { configSchema, transformConfig } from "~/schemas/config";
import { systemProcedure, createTRPCRouter } from "../trpc";
import { loadLocations } from "~/server/repo/location";
import { loadProducts } from "~/server/repo/product";
import { type PrismaClient } from "@prisma/client";
import { type ProjectId } from "~/schemas/identifiers";

const loadConfig = systemProcedure
  .input(configSchema)
  .mutation(async ({ ctx, input }) => {
    const transformedInput = transformConfig(input);
    return await insertDataConfig(ctx.db, transformedInput, ctx.projectId);
  });

export const insertDataConfig = async (
  db: PrismaClient,
  input: ReturnType<typeof transformConfig>,
  projectId: ProjectId,
) => {
  return await db.$transaction(async (tx) => {
    await loadProducts(tx, input.products, projectId);
    await loadLocations(tx, input.locations, projectId);
  });
};
export const systemRouter = createTRPCRouter({
  loadConfig,
});
