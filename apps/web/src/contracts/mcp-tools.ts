import { inventoryMcpBulkMoveOut } from "@cubby/schemas/inventory";
import {
  mcpUsdaFoodListItemOut,
  recipeAvailabilityMcpOut,
  usdaFoodMcpListOut,
  usdaFoodMcpOut,
} from "@cubby/schemas/mcp";
import { mealMcpOut } from "@cubby/schemas/meal";
import {
  productLookupUpcOut,
  productMcpDetailOut,
  productMcpOut,
} from "@cubby/schemas/product";
import {
  recipesUsingIngredientOut,
  recipeTagsOut,
} from "@cubby/schemas/recipe";
import { parseShortcode } from "@cubby/shared";
import { z } from "zod";

import { cookbookContract } from "~/contracts/cookbook.contract";
import { ENTITY_PREVIEW_RESOURCE } from "~/contracts/entity-preview";
import { expenseContract } from "~/contracts/expense.contract";
import { imageUploadContract } from "~/contracts/image-upload.contract";
import { imageContract } from "~/contracts/image.contract";
import { ingredientContract } from "~/contracts/ingredient.contract";
import { inventoryContract } from "~/contracts/inventory.contract";
import {
  defineMcpTools,
  kernelAction,
  mcpAction,
  mcpActionOverride,
  type McpActionOverride,
} from "~/contracts/mcp-define";
import {
  mcpItemsEnvelope,
  respondList,
  slimInventory,
  slimMeal,
  slimProduct,
  slimProductDetail,
  slimRecipe,
  slimUsdaFood,
  slimUsdaFoodListItem,
} from "~/contracts/mcp-projections";
import { mealContract } from "~/contracts/meal.contract";
import { productContract } from "~/contracts/product.contract";
import {
  recipeContract,
  recipeAvailabilityContract,
} from "~/contracts/recipe.contract";
import { runContract } from "~/contracts/run.contract";
import {
  usdaFoodContract,
  usdaSuggestionReason,
} from "~/contracts/usda.contract";
import { workQueueContract } from "~/contracts/work-queue.contract";

import { assessmentContract } from "./assessment.contract";

const usdaFoodLookupOut = z.object({ food: usdaFoodMcpOut });
const usdaFood = (output: {
  food: Parameters<typeof slimUsdaFood>[0] | null;
}) => ({ food: output.food ? slimUsdaFood(output.food) : null });

/** MCP-only metadata: kernel verbs, tool descriptions, and schema/output shaping. */
export const MCP_TOOL_DESCRIPTIONS = {
  entity_preview: {
    description:
      "Show compact inline previews of existing household records by shortcode. Use deliberately when the member asks to see records or visual context helps; ordinary reads stay on entity_read.",
  },
  activity: { description: "What changed recently, and what needs fixing." },
  ai: {
    description: "Agent-facing AI operations, usage, and suggestion work.",
  },
  ai_funding: {
    description:
      "Change household-wide frontier AI funding (every feature's frontier chat calls, not only Mail import); read it with ai_funding_read.status. Call only on the member's explicit instruction.",
  },
  collection: {
    description: "Manage household Collections and their member-defined tags.",
  },
  data_exception: {
    description:
      "Explicit negative knowledge on one completeness check of a Product, Vendor, Purchase, FinancialTransaction, or Expense; each call returns the recomputed dataQuality.",
  },
  entity: {
    description:
      "Write household entities: create, update, delete, merge, bulk-update, link/unlink an attachable relation, run up to 50 creates/updates at once, resolve-or-create ingredient and plant names, move inventory, and repoint project uses. Reads are entity_read. A field's own description in the schema (e.g. product.tags) states its contract — follow it rather than a pattern seen on other records.",
  },
  entity_graph: {
    description:
      "Inspect declared relationships and discover proposed connections. Discovery publishes suggestions; it does not accept links.",
  },
  entity_read: {
    description:
      "Read household entities: get one, list or search a kind, preview a create or a link change without writing, read an attachable relation or one-hop connections, and resolve Product names or external ids. Every action is read-only. Ingredient usuallyOnHand means assumed planning availability; recorded inventory remains separate. Recipe availability includes planning coverage and incomplete-quantity warnings. Consult entities://catalog only when the schema leaves a supported entity/action unclear.",
  },
  expenses: {
    description:
      "Re-attribute existing Expense money within purchases. No action creates money or moves it to another vendor.",
  },
  field_explanation: {
    description:
      "Explain a named field using its contract and current record context.",
  },
  finance: {
    description:
      "Apply uniquely supported financial evidence, or a member's explicit booking of one posted transaction, through server checks. Ambiguous or changed accepted facts remain review work.",
  },
  image: {
    description:
      "Files and images on declared image-bearing records. Galleries append; role cover replaces a Cookbook cover and role logo replaces a Vendor logo after image validation succeeds.",
  },
  imports_read: {
    description:
      "Read Vendor coverage and fetch a representative logo from a Vendor's public website after reviewing the resolved site.",
  },
  inventory: {
    description:
      "Receive, add, and discard household inventory. These actions change recorded stock; ordinary household use does not.",
  },
  maintenance: {
    description:
      "Inspect and repair operational state when the member asks. These actions can read diagnostics, retry work, or change retained support data.",
  },
  nutrition: {
    description: "Daily intake, meal preparations, and shopping needs.",
  },
  photo_run: {
    description:
      "A photo-inventory run's item grouping: propose groups for human review, or commit one when the user asks to skip review.",
  },
  playbook: {
    description:
      "Cubby's household playbooks: the step-by-step rules for purchase and receipt import, product enrichment, meal logging, household maintenance logging, photo inventory import, and garden plan import. Before starting one of those tasks, call playbook.list, then playbook.get the matching playbook and follow it.",
  },
  product_enrichment: {
    description:
      "Product identity upkeep: image integrity and match proposals. Product facts and identifier slots are written with entity.update; preserve research in `notes` inside `data`.",
  },
  project_overview: {
    description:
      "Household project, budget, tool, and spend rollups, plus repointing a Product's project-use history.",
  },
  purchase_import: {
    description:
      "Import a purchase from its source: prepare then commit one immutable import plan; confirm a merchant's Vendor; reclassify a Purchase document. A member's Claude/Codex session and Pi's Mail import use the same writers.",
  },
  recipe_insights: {
    description:
      "Recipe nutrition, costing, availability, cookbook upkeep, imports from text or URLs, and reverse lookups.",
  },
  run: {
    description:
      "Control Runs (Mail import, photo inventory, or a member's import); read one with run_read.work_snapshot. set_mail_import, discover_mail, commit_prepared and approve/reject spend money or settle evidence: call them only on the member's explicit instruction.",
  },
  search: {
    description:
      "Search across indexed entities, compare similarity candidates, and diagnose or request repair of search embeddings.",
  },
  shipments: {
    description:
      "Retain source-backed package tracking evidence without changing money or inventory.",
  },
  spending_classification_write: {
    description:
      "Preview and apply reviewed spending-classification changes atomically.",
  },
  suggestions: {
    description:
      "Read and review proposed household changes. Review decisions remain explicit member actions.",
  },
  tasks_overview: {
    description: "Task backlog reads across the whole tracker.",
  },
  usda_food: {
    description:
      "USDA FoodData Central records, the external nutrition source a Product maps to by `fdc_id`.",
  },
} as const;

export const MCP_ACTION_OVERRIDES = {
  "assessment.reviewBatch": mcpActionOverride(
    assessmentContract.ops.reviewBatch,
    {
      project: (items) => ({ items }),
      output: mcpItemsEnvelope(assessmentContract.ops.reviewBatch.output),
    },
  ),
  "cookbook.list": mcpActionOverride(cookbookContract.ops.list, {
    project: (items) => ({ items }),
    output: mcpItemsEnvelope(cookbookContract.ops.list.output),
  }),
  "expense.analytics": mcpActionOverride(expenseContract.ops.analytics, {
    strict: true,
  }),
  "image.attachExisting": mcpActionOverride(imageContract.ops.attachExisting, {
    telemetryEntity: (input) => parseShortcode(input.targetId)?.type,
  }),
  "image.attachFile": mcpActionOverride(imageUploadContract.ops.attachFile, {
    batch: { resultDetail: "full", reference: (item) => item.imageId },
    telemetryEntity: (item) => parseShortcode(item.entityId)?.type,
  }),
  "image.createFileUpload": mcpActionOverride(
    imageUploadContract.ops.createFileUpload,
    {
      batch: { resultDetail: "full", reference: (item) => item.uploadId },
    },
  ),
  "ingredient.recipeUsages": mcpActionOverride(
    ingredientContract.ops.recipeUsages,
    {
      project: (usages, input) => {
        const byRecipe = new Map<string, typeof usages>();
        for (const usage of usages)
          byRecipe.set(usage.recipe.id, [
            ...(byRecipe.get(usage.recipe.id) ?? []),
            usage,
          ]);
        const recipes = [...byRecipe.values()].map((rows) => ({
          ...slimRecipe(rows[0]!.recipe),
          usages: rows.map((usage) => ({
            lineId: usage.id,
            sectionName: usage.sectionName ?? null,
            amounts: usage.amounts,
            rawLine: usage.rawLine ?? null,
            modifier: usage.modifier ?? null,
          })),
        }));
        return { ingredientId: input.id, count: recipes.length, recipes };
      },
      output: recipesUsingIngredientOut,
    },
  ),
  "inventory.moveEntries": mcpActionOverride(
    inventoryContract.ops.moveEntries,
    {
      project: (output) => respondList(output.items, slimInventory),
      output: inventoryMcpBulkMoveOut,
    },
  ),
  "inventory.reconcileSession": mcpActionOverride(
    inventoryContract.ops.reconcileSession,
    {
      project: (output) => respondList(output.items, slimInventory),
      output: inventoryMcpBulkMoveOut,
    },
  ),
  "meal.removeRecipe": mcpActionOverride(mealContract.ops.removeRecipe, {
    project: slimMeal,
    output: mealMcpOut,
  }),
  "meal.updateRecipe": mcpActionOverride(mealContract.ops.updateRecipe, {
    project: slimMeal,
    output: mealMcpOut,
  }),
  "product.findOrCreateByUPC": mcpActionOverride(
    productContract.ops.findOrCreateByUPC,
    {
      project: (output) => ({
        ...slimProduct(output.product),
        warnings: output.sideEffects.warnings,
      }),
      output: productMcpOut.extend({
        warnings: z
          .array(z.string())
          .optional()
          .describe(
            "Best-effort follow-ups that failed after the product was saved, e.g. the cover-photo import.",
          ),
      }),
    },
  ),
  "product.lookupUpc": mcpActionOverride(productContract.ops.lookupUpc, {
    project: (output) => ({
      ...output,
      localProduct: output.localProduct
        ? slimProduct(output.localProduct)
        : null,
    }),
    output: productLookupUpcOut.extend({
      localProduct: productMcpOut.nullable(),
    }),
  }),
  "product.verifyImages": mcpActionOverride(productContract.ops.verifyImages, {
    project: slimProductDetail,
    output: productMcpDetailOut,
    batch: {
      maxItems: 20,
      resultDetail: "full",
      reference: (item) => item.id,
      uniqueIds: true,
    },
  }),
  "recipe.tags": mcpActionOverride(recipeContract.ops.tags, {
    project: (items) => ({ items }),
    output: mcpItemsEnvelope(recipeTagsOut),
  }),
  "recipeAvailability.getMakeable": mcpActionOverride(
    recipeAvailabilityContract.ops.getMakeable,
    {
      project: (output) => ({ recipes: output.recipes }),
      output: recipeAvailabilityMcpOut,
    },
  ),
  "run.lifecycle": mcpActionOverride(runContract.ops.lifecycle, {
    strict: true,
  }),
  "run.workSnapshot": mcpActionOverride(runContract.ops.workSnapshot, {
    project: (output) => ({
      ...output,
      findings: output.findings.map(({ proposedFix, ...finding }) => ({
        ...finding,
        hasProposedFix: proposedFix !== null,
      })),
    }),
    output: runContract.ops.workSnapshot.output.extend({
      findings: z.array(
        runContract.ops.workSnapshot.output.shape.findings.element
          .omit({ proposedFix: true })
          .extend({ hasProposedFix: z.boolean() }),
      ),
    }),
  }),
  "usda-food.byFdcId": mcpActionOverride(usdaFoodContract.ops.byFdcId, {
    project: usdaFood,
    output: usdaFoodLookupOut,
  }),
  "usda-food.find": mcpActionOverride(usdaFoodContract.ops.find, {
    project: usdaFood,
    output: usdaFoodLookupOut,
  }),
  "usda-food.search": mcpActionOverride(usdaFoodContract.ops.search, {
    project: (output) => ({
      meta: {
        pageIndex: output.meta.pageIndex,
        pageSize: output.meta.pageSize,
        totalCount: output.meta.totalCount,
      },
      items: output.items.map(slimUsdaFoodListItem),
    }),
    output: usdaFoodMcpListOut,
  }),
  "usda-food.suggestForProduct": mcpActionOverride(
    usdaFoodContract.ops.suggestForProduct,
    {
      project: (output) => ({
        currentFdcId: output.currentFdcId,
        candidates: output.candidates.map((candidate) => ({
          reason: candidate.reason,
          food: slimUsdaFoodListItem(candidate.food),
        })),
      }),
      output: z.object({
        currentFdcId: z.number().int().nullable(),
        candidates: z.array(
          z.object({
            reason: usdaSuggestionReason,
            food: mcpUsdaFoodListItemOut,
          }),
        ),
      }),
    },
  ),
  "workQueue.forMember": mcpActionOverride(workQueueContract.ops.forMember, {
    strict: true,
  }),
} satisfies Readonly<Record<string, McpActionOverride>>;

export const MCP_TOOLS = defineMcpTools({
  entity_preview: {
    actions: {
      show: mcpAction({
        op: kernelAction("renderCards", "query"),
        uiResourceUri: ENTITY_PREVIEW_RESOURCE,
        description:
          "Render 1–20 existing records in caller order from shortcodes. Mixed entity kinds are supported. Returns names, canonical display images, declared preview facts and Cubby links; unavailable records remain visible individually. Read-only snapshot; no edits or automatic refresh.",
      }),
    },
  },
  entity_read: {
    actions: {
      get: mcpAction({
        op: kernelAction("get", "query"),
        description:
          'One record by its shortcode. `missing: "null"` returns null instead of an error. `resultDetail: "full"` returns the complete projection — for a Product the detailed media read; the default summary is identity plus status; "compact" is the same identity-and-status row list compact returns (no child collections, labels or long notes). `fields` returns only those keys (dot paths like "financialReconciliation.status"; `id` always) of the full projection.',
      }),
      list: mcpAction({
        op: kernelAction("list", "query"),
        description:
          'One page of a kind, with that kind\'s own typed `filters`, `sort`, `pagination` and `groupBy`; returns { meta, items }. `sort` is a stack, primary first: sort=[{orderBy:"name",direction:"asc"}]. Every scored entity accepts orderBy "dataQuality" (ascending = weakest identity first) plus dataStatus/dataGap filters, the enrichment worklist. A full page of a large kind can exceed the output limit: prefer `resultDetail: "compact"` (identity and status: scalar list fields, dataQuality status/score when the entity declares it required, no child collections or long notes) or `fields` (only those keys, dot paths allowed, `id` always) over "full".',
      }),
      search: mcpAction({
        op: kernelAction("search", "query"),
        description:
          "Name/alias search within one kind; semantic hits are returned separately and never replace lexical ones.",
      }),
      preview: mcpAction({
        op: kernelAction("preview", "query"),
        // A create preview asks the decision model for manifest-declared field suggestions.
        modelBacked: true,
        description:
          'Preview without writing. `{entity, data, context?}` previews one create: contextual seeds merge first, explicit data wins, and manifest-declared decision suggestions come back with confidence and provenance. `{items: [...]}` previews up to 50 creates independently. `{operation: {action: "attach"|"detach", entity, relation, id, items}}` dry-runs a link change, returning `blockers`, `changes` and `sideEffects` with per-target breakdowns and `canProceed`; it is advisory, since the mutation re-validates in its own transaction.',
      }),
      resolve: mcpAction({
        op: kernelAction("resolve", "query"),
        description:
          '`{entity: "product", names?, lines?}`: which receipt lines already exist as Products, WITHOUT creating anything. `names` are bare strings; `lines` are `{name, externalIds?: [{source, id}]}` (up to 200 together) for lines that carry identifiers, e.g. one grocery ASIN under `amazon`, `amazon-fresh` and `whole-foods`: a pair hits only under the source that holds it. Each line gets `exactIdHits` (live Products holding any of its source/id pairs, the strongest evidence), `ingredientHits` (Ingredients whose name or alias equals the name, case-insensitively), and `candidates`: `exact: true` with the case-insensitive Product name/alias matches, or `exact: false` with up to 3 ranked candidates to read by hand (lexical search: the name contains the request, the request contains the name, any shared word, or a near spelling). `names` are deduplicated case-insensitively; `lines` each answer once, in order, after the names. The dedup pass before an import creates Products (a receipt\'s lines in one call); the create stays a deliberate entity.create or entity.commands call. Unlike entity.resolve this never mints a row, because a Product is identity plus cost basis, not just a name.',
      }),
    },
  },
  entity: {
    actions: {
      create: mcpAction({
        op: kernelAction("create", "mutation"),
        description:
          "Create one record; `data` is that kind's create schema. A recipe also returns `lineCoverage`: per ingredient line, which of price/weight/nutrients are still missing, so an unmapped line is visible before costing is read.",
      }),
      update: mcpAction({
        op: kernelAction("update", "mutation"),
        description:
          "Patch one record by `id`; fields left out of `data` are unchanged. A recipe also returns `lineCoverage` (see create). A product update that touches price, unitMappings, fdc_id, labelNutrition, ingredientId or usdaUnavailable also returns `recipeCoverageChanges`: for up to 25 recipes using its ingredient, the lines whose missing price/weight/nutrients it closed or regressed (`before`/`after`), with `truncated` when more recipes use it.",
      }),
      delete: mcpAction({
        op: kernelAction("delete", "mutation"),
        destructive: true,
        description:
          'Soft-delete up to 500 records of one kind by `ids`, applying each incoming edge\'s declared disposition (block, detach, repoint). Read entity_graph_read.connections with operation "delete" first when unsure.',
      }),
      merge: mcpAction({
        op: kernelAction("merge", "mutation"),
        destructive: true,
        description:
          'Merge duplicates into one survivor; `data` is that kind\'s merge input, e.g. {action:"merge", entity:"product", data:{keepId:"PRD-2ABC", mergeIds:["PRD-3DEF"]}}.',
      }),
      bulkUpdate: mcpAction({
        op: kernelAction("bulkUpdate", "mutation"),
        description:
          "Set the same fields on up to 500 records of one kind (`ids` + `data`); only the fields the kind declares bulk-editable are accepted.",
      }),
      link: mcpAction({
        op: kernelAction("link", "mutation"),
        description:
          "Attach items to one record's relation: product `components`, project `resources`, purchase `products`.",
      }),
      unlink: mcpAction({
        op: kernelAction("unlink", "mutation"),
        description:
          "Detach items from one record's relation. To move a Product's project-use history, use project_overview.repoint_uses instead.",
      }),
      commands: mcpAction({
        op: kernelAction("commands", "mutation"),
        description:
          "Run up to 50 create/update commands (`commands: [{action, entity, ...}]`) in request order, each with the same validation, side effects and result shape as a single create or update (including `lineCoverage` and `recipeCoverageChanges`). Items succeed or fail independently — a failed item does not stop or roll back the others — so read every result. Use this for a receipt's lines or a batch of products.",
      }),
      resolve: mcpAction({
        op: kernelAction("resolveOrCreate", "mutation"),
        description:
          'Resolve names to ids in one call, creating what is missing. `{entity: "ingredient", names, linkProductId?}` matches case-insensitively, aliases included; each result carries `candidateProducts` (up to 5 live Products with no ingredient link whose name contains every word of the ingredient, best first) and `linkProductId` (exactly one name) links one of them to the ingredient through the normal Product update. `{entity: "plant", plants: [{name, gardenGuideKey?, ingredientName?}]}` matches a live Plant by name within the crop key when given, returning `created` per row; `ingredientName` only fills a created Plant\'s informational ingredient link. Resolve cultivars before creating Plantings — a Planting names its Plant, never free-text variety.',
      }),
    },
  },
});
