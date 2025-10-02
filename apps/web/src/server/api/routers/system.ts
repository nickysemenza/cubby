import { configSchema, transformConfig } from "~/schemas/config";
import { systemProcedure, createTRPCRouter } from "../trpc";
import { loadLocations } from "~/server/repo/location";
import { loadProducts } from "~/server/repo/product";
import { type Database } from "~/server/db";
import { type ProjectId } from "~/schemas/identifiers";
import { withTransaction } from "~/server/repo/database-helpers";

const loadConfig = systemProcedure
  .input(configSchema)
  .mutation(async ({ ctx, input }) => {
    const transformedInput = transformConfig(input);
    return await insertDataConfig(ctx.db, transformedInput, ctx.projectId);
  });

export const insertDataConfig = async (
  db: Database,
  input: ReturnType<typeof transformConfig>,
  projectId: ProjectId,
) => {
  return await withTransaction(db, async (tx) => {
    await loadProducts(tx, input.products, projectId);
    await loadLocations(tx, input.locations, projectId);
  });
};
export const systemRouter = createTRPCRouter({
  loadConfig,
});
