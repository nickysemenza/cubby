/** Caller-facing seam for shared MCP tool registration and response behavior. */
export { registerBatchTool, rejectDuplicateIds } from "./batch-tool";
export {
  respond,
  respondList,
  slimInventory,
  slimMeal,
  slimProduct,
  slimProductDetail,
  slimRecipe,
  slimUsdaFood,
  slimUsdaFoodListItem,
} from "./response-projection";
export { registerRouterTool } from "./router-tool";
export { installMockStrippedListToolsHandler } from "./tool-catalog";
export { idParam, strictFilterInput } from "./tool-input";
export { stripMockFromJsonSchema } from "./tool-json-schema";
export {
  getRequestContext,
  READ_ONLY_CLOSED,
  READ_ONLY_OPEN,
  registerMcpTool,
  type ToolExtra,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./tool-registration";
