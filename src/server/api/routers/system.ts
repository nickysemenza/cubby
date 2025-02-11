import { configSchema } from "~/schemas/config";
import { publicProcedure, createTRPCRouter } from "../trpc";
import { loadLocations } from "~/server/repo/location";
import { loadProducts } from "~/server/repo/product";

const loadConfig = publicProcedure
  .input(configSchema)
  .mutation(async ({ ctx, input }) => {
    await loadLocations(ctx.db, input.locations);
    await loadProducts(ctx.db, input.products);
  });

export const systemRouter = createTRPCRouter({
  loadConfig,
});
