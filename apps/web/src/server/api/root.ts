import { createTRPCRouter } from "~/server/api/trpc";
import { agentRouter } from "./routers/agent";
import { aiRouter } from "./routers/ai";
import { auditLogRouter } from "./routers/audit-log";
import { backgroundJobsRouter } from "./routers/background-jobs";
import { dashboardRouter } from "./routers/dashboard";
import { imageRouter } from "./routers/image";
import { ingredientRouter } from "./routers/ingredient";
import { inventoryRouter } from "./routers/inventory";
import { locationRouter } from "./routers/location";
import { mcpRouter } from "./routers/mcp";
import { mealRouter } from "./routers/meal";
import { notionRouter } from "./routers/notion";
import { problemsRouter } from "./routers/problems";
import { productRouter } from "./routers/product";
import { recipeRouter } from "./routers/recipe";
import { searchRouter } from "./routers/search";
import { suggestionsRouter } from "./routers/suggestions";
import { upcRouter } from "./routers/upc";
import { usdaRouter } from "./routers/usda";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  agent: agentRouter,
  ai: aiRouter,
  backgroundJobs: backgroundJobsRouter,
  dashboard: dashboardRouter,
  recipe: recipeRouter,
  ingredient: ingredientRouter,
  location: locationRouter,
  product: productRouter,
  inventory: inventoryRouter,
  meal: mealRouter,
  mcp: mcpRouter,
  notion: notionRouter,
  usda: usdaRouter,
  upc: upcRouter,
  image: imageRouter,
  problems: problemsRouter,
  auditLog: auditLogRouter,
  search: searchRouter,
  suggestions: suggestionsRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
