import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";
import { recipeRouter } from "./routers/recipe";
import { demoRouter } from "./routers/demo";
import { ingredientRouter } from "./routers/ingredient";
import { locationRouter } from "./routers/location";
import { productRouter } from "./routers/product";
import { systemRouter } from "./routers/system";
import { inventoryentryRouter } from "./routers/inventory";
import { usdaRouter } from "./routers/usda";
import { imageRouter } from "./routers/image";
import { problemsRouter } from "./routers/problems";
import { projectRouter } from "./routers/project";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  recipe: recipeRouter,
  ingredient: ingredientRouter,
  demo: demoRouter,
  location: locationRouter,
  product: productRouter,
  system: systemRouter,
  inventoryItem: inventoryentryRouter,
  usda: usdaRouter,
  image: imageRouter,
  problems: problemsRouter,
  project: projectRouter,
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
