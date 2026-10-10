import type { CubbyMcpToolAction } from "@cubby/schemas/mcp-tools";
import { z } from "zod";

/**
 * Stored agent transcripts name the MCP tool each call used. Before the
 * 21-tool consolidation every action was its own tool, and runs recorded then
 * keep those names, so a transcript is read through one display vocabulary:
 * `${tool}.${action}`. A name this map does not know (production telemetry
 * holds ~150 historical names) falls back to itself rather than failing.
 */
const LEGACY_TOOL_ACTIONS = {
  add_recipe_to_meal: "meal_recipe.add",
  attach_existing_image: "image.attach_existing",
  attach_files: "image.attach_files",
  clear_data_exception: "data_exception.clear",
  commit_photo_group: "photo_run.commit_group",
  commit_purchase_import: "purchase_import.commit",
  confirm_purchase_merchant_vendor: "purchase_import.confirm_vendor",
  correct_image_description: "image.correct_description",
  create_file_uploads: "image.create_uploads",
  create_recipe_from_text: "recipe_import.from_text",
  delete_statement_rows: "statement_rows.delete",
  entity_batch: "entity.commands",
  entity_batch_preview: "entity_read.preview",
  entity_preview: "entity_read.preview",
  explain_recipe_costing: "recipe_insights.costing",
  find_cookable_recipes: "recipe_insights.cookable",
  find_or_create_product_by_upc: "upc.find_or_create",
  find_product_external_id_collisions: "imports_read.external_id_collisions",
  find_recipes_using_ingredient: "recipe_insights.using_ingredient",
  find_similar_entities: "search.similar",
  find_statement_row_drift: "finance_read.drift",
  find_usda_food: "usda_food.find",
  get_daily_intake: "nutrition.daily_intake",
  get_entity_connections: "entity_read.connections",
  get_expense_analytics: "project_overview.expense_analytics",
  get_house_status: "project_overview.house_status",
  get_household_contribution_ledger: "finance_read.contribution_ledger",
  get_image_processing: "imports_read.image_processing",
  get_meal_preparations: "nutrition.preparations",
  get_photo_run_context: "imports_read.photo_context",
  get_project_budget: "project_overview.budget",
  get_project_contribution: "project_overview.contribution",
  get_recent_activity: "activity.recent",
  get_recipe_nutrition: "recipe_insights.nutrition",
  get_recipe_tags: "recipe_insights.tags",
  get_shopping_list: "nutrition.shopping_list",
  get_statement_row_summary: "finance_read.summary",
  get_task_summary: "tasks_overview.summary",
  get_usda_food: "usda_food.get",
  get_vendor_coverage: "imports_read.vendor_coverage",
  global_search: "search.global",
  import_operation_status: "imports_read.purchase_status",
  import_recipe: "recipe_import.import",
  link_expenses_to_purchase: "expenses.link_to_purchase",
  list_actionable_tasks: "tasks_overview.actionable",
  list_cookbooks: "recipe_insights.cookbooks",
  list_entity_relation: "entity_read.relations",
  list_photo_group_proposals: "imports_read.photo_proposals",
  list_problems: "activity.problems",
  list_product_project_uses: "project_overview.product_uses",
  list_statement_imports: "finance_read.imports",
  list_statement_rows: "finance_read.statement_rows",
  lookup_upc: "imports_read.upc_lookup",
  match_expenses: "finance_read.expense_match",
  move_inventory_entries: "entity.move_inventory",
  patch_recipe_line: "recipe_import.patch_line",
  prepare_purchase_import: "purchase_import.prepare",
  preview_entity_operation: "entity_read.preview",
  preview_financial_statement_import: "finance_read.preview_import",
  propose_photo_groups: "photo_run.propose_groups",
  propose_product_match: "product_enrichment.propose_match",
  reclassify_purchase_document: "purchase_import.reclassify",
  record_statement_rows: "statement_rows.record",
  remove_meal_recipe: "meal_recipe.remove",
  repoint_project_uses: "entity.repoint_project_uses",
  resolve_ingredients: "entity.resolve",
  resolve_plants: "entity.resolve",
  resolve_products: "entity_read.resolve",
  save_meal_recipe_preparation: "meal_recipe.save_preparation",
  schedule_image_processing: "image.schedule_processing",
  scrape_recipe: "recipe_insights.scrape",
  search_usda_foods: "usda_food.search",
  set_data_exception: "data_exception.set",
  split_expense: "expenses.split",
  suggest_financial_transfer_pairs: "finance_read.transfer_pairs",
  suggest_photo_product_candidates: "imports_read.photo_candidates",
  suggest_project_tools: "project_overview.tool_suggestions",
  update_meal_recipe: "meal_recipe.update",
  update_statement_rows: "statement_rows.update",
  verify_products_images: "product_enrichment.verify_images",
} as const satisfies Record<string, CubbyMcpToolAction>;

const KERNEL_READS = new Set(["get", "list", "search"]);

const actionField = z.object({ action: z.string() });
const commandField = z.object({ command: actionField });

/**
 * The `tool.action` a recorded call ran. `input` is the call's arguments:
 * a current call carries its `action`, and the retired `entity` /
 * `get_entities` tools carried theirs inside `command`.
 */
export function displayToolAction(toolName: string, input?: unknown): string {
  const leaf = toolName.split("__").at(-1) ?? toolName;
  if (Object.hasOwn(LEGACY_TOOL_ACTIONS, leaf))
    // SAFETY: `Object.hasOwn` just proved `leaf` is one of the map's keys.
    return LEGACY_TOOL_ACTIONS[leaf as keyof typeof LEGACY_TOOL_ACTIONS];
  const command = commandField.safeParse(input).data?.command.action;
  if (leaf === "get_entities") return `entity_read.${command ?? "get"}`;
  if (leaf === "entity" && command)
    return KERNEL_READS.has(command)
      ? `entity_read.${command}`
      : `entity.${command === "attach" ? "link" : command === "detach" ? "unlink" : command}`;
  const action = actionField.safeParse(input).data?.action;
  return action ? `${leaf}.${action}` : leaf;
}
