import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";
import { auditLogRouter } from "./routers/audit-log";
import { googleSheetsRouter } from "./routers/google-sheets";
import { imageRouter } from "./routers/image";
import { ingredientRouter } from "./routers/ingredient";
import { inventoryRouter } from "./routers/inventory";
import { locationRouter } from "./routers/location";
import { problemsRouter } from "./routers/problems";
import { productRouter } from "./routers/product";
import { recipeRouter } from "./routers/recipe";
import { upcRouter } from "./routers/upc";
import { usdaRouter } from "./routers/usda";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  recipe: recipeRouter,
  ingredient: ingredientRouter,
  location: locationRouter,
  product: productRouter,
  inventoryItem: inventoryRouter,
  usda: usdaRouter,
  upc: upcRouter,
  image: imageRouter,
  problems: problemsRouter,
  auditLog: auditLogRouter,
  googleSheets: googleSheetsRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.post.all();
 *       ^? Post[]
 */
export const createCaller = createCallerFactory(appRouter);
