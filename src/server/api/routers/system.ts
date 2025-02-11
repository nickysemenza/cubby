import { Config, configSchema } from "~/schemas/config";
import { publicProcedure, createTRPCRouter } from "../trpc";
import { loadLocations } from "~/server/repo/location";
import { loadProducts } from "~/server/repo/product";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { Prisma, PrismaClient } from "@prisma/client";

const loadConfig = publicProcedure
  .input(configSchema)
  .mutation(async ({ ctx, input }) => await insertConfig(ctx.db, input));

const insertConfig = async (db: PrismaClient, input: Config) => {
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
