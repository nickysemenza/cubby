import { createTRPCRouter } from "~/server/api/trpc";
import { aiRouter } from "./routers/ai";
import { auditLogRouter } from "./routers/audit-log";
import { imageRouter } from "./routers/image";
import { ingredientRouter } from "./routers/ingredient";
import { inventoryRouter } from "./routers/inventory";
import { locationRouter } from "./routers/location";
import { problemsRouter } from "./routers/problems";
import { productRouter } from "./routers/product";
import { recipeRouter } from "./routers/recipe";
import { searchRouter } from "./routers/search";
import { upcRouter } from "./routers/upc";
import { usdaRouter } from "./routers/usda";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  ai: aiRouter,
  recipe: recipeRouter,
  ingredient: ingredientRouter,
  location: locationRouter,
  product: productRouter,
  inventory: inventoryRouter,
  usda: usdaRouter,
  upc: upcRouter,
  image: imageRouter,
  problems: problemsRouter,
  auditLog: auditLogRouter,
  search: searchRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
