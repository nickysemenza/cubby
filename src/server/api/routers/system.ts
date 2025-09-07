import { configSchema, transformConfig } from "~/schemas/config";
import { publicProcedure, createTRPCRouter } from "../trpc";
import { loadLocations } from "~/server/repo/location";
import { loadProducts } from "~/server/repo/product";
import { type PrismaClient } from "@prisma/client";

const loadConfig = publicProcedure
  .input(configSchema)
  .mutation(async ({ ctx, input }) => {
    const transformedInput = transformConfig(input);
    return await insertDataConfig(ctx.db, transformedInput);
  });

export const insertDataConfig = async (
  db: PrismaClient,
  input: ReturnType<typeof transformConfig>,
) => {
  return await db.$transaction(async (tx) => {
    await loadProducts(tx, input.products);
    await loadLocations(tx, input.locations);
  });
};
export const systemRouter = createTRPCRouter({
  loadConfig,
});
