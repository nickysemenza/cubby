import { createTRPCRouter } from "~/server/api/trpc";
import { aiRouter } from "./routers/ai";
import { auditLogRouter } from "./routers/audit-log";
import { backgroundJobsRouter } from "./routers/background-jobs";
import { calendarRouter } from "./routers/calendar";
import { collectionRouter } from "./routers/collection";
import { dashboardRouter } from "./routers/dashboard";
import { dataQualityRouter } from "./routers/data-quality";
import { entityIntegrityRouter } from "./routers/entity-integrity";
import { expenseRouter } from "./routers/expense";
import { financialAccountRouter } from "./routers/financial-account";
import { financialTransactionRouter } from "./routers/financial-transaction";
import { householdContributionRouter } from "./routers/household-contribution";
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
import { recommendationsRouter } from "./routers/recommendations";
import { relatedDataRouter } from "./routers/related-data";
import { relatednessRouter } from "./routers/relatedness";
import { searchRouter } from "./routers/search";
import { statementRowRouter } from "./routers/statement-row";
import { suggestionsRouter } from "./routers/suggestions";
import { taskRouter } from "./routers/task";
import { upcRouter } from "./routers/upc";
import { usdaRouter } from "./routers/usda";
import { vendorRouter } from "./routers/vendor";

/** Routers available to internal MCP/agent callers (the agent excludes itself). */
export const domainRouterRecord = {
  ai: aiRouter,
  backgroundJobs: backgroundJobsRouter,
  calendar: calendarRouter,
  collection: collectionRouter,
  dashboard: dashboardRouter,
  dataQuality: dataQualityRouter,
  recipe: recipeRouter,
  relatedData: relatedDataRouter,
  relatedness: relatednessRouter,
  recommendations: recommendationsRouter,
  ingredient: ingredientRouter,
  householdContribution: householdContributionRouter,
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
  purchase: purchaseRouter,
  mcp: mcpRouter,
  oauth: oauthRouter,
  usda: usdaRouter,
  upc: upcRouter,
  image: imageRouter,
  problems: problemsRouter,
  statementRow: statementRowRouter,
  entityIntegrity: entityIntegrityRouter,
  auditLog: auditLogRouter,
  search: searchRouter,
  suggestions: suggestionsRouter,
};

export const domainRouter = createTRPCRouter(domainRouterRecord);
export type DomainCaller = ReturnType<typeof domainRouter.createCaller>;
