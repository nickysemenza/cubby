import { createTRPCRouter } from "~/server/api/trpc";
import { aiRouter } from "./routers/ai";
import { auditLogRouter } from "./routers/audit-log";
import { backgroundJobsRouter } from "./routers/background-jobs";
import { calendarRouter } from "./routers/calendar";
import { dashboardRouter } from "./routers/dashboard";
import { dataQualityRouter } from "./routers/data-quality";
import { entityIntegrityRouter } from "./routers/entity-integrity";
import { expenseRouter } from "./routers/expense";
import { financialAccountRouter } from "./routers/financial-account";
import { financialTransactionRouter } from "./routers/financial-transaction";
import { imageRouter } from "./routers/image";
import { ingredientRouter } from "./routers/ingredient";
import { inventoryRouter } from "./routers/inventory";
import { locationRouter } from "./routers/location";
import { mcpRouter } from "./routers/mcp";
import { mealRouter } from "./routers/meal";
import { oauthRouter } from "./routers/oauth";
import { problemsRouter } from "./routers/problems";
import { productRouter } from "./routers/product";
import { projectRouter } from "./routers/project";
import { purchaseRouter } from "./routers/purchase";
import { recipeRouter } from "./routers/recipe";
import { relatedDataRouter } from "./routers/related-data";
import { searchRouter } from "./routers/search";
import { suggestionsRouter } from "./routers/suggestions";
import { taskRouter } from "./routers/task";
import { upcRouter } from "./routers/upc";
import { usdaRouter } from "./routers/usda";
import { vendorRouter } from "./routers/vendor";
import { wishRouter } from "./routers/wish";

/** Routers available to internal MCP/agent callers (the agent excludes itself). */
export const domainRouterRecord = {
  ai: aiRouter,
  backgroundJobs: backgroundJobsRouter,
  calendar: calendarRouter,
  dashboard: dashboardRouter,
  dataQuality: dataQualityRouter,
  recipe: recipeRouter,
  relatedData: relatedDataRouter,
  ingredient: ingredientRouter,
  location: locationRouter,
  product: productRouter,
  inventory: inventoryRouter,
  meal: mealRouter,
  project: projectRouter,
  task: taskRouter,
  expense: expenseRouter,
  financialAccount: financialAccountRouter,
  financialTransaction: financialTransactionRouter,
  vendor: vendorRouter,
  wish: wishRouter,
  purchase: purchaseRouter,
  mcp: mcpRouter,
  oauth: oauthRouter,
  usda: usdaRouter,
  upc: upcRouter,
  image: imageRouter,
  problems: problemsRouter,
  entityIntegrity: entityIntegrityRouter,
  auditLog: auditLogRouter,
  search: searchRouter,
  suggestions: suggestionsRouter,
};

export const domainRouter = createTRPCRouter(domainRouterRecord);
export type DomainCaller = ReturnType<typeof domainRouter.createCaller>;
