import { type DataConfig, configSchema } from "~/schemas/config";
import { publicProcedure, createTRPCRouter } from "../trpc";
import { loadLocations } from "~/server/repo/location";
import { loadProducts } from "~/server/repo/product";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { type PrismaClient } from "@prisma/client";

const loadConfig = publicProcedure
  .input(configSchema)
  .mutation(async ({ ctx, input }) => await insertDataConfig(ctx.db, input));

export const insertDataConfig = async (db: PrismaClient, input: DataConfig) => {
  return await db.$transaction(async (tx) => {
    await loadLocations(tx, input.locations);
    await loadProducts(tx, input.products);
    for (const [name, aliases] of Object.entries(input.aliases ?? {})) {
      await findOrCreateIngredient(tx, name, aliases);
    }
  });
};
export const systemRouter = createTRPCRouter({
  loadConfig,
});
