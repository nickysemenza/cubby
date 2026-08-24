import { auditLogRouter } from "./routers/audit-log";
import { dataQualityRouter } from "./routers/data-quality";
import { entityIntegrityRouter } from "./routers/entity-integrity";
import { expenseRouter } from "./routers/expense";
import { financialTransactionRouter } from "./routers/financial-transaction";
import { householdContributionRouter } from "./routers/household-contribution";
import { imageRouter } from "./routers/image";
import { ingredientRouter } from "./routers/ingredient";
import { inventoryRouter } from "./routers/inventory";
import { mealRouter } from "./routers/meal";
import { problemsRouter } from "./routers/problems";
import { productRouter } from "./routers/product";
import { projectRouter } from "./routers/project";
import { purchaseRouter } from "./routers/purchase";
import { recipeRouter } from "./routers/recipe";
import { searchRouter } from "./routers/search";
import { statementRowRouter } from "./routers/statement-row";
import { suggestionsRouter } from "./routers/suggestions";
import { taskRouter } from "./routers/task";
import { usdaRouter } from "./routers/usda";
import { createTRPCRouter } from "./trpc";

export const mcpWorkflowRouter = createTRPCRouter({
  auditLog: auditLogRouter,
  dataQuality: dataQualityRouter,
  entityIntegrity: entityIntegrityRouter,
  expense: expenseRouter,
  financialTransaction: financialTransactionRouter,
  householdContribution: householdContributionRouter,
  image: imageRouter,
  ingredient: ingredientRouter,
  inventory: inventoryRouter,
  meal: mealRouter,
  problems: problemsRouter,
  product: productRouter,
  project: projectRouter,
  purchase: purchaseRouter,
  recipe: recipeRouter,
  search: searchRouter,
  statementRow: statementRowRouter,
  suggestions: suggestionsRouter,
  task: taskRouter,
  usda: usdaRouter,
});

export type McpWorkflowCaller = ReturnType<
  typeof mcpWorkflowRouter.createCaller
>;
