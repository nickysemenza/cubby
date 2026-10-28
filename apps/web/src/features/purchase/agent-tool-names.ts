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
  add_recipe_to_meal: "nutrition.plan_recipe",
  attach_existing_image: "image.attach_existing",
  attach_files: "image.attach_file",
  clear_data_exception: "data_exception.clear_exception",
  commit_photo_group: "photo_run.commit_group",
  commit_purchase_import: "purchase_import.commit",
  create_file_uploads: "image.create_file_upload",
  create_recipe_from_text: "recipe_insights.create_from_text",
  delete_statement_rows: "entity.delete",
  entity_batch: "entity.commands",
  entity_batch_preview: "entity_read.preview",
  entity_preview: "entity_read.preview",
  explain_recipe_costing: "recipe_insights_read.costing_explanation",
  find_cookable_recipes: "recipe_insights_read.get_makeable",
  find_or_create_product_by_upc: "product_enrichment.find_or_create_by_upc",
  find_product_external_id_collisions:
    "product_enrichment_read.external_id_collisions",
  find_recipes_using_ingredient: "recipe_insights_read.recipe_usages",
  find_similar_entities: "search_read.similar",
  find_statement_row_drift: "finance_read.drift",
  find_usda_food: "usda_food.find",
  get_daily_intake: "nutrition_read.daily_intake",
  get_entity_connections: "entity_graph_read.connections",
  get_expense_analytics: "expenses_read.analytics",
  get_house_status: "project_overview_read.house_status",
  get_household_contribution_ledger: "finance_read.ledger",
  get_image_processing: "image_read.status",
  get_meal_preparations: "nutrition_read.preparations_detail",
  get_photo_run_context: "photo_run_read.run_context",
  get_project_budget: "project_overview_read.budget",
  get_project_contribution: "finance_read.project",
  get_recent_activity: "activity_read.list",
  get_recipe_nutrition: "recipe_insights_read.nutrition",
  get_recipe_tags: "recipe_insights_read.tags",
  get_shopping_list: "nutrition_read.get_shopping_list",
  get_statement_row_summary: "finance_read.summary",
  get_task_summary: "tasks_overview.summary",
  get_usda_food: "usda_food.by_fdc_id",
  get_vendor_coverage: "imports_read.coverage",
  global_search: "search_read.global",
  import_operation_status: "purchase_import_read.operation_status",
  import_recipe: "recipe_insights.import_from_url",
  link_expenses_to_purchase: "expenses.link",
  list_actionable_tasks: "tasks_overview.list_actionable",
  list_cookbooks: "recipe_insights_read.list",
  list_entity_relation: "entity_graph_read.relation",
  list_photo_group_proposals: "photo_run_read.proposals",
  list_problems: "activity_read.report",
  list_product_project_uses: "product_enrichment_read.project_uses",
  list_statement_imports: "entity_read.list",
  list_statement_rows: "entity_read.list",
  lookup_upc: "product_enrichment_read.lookup_upc",
  match_expenses: "expenses_read.match",
  move_inventory_entries: "inventory.move_entries",
  patch_recipe_line: "recipe_insights.patch_line",
  prepare_purchase_import: "purchase_import.prepare",
  preview_entity_operation: "entity_read.preview",
  preview_financial_statement_import: "finance_read.preview_transaction_import",
  propose_photo_groups: "photo_run.propose_groups",
  propose_product_match: "product_enrichment.propose_product_match",
  reclassify_purchase_document: "expenses.reclassify_document",
  record_statement_rows: "finance.record",
  remove_meal_recipe: "nutrition.remove_recipe",
  repoint_project_uses: "project_overview.repoint_uses",
  resolve_ingredients: "entity.resolve",
  resolve_plants: "entity.resolve",
  resolve_products: "entity_read.resolve",
  save_meal_recipe_preparation: "nutrition.save_preparation",
  schedule_image_processing: "image.schedule",
  scrape_recipe: "recipe_insights_read.scrape_url",
  search_usda_foods: "usda_food.search",
  set_data_exception: "data_exception.set_exception",
  split_expense: "expenses.split_with_delta",
  suggest_financial_transfer_pairs: "finance_read.transfer_pairs",
  suggest_photo_product_candidates: "photo_run_read.product_candidates",
  suggest_project_tools: "project_overview_read.tool_suggestions",
  update_meal_recipe: "nutrition.update_recipe",
  update_statement_rows: "entity.update",
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
