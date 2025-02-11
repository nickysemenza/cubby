import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";
import { recipeRouter } from "./routers/recipe";
import { demoRouter } from "./routers/demo";
import { ingredientRouter } from "./routers/ingredients";
import { locationRouter } from "./routers/locations";
import { productRouter } from "./routers/products";
import { systemRouter } from "./routers/system";

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
