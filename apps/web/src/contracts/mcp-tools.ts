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
import { projectResourceFeatureLabels } from "@cubby/schemas/product-category-relations";
import {
  recipesUsingIngredientOut,
  recipeTagsOut,
} from "@cubby/schemas/recipe";
import { parseShortcode } from "@cubby/shared";
import { z } from "zod";

import { auditLogContract } from "~/contracts/audit-log.contract";
import { cookbookContract } from "~/contracts/cookbook.contract";
import { dataQualityContract } from "~/contracts/data-quality.contract";
import { entityGraphContract } from "~/contracts/entity-graph.contract";
import { expenseContract } from "~/contracts/expense.contract";
import { financialTransactionContract } from "~/contracts/finance.contract";
import { householdContributionContract } from "~/contracts/household-contribution.contract";
import { imageProcessingContract } from "~/contracts/image-processing.contract";
import { imageUploadContract } from "~/contracts/image-upload.contract";
import { imageContract } from "~/contracts/image.contract";
import { ingredientContract } from "~/contracts/ingredient.contract";
import { inventoryContract } from "~/contracts/inventory.contract";
import {
  defineMcpTools,
  kernelAction,
  mcpAction,
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
import { photoImportContract } from "~/contracts/photo-import.contract";
import {
  problemReportWantsCounts,
  problemsContract,
} from "~/contracts/problems.contract";
import { productContract } from "~/contracts/product.contract";
import { projectContract } from "~/contracts/project.contract";
import { purchaseImportContract } from "~/contracts/purchase-import.contract";
import { purchaseContract } from "~/contracts/purchase.contract";
import {
  recipeContract,
  suggestionsContract,
} from "~/contracts/recipe.contract";
import { recommendationsContract } from "~/contracts/recommendations.contract";
import { runContract } from "~/contracts/run.contract";
import { searchContract } from "~/contracts/search.contract";
import { spendingClassificationContract } from "~/contracts/spending-classification.contract";
import { statementRowContract } from "~/contracts/statement-row.contract";
import { taskContract } from "~/contracts/task.contract";
import {
  usdaFoodContract,
  usdaSuggestionReason,
} from "~/contracts/usda.contract";
import { vendorContract } from "~/contracts/vendor.contract";

/**
 * The Cubby MCP surface: 24 tools, each a group of actions called as
 * `{ action, ...input }`. Read-only tools hold only queries, so an MCP client
 * can auto-approve them; `pnpm generate` refuses a tool that mixes kinds.
 * Action descriptions name other actions as `tool.action`.
 *
 * The purchase agent mounts tools by name, so its allowlists and capability
 * gate key on `${tool}.${action}` (`@cubby/schemas/mcp-tools`,
 * `server/purchase-import/capabilities.ts`): authorizing
 * `purchase_import.prepare` never authorizes `purchase_import.commit`.
 */

const usdaFoodLookupOut = z.object({ food: usdaFoodMcpOut });
const usdaFood = (output: {
  food: Parameters<typeof slimUsdaFood>[0] | null;
}) => ({ food: output.food ? slimUsdaFood(output.food) : null });

export const MCP_TOOLS = defineMcpTools({
  entity_read: {
    description:
      "Read household entities: get one, list or search a kind, preview a create or a link change without writing, read an attachable relation or one-hop connections, and resolve Product names or external ids. Every action is read-only. Ingredient usuallyOnHand means assumed planning availability; recorded inventory remains separate. Recipe availability includes planning coverage and incomplete-quantity warnings. Consult entities://catalog only when the schema leaves a supported entity/action unclear.",
    actions: {
      get: mcpAction({
        op: kernelAction("get", "query"),
        description:
          'One record by its shortcode. `missing: "null"` returns null instead of an error. `resultDetail: "full"` returns the complete projection — for a Product the detailed media read; the default summary is identity plus status.',
      }),
      list: mcpAction({
        op: kernelAction("list", "query"),
        description:
          'One page of a kind, with that kind\'s own typed `filters`, `sort`, `pagination` and `groupBy`; returns { meta, items }. `sort` is a stack, primary first: sort=[{orderBy:"name",direction:"asc"}]. Every scored entity accepts orderBy "dataQuality" (ascending = weakest identity first) plus dataStatus/dataGap filters, the enrichment worklist.',
      }),
      search: mcpAction({
        op: kernelAction("search", "query"),
        description:
          "Name/alias search within one kind; semantic hits are returned separately and never replace lexical ones.",
      }),
      preview: mcpAction({
        op: kernelAction("preview", "query"),
        readPolicy: "strong",
        // A create preview asks Jev for manifest-declared field suggestions.
        modelBacked: true,
        description:
          'Preview without writing. `{entity, data, context?}` previews one create: contextual seeds merge first, explicit data wins, and manifest-declared Jev suggestions come back with confidence and provenance. `{items: [...]}` previews up to 50 creates independently. `{operation: {action: "attach"|"detach", entity, relation, id, items}}` dry-runs a link change, returning `blockers`, `changes` and `sideEffects` with per-target breakdowns and `canProceed`; it is advisory, since the mutation re-validates in its own transaction.',
      }),
      relations: mcpAction({
        op: entityGraphContract.ops.relation,
        description:
          'The current rows of one attachable relation of one entity — the relations entity.link/unlink write. `purchase` `products`: the Products one Purchase acquired; `source` says why a row is there: "expense" when one of the order\'s own acquiring Expenses names the product, "link" for an explicit purchaseProduct link (goods bought through allocation-basis installment Expenses, which never carry a productId), "both" when each exists. This is provenance, not money — no amount or quantity, nothing summed into spend; `linkAttachedAt` is null on an "expense" row, so only rows with it set have a link to unlink. `product` `components`: what one kit or multi-pack Product is made of, one row per distinct component with its quantity; each row\'s `price` is the component\'s effective price, which already blends its quantity-weighted share of every kit it is in — do not add a kit share on top. `project` `resources`: the reusable tools and software explicitly used on one exact project; tools carry lifetime purchase/use economics, software the non-additive household spend charged during the project\'s window. Sub-project uses are separate.',
      }),
      connections: mcpAction({
        op: entityGraphContract.ops.connections,
        readPolicy: "strong",
        description:
          'One-hop physical connections of any entity: what points at it (`incoming`) and what it points at (`outgoing`), grouped by edge with a count and the first linked records. A merged-away code reads its survivor and reports `redirectedFrom`. Pass `operation: "delete"` or `"merge"` to see each incoming group\'s declared disposition (block, detach, repoint, ...) before running it; advisory, since the mutation re-validates.',
      }),
      resolve: mcpAction({
        op: kernelAction("resolve", "query"),
        description:
          '`{entity: "product", names?, lines?}`: which receipt lines already exist as Products, WITHOUT creating anything. `names` are bare strings; `lines` are `{name, externalIds?: [{source, id}]}` (up to 200 together) for lines that carry identifiers, e.g. one grocery ASIN under `amazon`, `amazon-fresh` and `whole-foods`: a pair hits only under the source that holds it. Each line gets `exactIdHits` (live Products holding any of its source/id pairs, the strongest evidence), `ingredientHits` (Ingredients whose name or alias equals the name, case-insensitively), and `candidates`: `exact: true` with the case-insensitive Product name/alias matches, or `exact: false` with up to 3 ranked candidates to read by hand (lexical search: the name contains the request, the request contains the name, any shared word, or a near spelling). `names` are deduplicated case-insensitively; `lines` each answer once, in order, after the names. The dedup pass before an import creates Products (a receipt\'s lines in one call); the create stays a deliberate entity.create or entity.commands call. Unlike entity.resolve this never mints a row, because a Product is identity plus cost basis, not just a name.',
      }),
    },
  },

  entity: {
    description:
      "Write household entities: create, update, delete, merge, bulk-update, link/unlink an attachable relation, run up to 50 creates/updates at once, resolve-or-create ingredient and plant names, move inventory, and repoint project uses. Reads are entity_read. A field's own description in the schema (e.g. product.tags) states its contract — follow it rather than a pattern seen on other records.",
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
          'Soft-delete up to 500 records of one kind by `ids`, applying each incoming edge\'s declared disposition (block, detach, repoint). Read entity_read.connections with operation "delete" first when unsure.',
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
          "Detach items from one record's relation. To move a Product's project-use history, use entity.repoint_project_uses instead.",
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
      move_inventory: mcpAction({
        op: inventoryContract.ops.moveEntries,
        destructive: true,
        project: (output) => respondList(output.items, slimInventory),
        output: inventoryMcpBulkMoveOut,
        description:
          "Move inventory entries to per-item destination locations in one atomic call. Each item names an entry and where it should end up, so one call can fan a location out across many, consolidate many into one, or both. Omit an item's quantity to move the whole entry; include it for a partial move, and list one entry twice to split it across destinations. Entries merge into an existing entry for the same product at the destination. The source location is not asked for — an entry already knows where it is.",
      }),
      repoint_project_uses: mcpAction({
        op: projectContract.ops.repointUses,
        description: `Move a Product's recorded project uses onto another Product, in one transaction — how to retire or split a Product that entity.delete refuses because it has project-use history: repoint the history onto the component or replacement that should carry it, then delete. Do NOT do this as entity.unlink plus entity.link — an unlink whose link is missed discards the project's tool history with nothing to flag it. Omit projectIds to move every live use. Projects that already record the destination keep their existing row and are reported as alreadyPresent, not as an error. The destination must be a live Product in a category that allows project resources (${projectResourceFeatureLabels}).`,
      }),
    },
  },

  search: {
    description: "Search across every indexed entity at once.",
    actions: {
      global: mcpAction({
        op: searchContract.ops.global,
        description:
          "Fast name, alias, identifier, and shortcode search across Cubby entities. Pass entityKinds to restrict results. Every hit carries its public shortcode in id, ready for entity_read.get. This lexical lookup never calls an embedding provider. Set includeRelated only when useful; semantic results come back separately and never replace direct matches. For entity-to-entity matching use search.similar.",
      }),
      similar: mcpAction({
        op: searchContract.ops.similar,
        description:
          "Products whose stored embedding is closest to one product seed — the only active public similarity direction; other declared pairs stay unavailable until their independent backtests pass. Pass the pair key plus the seed's id; results are nearest first with cosine similarity and the resolved source ref. Similarity ranks candidates but never verifies a match. Returns no results when the seed is uncomputed, stale, or embeddings are unavailable.",
      }),
    },
  },

  usda_food: {
    description:
      "USDA FoodData Central records, the external nutrition source a Product maps to by `fdc_id`.",
    actions: {
      search: mcpAction({
        op: usdaFoodContract.ops.search,
        openWorld: true,
        project: (output) => ({
          meta: {
            pageIndex: output.meta.pageIndex,
            pageSize: output.meta.pageSize,
            totalCount: output.meta.totalCount,
          },
          items: output.items.map(slimUsdaFoodListItem),
        }),
        output: usdaFoodMcpListOut,
        description:
          'Use this when the user needs to choose among USDA records for Product nutrition mapping. The interactive picker shows the search, source type, macros, and existing Cubby links and lets the user refine before choosing — wait for their "Use this" choice instead of reproducing every result in prose. Do not invoke it when the Cubby Product already has a resolved USDA food or for a general nutrition question that does not require record selection.',
      }),
      get: mcpAction({
        op: usdaFoodContract.ops.byFdcId,
        openWorld: true,
        project: usdaFood,
        output: usdaFoodLookupOut,
        description:
          "One USDA food by its FDC id, with compact nutrients-per-100g and any linked Cubby products.",
      }),
      find: mcpAction({
        op: usdaFoodContract.ops.find,
        openWorld: true,
        project: usdaFood,
        output: usdaFoodLookupOut,
        description:
          "One USDA food by barcode (UPC/GTIN, 12-14 digits) or NDB number; provide exactly one.",
      }),
      suggest_for_product: mcpAction({
        op: usdaFoodContract.ops.suggestForProduct,
        openWorld: true,
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
        description:
          'USDA foods that plausibly describe one Cubby Product (`productId` shortcode), best evidence first: an exact barcode hit (`reason: "upc"`), then a name + manufacturer search (`name_manufacturer`), then the bare name (`name`, only when the qualified search found nothing). `currentFdcId` is the Product\'s existing link, if any. Advisory: it never links anything; set `fdc_id` with entity.update after choosing, and treat a `name` match as a lead to confirm, not an identity.',
      }),
    },
  },

  project_overview: {
    description: "Household project, budget, tool, and spend rollups.",
    actions: {
      house_status: mcpAction({
        op: projectContract.ops.houseStatus,
        description:
          'What needs attention around the house, in one call: portfolio counts (active projects, open tasks, actual vs committed spend), the active projects with own + subtree rollups, a per-project task-status breakdown, the next upcoming tasks, and `attention[]` — overdue tasks, stalled projects, past-due planned expenses, missing budgets, unclassified expenses and blocked work, each with a severity, the entity it points at, and a link. Start here for "how are the projects going" / "what should I deal with", then drill in with entity_read.get(project) or list(task). Optional filters scope it to a status set, project kinds, locations, a search term, or a date window (dateFrom/dateTo — a project matches when its startDate/endDate override overlaps the window OR it has a task or expense of its own inside it; only projects with no override and no dated content are dropped, counted in hiddenByDate.projects). statusScope defaults to the live statuses (planning/not_started/in_progress) so this payload does not balloon with completed history — pass statusScope explicitly (e.g. ["done"]) to include finished projects.',
      }),
      budget: mcpAction({
        op: projectContract.ops.budget,
        description:
          "Which projects are over budget: per project, the subtree budget estimate vs actual + committed spend, with remaining, percentUsed and an overBudget flag, worst overrun first (unbudgeted projects last), plus portfolio totals and planned-vs-actual spend by month. Same optional scope filters as house_status, but statusScope defaults to no condition (all four statuses, including done) — a budget read silently omitting completed spend would be a bug. dateFrom/dateTo scope the whole query, not just the monthly series: while a window is set a project is kept when its startDate/endDate override overlaps it OR it owns a task or expense inside it.",
      }),
      contribution: mcpAction({
        op: householdContributionContract.ops.project,
        description:
          "Whole-group cost, initial funding, consumption, and attribution gaps for one Project, optionally including descendants. Includes planned future Expenses and excludes later household-wide transfers.",
      }),
      tool_suggestions: mcpAction({
        op: projectContract.ops.toolSuggestions,
        description:
          "Inventoried Cubby tools to link to one exact project: tools purchased for the project at $100+ and trade-matched tools whose purchase history supports the project's task/expense trades; cheaper trade matches need at least two explicit prior project uses. A review queue only — it never links tools automatically.",
      }),
      product_uses: mcpAction({
        op: productContract.ops.projectUses,
        description:
          "Every exact project on which a reusable tool or software Product is explicitly recorded as used. Tool rows include purchase/use economics; software rows include non-additive spend charged during each project's effective window.",
      }),
      expense_analytics: mcpAction({
        op: expenseContract.ops.analytics,
        strict: true,
        description:
          "Spend aggregates over the expense ledger under the same filters as entity_read.list(expense) (lineKind/costType/trade/projectId/includeSubProjects/future/search/notesSearch/urlSearch/dateFrom/dateTo/costMin/costMax/costPresenceFilter/projectPresenceFilter/vendorId/orderId), so ledger and analytics totals always agree. Returns summary (all line kinds), adjustments (the signed non-principal aggregate), principal-only byCostType/byTrade/trade x costType, and all-kind monthly, cumulative, byProject, and byVendor totals. summary.net = sum(Expense.cost); reconcile a category or trade total to it by adding adjustments.net. Credits are real (refunds and price adjustments) — net = actual + committed − credits, and cost bounds are signed, so costMax: 0 is the credits-only window. byProject and byVendor are INNER joins and deliberately do NOT sum to summary.net: byProject drops expenses with no project, byVendor rows with no purchase. Read each gap as the size of that unattributed tail, not as a bug.",
      }),
    },
  },

  tasks_overview: {
    description: "Task backlog reads across the whole tracker.",
    actions: {
      actionable: mcpAction({
        op: taskContract.ops.listActionable,
        description:
          "Unblocked tasks you can act on now — live, not done, and blocked by nothing — plus blocked tasks with transitive why-chains explaining what's in the way (a manual blocked flag, a blocking task, or a blocking project, nearest blocker first).",
      }),
      summary: mcpAction({
        op: taskContract.ops.summary,
        description:
          "Task counts in one cheap call: totalOpen, next (unblocked and actionable now), later, inbox (no project), overdue, dueThisWeek (rolling 7 days), blocked. Size the backlog before paging entity_read.list(task).",
      }),
    },
  },

  recipe_insights: {
    description:
      "Recipe nutrition, costing, availability, and reverse lookups, plus parsing a recipe URL without saving it.",
    actions: {
      nutrition: mcpAction({
        op: recipeContract.ops.nutrition,
        description:
          "Recipe nutrient totals scaled to a requested serving count, plus mapped-line coverage and compact reasons for unmapped lines. Refuses a recipe with no effective serving basis instead of guessing.",
      }),
      costing: mcpAction({
        op: recipeContract.ops.costingExplanation,
        description:
          'A recipe\'s cost/calorie totals with per-ingredient diagnostics. `detail: "lines"` (default) drops the two full nutrient-totals blocks and the drift record and returns only the per-line diagnostics plus a cost/kcal coverage headline — use it when hunting the uncovered line, not the number.',
      }),
      cookable: mcpAction({
        op: suggestionsContract.ops.getMakeable,
        project: (output) => ({ recipes: output.recipes }),
        output: recipeAvailabilityMcpOut,
        description:
          "Recipes ranked by planning coverage. Coverage distinguishes recorded inventory from ingredients marked usually on hand; quantity and blocked-sub-recipe warnings remain visible.",
      }),
      using_ingredient: mcpAction({
        op: ingredientContract.ops.recipeUsages,
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
        description:
          "Reverse lookup: every recipe that uses an ingredient, with each line's `lineId` for recipe_import.patch_line.",
      }),
      tags: mcpAction({
        op: recipeContract.ops.tags,
        project: (items) => ({ items }),
        output: mcpItemsEnvelope(recipeTagsOut),
        description: "Every distinct recipe tag in use.",
      }),
      cookbooks: mcpAction({
        op: cookbookContract.ops.list,
        project: (items) => ({ items }),
        output: mcpItemsEnvelope(cookbookContract.ops.list.output),
        description:
          "Cookbooks (recipe sources) with the number of recipes from each.",
      }),
      scrape: mcpAction({
        op: recipeContract.ops.scrapeUrl,
        openWorld: true,
        description:
          "Parse a recipe from a URL into structured form WITHOUT saving it; recipe_import.import saves.",
      }),
    },
  },

  nutrition: {
    description: "Daily intake, meal preparations, and shopping needs.",
    actions: {
      daily_intake: mcpAction({
        op: mealContract.ops.dailyIntake,
        description:
          "One person's daily nutrition with one line per meal and a daily total. Defaults to macros: kcal plus protein/carbs/fat/fiber in grams. Set includeFoods for food breakdowns, or nutrition=full for all nutrients. Uses the target meal's household date, including leftovers and unconfirmed entered portions. Future dates are planned; today/past are logged. No assigned intake returns nutrition=null and meals=[]. Nutrient null means unavailable, pending means not calculated, and partial bounds describe only known contributions (not bounds on missing food). Exact values are numbers; ranges retain lower/upper. No cost or preparation detail is included.",
      }),
      preparations: mcpAction({
        op: mealContract.ops.preparationsDetail,
        description:
          "Recipe preparations made by or served at a meal, including projected and confirmed nutrition. `nutrition` trims every totals block: `full` (default) carries all 22 nutrients, `macros` keeps kcal/protein/carbs/fat/fiber, `kcal` keeps only calories, and `none` keeps cost alone. For per-person daily intake use nutrition.daily_intake.",
      }),
      shopping_list: mcpAction({
        op: mealContract.ops.getShoppingList,
        description:
          "Use this when the user asks what to buy or what they are short on for planned meals in a date range. It compares aggregate recipe needs with recorded inventory. Usually-on-hand ingredients are assumed available, listed separately, and excluded from shopping estimates; assumptions never represent recorded stock. Quantity issues and blocked sub-recipes disclose incomplete information. Do not invoke it to add arbitrary manual household shopping items.",
      }),
    },
  },

  spending_classification_read: {
    description:
      "Review historical spending impact before changing Product Category mappings, Vendor defaults, or explicit Expense categories, or merging Spending Categories.",
    actions: {
      preview: mcpAction({
        op: spendingClassificationContract.ops.preview,
        readPolicy: "strong",
        description:
          "Nonmutating historical impact preview. Supply one complete Product Category mapping, Vendor spending policy, selected Expense category assignment/reset, or Spending Category merge (`spendingCategoryMerge` with keepId and mergeIds; entity.merge refuses one that moves Expense history). Returns signed exact-cent category totals and deltas including shared adjustments, unknown coverage, and a fingerprint. Review before applying; stored source evidence and Expense amounts remain unchanged.",
      }),
    },
  },
  spending_classification_write: {
    description: "Apply reviewed spending classification changes atomically.",
    actions: {
      apply: mcpAction({
        op: spendingClassificationContract.ops.apply,
        description:
          "Apply the exact reviewed request and fingerprint atomically. Refuses when policy or historical facts changed since preview. Mapping changes stay live historically; explicit Expense assignments win and null resets to inheritance. Never creates financial bookings or changes Expense amounts.",
      }),
    },
  },

  finance_read: {
    description:
      "Statement-row, settlement, and contribution-ledger reads, plus expense matching against vendor exports. Financial Transactions are settlement evidence only; all spend is Expense.cost.",
    actions: {
      statement_rows: mcpAction({
        op: statementRowContract.ops.list,
        description:
          "Recorded statement rows with their derived match state. `unmatched` is the drift worklist: a provider row with no live Financial Transaction carrying its source reference. `matched` returns the FTX- shortcode that claims it. `ignored` and `superseded` are off the worklist by an agent's explicit judgment. Eligible unmatched rows may include advisory vendorInference derived from prior settled transactions with the same Merchant label; it neither matches nor links anything. Filter by source, account (FAC- shortcode), match state, disposition, date range, amount range, or a search over the raw statement description. To close an unmatched row, entity.update(financialTransaction) to append its source reference; the row flips to matched on the next read, with no write to the row itself.",
      }),
      summary: mcpAction({
        op: statementRowContract.ops.summary,
        description:
          "Count and total statement rows by match state for a filter — total, matched, unmatched, ignored, superseded, and the unmatched dollar amount. Size the remaining drift before working it, or confirm a bulk disposition landed.",
      }),
      imports: mcpAction({
        op: statementRowContract.ops.imports,
        description:
          "Recorded provider exports, newest first, with rows actually stored versus the count the client declared. A stored count short of the declared one means a chunked ingest was never finished.",
      }),
      drift: mcpAction({
        op: statementRowContract.ops.drift,
        description:
          "Charges recorded TWICE under two identities. A row's identity hash covers its raw description, so a charge re-exported after its descriptor firms up (`AMAZON MKTPLACE PMTS` becoming `AMAZON MKTPL*XD8AR9RG3`) mints a second identity for money already recorded. Groups live, unsuperseded rows by (source, accountDescriptor, statementDate, providerAmount) and returns groups holding more than one, oldest row first so rows[0] is the likeliest predecessor. By default only groups spanning TWO exports are reported: one export speaks one descriptor vocabulary, so two of its own rows differing only in description are two real charges rather than one charge seen twice. Pass includeSameBatch to see them anyway. Still advisory: read the descriptions before acting. The remedy is statement_rows.update with `supersededByExternalId` on the predecessor, an explicit per-row judgment. Superseded rows drop out, so the list shrinks as it is worked.",
      }),
      preview_import: mcpAction({
        op: financialTransactionContract.ops.previewStatementImport,
        readPolicy: "strong",
        description:
          "Preview client-parsed Monarch statement rows before recording settlement evidence. Normalized rows only — never a CSV path, upload, or file contents; at most 200 rows. Monarch charges are negative in the export and are normalized to positive Cubby outflows; credits become negative. The preview derives a stable source reference from account/date/amount/original statement, resolves an existing Financial Account only when unambiguous, and returns already_recorded, ready_to_create, possible_existing, unresolved_account, or indistinguishable_duplicate per row. Eligible rows may include advisory vendorInference from prior settled transactions with the same Merchant label; it neither matches nor links anything. Unresolved rows include a non-persisted provisional Account suggestion. It never creates Accounts, Financial Transactions, Purchases, or links: create only user-approved ready_to_create rows afterwards with entity.create(financialTransaction), then review every result.",
      }),
      transfer_pairs: mcpAction({
        op: householdContributionContract.ops.transferPairs,
        description:
          "A candidate worklist pairing selected Financial Transaction evidence with opposite-signed, different-account matches. Suggestions never create Ledger Transfers, attach evidence, or decide a match; review each candidate before using standard mutations.",
      }),
      contribution_ledger: mcpAction({
        op: householdContributionContract.ops.ledger,
        description:
          "The household-wide contribution ledger as of a date (today when omitted). Positions include Expenses and Ledger Transfers dated through that day; evidence-gap counts describe currently attached Financial Transaction evidence. Never records attribution, transfers, or evidence.",
      }),
      expense_match: mcpAction({
        op: expenseContract.ops.match,
        description:
          "Rank existing ledger rows as candidate matches for lines of a vendor export (an Amazon takeout row, an eBay OrdersReport line, a receipt). Pass up to 200 rows, each with your own `key` plus `date` and a SIGNED `amount`, optionally `label`, `orderId` and `vendor`. Returns, per key, up to `maxCandidatesPerRow` candidates carrying expenseId/name/cost/date/vendorName/orderId/projectName/productName plus the evidence to judge them: `matchedOn` (order_id | amount_date), `dayDelta`, `amountDelta`, `ratio`, `ratioLabel` and `tokenOverlap`; also `unmatched` keys and a summary. " +
          "It RANKS candidates, it does not VERIFY them, and it never writes. Run it BEFORE proposing any new expense, and again over each row you did create (same amount, ±30 days) to catch what slipped through; confirm every match with the user before entity.update(expense) or entity.create(expense). " +
          "Read `tokenOverlap` as a hint and NOTHING more: zero overlap is routine on TRUE matches because this ledger names the THING, not the product (a Festool vacuum is booked as `dust extractor`), and tokenizers miss compound words (`labelmaker` vs 'label maker'). High overlap on a coincidental amount is not evidence either. " +
          "**Below about $20, READ the line descriptions before accepting anything** — small amounts are inside any usable band by construction. Genuine matches cluster at `dayDelta` 0–1; candidates scattered across a ±14d window are usually coincidences. " +
          "`ratioLabel` classifies cost/amount against `taxRate` as exact | plus_tax | pre_tax | other; it LABELS, it does not match. Read the raw `amountDelta` on an `other` — a residual of exactly 9.99 or 12.50 is shipping. " +
          "**Always pass `orderId` when the export line has one — and `vendor` with it.** An order id is only unique WITHIN a vendor. Each candidate reports `vendorMatch`: true (agrees), false (CONFLICTS — almost certainly the wrong row; demoted below every amount+date candidate but still returned), or null (unknown). The order-id arm catches both directions of the aggregate problem — a ledger row may AGGREGATE several export lines, or hold the SPLIT while you search for the total — and ignores the day window on purpose. " +
          "An empty `candidates` list means 'nothing within the window', NOT 'this expense is missing'. Rows with no cost or no date are outside every amount window. Planned (`future: true`) rows are included and flagged. When one ledger row is the best candidate for two export lines it is returned for both — resolve that yourself.",
      }),
    },
  },

  imports_read: {
    description:
      "Import-run and enrichment reads: purchase-import operation status, one run's live status and target outcomes, vendor coverage, what a targeted or charge-search run would use, photo-run context and proposals, image processing, external-id collisions, and barcode lookup.",
    actions: {
      purchase_status: mcpAction({
        op: purchaseImportContract.ops.operationStatus,
        description:
          "The durable status and original result of one stable purchase-import operation id. Use it after an interruption instead of inventing a new id or blindly repeating a write.",
      }),
      vendor_coverage: mcpAction({
        op: vendorContract.ops.coverage,
        description:
          "Vendor identity, its latest live purchase date overall, and sorted unique non-null order IDs from an inclusive date range.",
      }),
      run_status: mcpAction({
        op: runContract.ops.workSnapshot,
        // A finding's row id and proposed fix are private handles for the
        // member's review screen; an agent reads the finding and whether a
        // fix exists.
        project: (output) => ({
          ...output,
          findings: output.findings.map(
            ({ id: _id, proposedFix, ...finding }) => ({
              ...finding,
              hasProposedFix: proposedFix !== null,
            }),
          ),
        }),
        output: runContract.ops.workSnapshot.output.extend({
          findings: z.array(
            runContract.ops.workSnapshot.output.shape.findings.element
              .omit({ id: true, proposedFix: true })
              .extend({ hasProposedFix: z.boolean() }),
          ),
        }),
        description:
          "One Run's live state: status, counts, findings, each target's outcome (`warning` holds a skip's reason), the agent's progress history, and its browser and write operations. Read this to follow a run instead of polling entity_read.",
      }),
      sync_plan: mcpAction({
        op: runContract.ops.syncPlan,
        description:
          "Preview browser sync for the current member's enabled accounts, optionally one Vendor account. Shows first sync, incremental cursor, resumable work with progress, or the run blocking sync. Advisory: starting rechecks admission.",
      }),
      run_launch_preview: mcpAction({
        op: runContract.ops.targetedLaunch,
        description:
          'What run.start would use for one target, without starting anything. `purpose: "product_enrichment"` with a Product shortcode returns `products[0]`: its `sourceId` (the newest import source claim of a Purchase that bought it) and `reason` when none exists — a Product with no import source cannot be enriched by a run. `purpose: "purchase_validation"` with a Purchase shortcode returns its replayable `sources`; the `default` one is the usual choice, and none means the run searches Gmail, then an owned browser account.',
      }),
      charge_hunts: mcpAction({
        op: vendorContract.ops.chargeHunts,
        description:
          "One Vendor account's open, unallocated statement charges that a browser run can search for — the candidates for run.start_charge_run. A charge is selectable when `reason` is null; otherwise `reason` says why not, and `runId` names the unfinished run that already holds it.",
      }),
      photo_context: mcpAction({
        op: photoImportContract.ops.runContext,
        description:
          "One photo-inventory run's owner, notes, and one page of its photos in shot order with their cloud descriptions and recognized text. Pass `nextCursor` back as `cursor` until it is null; an item photographed across a page boundary continues on the next page. Set `withImageUrls` only if you can open images. Read this before proposing groups.",
      }),
      photo_candidates: mcpAction({
        op: photoImportContract.ops.productCandidates,
        description:
          "Existing Products for a photo group, before proposing a new one: name/variant candidates and whether each has a purchase, own photo, earlier photo import, or inventory. Compare exact size and color yourself; the rank is not proof and human approval is required to attach photos.",
      }),
      photo_proposals: mcpAction({
        op: photoImportContract.ops.proposals,
        description:
          "A photo-inventory run's proposed, committed and discarded item groups, including any name-collision `conflict` or `lastError` from a failed approval, and the pending images no proposed group mentions yet.",
      }),
      image_processing: mcpAction({
        op: imageProcessingContract.ops.status,
        description:
          "An image's durable description and transparent-cutout processing status.",
      }),
      external_id_collisions: mcpAction({
        op: productContract.ops.externalIdCollisions,
        description:
          "Who owns each exact (source, kind, externalId) Product identifier, in request order, including missing slots. An identifier has at most one live owner. Pass productId — the product you are about to write these onto — and `unique` splits into `owned_by_this` and `owned_by_other`; without it, `unique` only means the id has ONE live owner, which reads as a clean pass even when that owner is a different product.",
      }),
      upc_lookup: mcpAction({
        op: productContract.ops.lookupUpc,
        openWorld: true,
        project: (output) => ({
          ...output,
          localProduct: output.localProduct
            ? slimProduct(output.localProduct)
            : null,
        }),
        output: productLookupUpcOut.extend({
          localProduct: productMcpOut.nullable(),
        }),
        description:
          "Resolve a UPC barcode to an identity WITHOUT creating anything: the Product already claiming the barcode, the USDA branded-food match, and the UPC lookup service's record, all at once. Use it whenever the question is what a barcode names — verifying a scan, confirming a product page describes the item you hold, or telling a bare tool from the kit it ships in. A barcode identifies the PACKAGE, so a kit and its bare-tool variant carry different UPCs; a manufacturer page reached by guessing a URL from a barcode is not evidence. Prefer this over upc.find_or_create unless you intend to create a Product.",
      }),
    },
  },

  activity: {
    description: "What changed recently, and what needs fixing.",
    actions: {
      recent: mcpAction({
        op: auditLogContract.ops.list,
        description:
          'Recent changes across the app, newest first — the audit trail every create/update/delete writes. Each entry has the entityKind + public shortcode entityId touched, the action, a per-field `changes` map (from → to), who did it (`user`), how the write arrived (`channel`: `web`, `api` for API keys and the Apple app, `mcp`, `caldav`, or `system` for crons and retries), the MCP OAuth client (`oauthClient`), the Apple install (`device`), the Run it belonged to (`runId`, a RUN- shortcode), and createdAt. Filter by entityKind and/or entityId for one entity\'s history; by `channel` (one value or an array), `oauthClient`, `deviceId` (DEV-) or `runId` (RUN-) to isolate what one client, install, import or agent run touched; by `createdAtFrom`/`createdAtTo` (inclusive ISO date-string bounds) for a time window — these AND with cursor pagination, so pass a window on its own for "what happened last Tuesday". Page with cursor (pass back nextCursor).',
      }),
      problems: mcpAction({
        op: problemsContract.ops.report,
        readPolicy: (input) =>
          problemReportWantsCounts(input) ? "strong" : "context",
        description:
          'Data-quality problems and optional coverage backlogs across products, inventory, locations, recipes, and vendors, plus household-tracker items needing attention (overdue tasks, stalled/blocked projects, past-due planned expenses, missing budgets, unclassified expenses). countsOnly=true is the cheap triage; type="duplicateInventory" finds unique Products stored in more than one location; type="purchasesNotReconciling" holds only the unexplained Purchase differences.',
      }),
    },
  },

  statement_rows: {
    description:
      "Durable provider statement evidence. These actions never resolve an account, link a Purchase, create a Financial Transaction, or declare two rows the same charge; match state is derived at read time.",
    actions: {
      record: mcpAction({
        op: statementRowContract.ops.record,
        description:
          "Record client-parsed provider statement rows verbatim, as the evidence Cubby is reconciled against. NOT an importer: it creates no Financial Account, no Financial Transaction and no Purchase link, and makes no match. Normalized rows only — never a CSV path, upload, or file contents. At most 500 rows per call; the batch is found-or-created by (source, fingerprint), so chunking one export across calls is expected. The server derives each row's stable identity from account/date/amount/description, so re-submitting the same export inserts nothing and returns every row as unchanged. `providerAmount` is the export's own signed figure (Monarch signs charges negative); Cubby's outflow-positive amount is derived from it. Set `dateKind` to whichever date the export carries. `dryRun: true` derives the identities and reports what a real call would insert without writing — the only way to learn whether a chunk was already recorded.",
      }),
      update: mcpAction({
        op: statementRowContract.ops.update,
        description:
          "Write judgments onto statement rows; the provider's own columns are immutable after ingest. Address rows by {source, externalIds} for a handful, or by {filter} for a bulk pass (an empty filter is refused). Set disposition 'ignored' with both a reason and a note to take rows off the worklist permanently — the intended move for the large tail of consumer spend Cubby does not model. `accountId` records which account a row belongs to, and `supersededByExternalId` links a pending row to the posted row that replaced it (superseding requires the explicit id selector).",
      }),
      delete: mcpAction({
        op: statementRowContract.ops.delete,
        destructive: true,
        description:
          "Soft-delete statement rows. Rare by design: a row that will never match should be dispositioned 'ignored' with its reasoning, which keeps the evidence and the audit trail. Delete only rows that should never have been recorded, such as a mis-parsed export.",
      }),
    },
  },

  purchase_import: {
    description:
      "The purchase agent's bounded import writers: prepare, validate, and commit one immutable import plan; confirm a merchant's Vendor; reclassify a Purchase document.",
    actions: {
      prepare: mcpAction({
        op: purchaseImportContract.ops.prepare,
        description:
          "Persist an immutable proposed purchase import for the authenticated run. Returns stable order and line ids plus existing Product candidates. Never writes Purchases, Expenses, or Products.",
      }),
      validate: mcpAction({
        op: purchaseImportContract.ops.validate,
        description:
          "Compare an immutable prepared plan to its live Purchase. Records a target diff and never invokes the import writer, source claims, attachments, or audit repair.",
      }),
      commit: mcpAction({
        op: purchaseImportContract.ops.commit,
        description:
          "Commit one exact previously prepared purchase import. Supply a deliberate defaultTrade, or a defaultProjectId whose effective defaults provide a trade, for principal lines. Every principal line maps to an existing Product shortcode, an explicit new Product, or unresolved; unresolved lines create a finding and stop the run for review — never a speculative Product. Replay-safe; rechecks targets and evidence.",
      }),
      confirm_vendor: mcpAction({
        op: purchaseImportContract.ops.confirmMerchantVendor,
        description:
          "Confirm that one exact statement merchant descriptor belongs to a Vendor for the authenticated household member. This durable mapping enables charge-driven purchase and receipt hunts; a later call replaces the mapping for that exact normalized descriptor.",
      }),
      reclassify: mcpAction({
        op: purchaseContract.ops.reclassifyDocument,
        description:
          "Reclassify one existing attachment on a Purchase. Primary evidence is exactly order_confirmation, sales_order, invoice, or receipt; payment receipts, credits, returns, quotes, estimates, contracts, statements, specifications, and other files stay useful but do not satisfy primary_document completeness. Returns the Purchase with freshly computed dataQuality.",
      }),
    },
  },

  expenses: {
    description:
      "Re-attribute existing Expense money within purchases. Neither action creates money or moves it to another vendor.",
    actions: {
      link_to_purchase: mcpAction({
        op: purchaseContract.ops.link,
        description:
          "Re-parent existing Expenses onto ONE existing purchase — e.g. one plumbing transaction that spans both rough-in and fixtures. Only rewrites `purchaseId` on the given expenses: no cost/trade/costType/project changes, and the target purchase's identity (vendorId/orderId/date/statedTotal/documents) stays untouched aside from gaining those expenses. NOT for payment schedules: a contractor's progress payments are separate transactions and therefore separate purchases; use the Project rollup for that view. Refuses when `purchaseId` is not a live purchase.",
      }),
      split: mcpAction({
        op: purchaseContract.ops.splitWithDelta,
        description:
          "Split ONE Expense into 2–100 Expenses on the SAME purchase — how an aggregate record (a combo kit or multi-item receipt entered as one Expense) gets a real per-product cost basis; a product whose only Expense is inside an aggregate has NO cost basis until it is split out. Each part gets its own name/cost/costType/trade/projectId/productId/productQuantity; productQuantity is SIGNED, and zero only on a negative-cost part. Omitted notes inherit the original's; explicit null clears them for that part. URL, date and future state are preserved. Give each part its own real name — never the old `(combo, saw portion)` naming convention. " +
          "When the original has a recorded cost, the parts must sum to it exactly or the split is refused without replacing the original; record a purchase-level discount or refund as its own Expense instead. The response confirms `originalCost`, `partsSum`, and a zero `delta` (null for an unpriced original). The original is soft-deleted and every part lands on its `purchaseId`; with no `statedTotal`, one is seeded from the original's cost. Refuses when the Expense has no purchase — entity.update(expense) with a `vendor` (and `orderId` if known) first.",
      }),
    },
  },

  product_enrichment: {
    description:
      "Source-backed Product identity writes: fill-only enrichment, approved overwrites, identifier slots, image integrity, and match proposals.",
    actions: {
      commit: mcpAction({
        op: purchaseImportContract.ops.commitProductEnrichment,
        description:
          "Apply a bounded, fill-only Product enrichment to one explicit target. Price, attachments, source claims, identifier reassignment, and populated-field overwrites are forbidden.",
      }),
      skip: mcpAction({
        op: purchaseImportContract.ops.skipProductEnrichment,
        description:
          "Close one enrichment target without writing anything, with the reason (no exact source page proves this variant; retired, bundle-only, or ambiguous). The run then claims its next Product; a Product a run committed or skipped is not swept again.",
      }),
      overwrite: mcpAction({
        op: purchaseImportContract.ops.overwriteProductEnrichment,
        description:
          "Propose one populated manufacturer, category, or model replacement. Every call pauses for exact typed human approval and revalidates the Product before applying.",
      }),
      verify_images: mcpAction({
        op: productContract.ops.verifyImages,
        project: slimProductDetail,
        output: productMcpDetailOut,
        // Each item fans out to one R2 fetch PER attached file, so this is the
        // one batch capped below 50; the refreshed image state is the whole
        // point of the call, so results default to full.
        batch: {
          maxItems: 20,
          resultDetail: "full",
          reference: (item) => item.id,
          uniqueIds: true,
        },
        description:
          'For up to 20 products (`items: [{id:"PRD-2ABC"}]`, not {ids}) in request order, fetch every attached Product file from R2, backfill legacy integrity metadata, and record available, missing, or metadata-mismatch state; each result is the refreshed detailed Product. Ordinary entity_read.get(product) makes no R2 requests.',
      }),
      propose_match: mcpAction({
        op: recommendationsContract.ops.proposeProductMatch,
        description:
          'Propose that two Products are the same real item, for a person to review and merge in the product match queue. Use it when you hold evidence the automatic detector cannot see — typically a photo-created Product (e.g. "Gray crew t-shirt — M", stocked, never bought) and a purchase-created Product for the same item, confirmed against the vendor\'s product page. Never merges anything: it records the pair with your evidence, ranked above detector suggestions. Re-proposing the same pair (either order) replaces the evidence; a pair the person dismissed stays dismissed and comes back with state "dismissed".',
      }),
      patch_external_ids: mcpAction({
        op: productContract.ops.patchExternalIds,
        project: slimProductDetail,
        output: productMcpDetailOut,
        batch: { reference: (item) => item.id, uniqueIds: true },
        description:
          "Patch named (source, kind) identifier slots on up to 50 products (`items`) in request order, without replacing unrelated identifiers. A slot holds ONE primary plus any number of secondaries — Amazon lists one item twice, so a product legitimately carries two ASINs. An upsert replaces the primary; pass isPrimary: false to add an identifier alongside it, addressed by its own value. Every removal must include the exact current external ID, an item's preconditions are all checked before it changes anything, and removing a primary promotes the oldest surviving secondary. A failed item does not roll back successful items. Check imports_read.external_id_collisions before adding identity.",
      }),
    },
  },

  upc: {
    description: "Barcode-driven Product creation.",
    actions: {
      find_or_create: mcpAction({
        op: productContract.ops.findOrCreateByUPC,
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
        description:
          "Find or create a product by UPC barcode: the local DB, then USDA, then the UPC lookup service. This WRITES — it mints a Product when nothing matches, named by whatever the lookup returned. To only ask what a barcode names, use imports_read.upc_lookup.",
      }),
    },
  },

  photo_run: {
    description:
      "A photo-inventory run's item grouping: propose groups for human review, or commit one when the user asks to skip review.",
    actions: {
      propose_groups: mcpAction({
        op: photoImportContract.ops.proposeGroups,
        description:
          "Propose how a run's images group into items, for a human to review and approve on the run page — nothing is written to Products or Inventory until approval, which runs photo_run.commit_group with each group's payload. Each group has commit_group's shape (minus runId) plus optional `evidence` (why these photos are one item, and why this Product). Upserts by groupKey: a still-`proposed` group is replaced; a `committed` or `discarded` groupKey is left untouched and returned in `frozenGroupKeys`. `removeGroupKeys` drops proposed groups. Every image must be a `pending` target of the run and, across the run's proposed groups after this call, appear in exactly one group (attached or skipped) — otherwise the whole call is refused. Returns every proposal plus the pending images no group mentions yet.",
      }),
      commit_group: mcpAction({
        op: photoImportContract.ops.commitGroup,
        description:
          'The bounded writer approval runs. Prefer photo_run.propose_groups and let the user approve on the run page; call this only when the user explicitly asks to skip review. Turns one group of already-staged images into one Product (an existing Product by id, or a genuinely new one) with each image attached under an `item` or `label` purpose, and optionally one Inventory entry. Idempotent per (runId, groupKey): the exact same call replays the prior result; a changed payload under the same groupKey is refused unless the earlier attempt failed. When a `create` name or alias exactly (case-insensitively) matches a live Product, nothing is written and the call returns `outcome: "conflict"` with the colliding Product ids — never a speculative new Product. Every listed image must be a `pending` target of the run and appear in exactly one of `images` (attach) or `skip` (with a reason); a skip-only group touches no Product. Marks the run `completed` once no `pending` target remains.',
      }),
    },
  },

  run: {
    description:
      'Start a Cubby run. The run\'s coordinator does the work and reads pages through the signed-in browser of the household\'s Mac app, so a run may wait for a connected Mac before it progresses. Each start returns a RUN- shortcode: poll entity_read.get with entity "run" and resultDetail "full" on it until `status` is terminal (completed, failed, needs_review, or dispatch_failed); paused_* statuses are waiting (paused_offline: for the Mac), not finished.',
    actions: {
      lifecycle: mcpAction({
        op: runContract.ops.lifecycle,
        openWorld: true,
        strict: true,
        description:
          "Control an owned Run with controlAction cancel, retry or restart. Cancel stops active work; retry/restart preserve the previous attempt and return its admitted successor. Repeated research retries reuse the same successor. These controls do not approve or reject findings, grant paid budgets, or verify unfinished targets. Read imports_read.run_status for available controls and current outcomes; unsupported lifecycle states refuse without changing the Run.",
      }),
      start: mcpAction({
        op: runContract.ops.startTargeted,
        // The run browses the Vendor's site through the Mac's browser.
        openWorld: true,
        description:
          'Start a targeted run. `purpose: "product_enrichment"` with `targets` (each a Product shortcode and the `sourceId` from imports_read.run_launch_preview; the run browses with the Vendor\'s browsing account) verifies identity facts and images from the Vendor\'s pages; targets are grouped into one run per Vendor account. `purpose: "purchase_validation"` with a `purchaseId` and a `sourceId` (a source id from imports_read.run_launch_preview, or `sourceId: null` when none is chosen) re-reads one Purchase\'s order against its source. Returns one entry per run: `created: true` with `run` (id, status) for a new run, or `created: false` with `blockingRun` when that Vendor account already has an active run — nothing is queued then; poll or wait for the blocking run and start again. Repeating a start while its run is active returns that run as `blockingRun`; a start with no Vendor account is blocked by an active run of the same purpose on the same target.',
      }),
      start_sync: mcpAction({
        op: runContract.ops.startSync,
        openWorld: true,
        description:
          "Start or resume browser sync for one owned, enabled Vendor account. Optional backfill supplies inclusive from/to calendar dates. Returns runId and resumed. Other purposes and selected charge searches block admission.",
      }),
      start_charge_run: mcpAction({
        op: vendorContract.ops.startChargeRun,
        // The run searches the Vendor's site through the Mac's browser.
        openWorld: true,
        description:
          "Start one browser run that searches a Vendor account's order history for up to 50 selected statement charges (FTX- ids from imports_read.charge_hunts with a null `reason`). The account must have browser sync enabled. All or nothing: a selected charge that is settled, not searchable, or already on another unfinished run, or an account that already has an active run, refuses the whole call and starts nothing. Returns `runId`.",
      }),
    },
  },

  meal_recipe: {
    description:
      "Planned recipes within meals. `add` returns a `mealRecipeId`; update/remove/save_preparation take that occurrence id, never the recipe id.",
    actions: {
      add: mcpAction({
        op: mealContract.ops.planRecipe,
        description:
          "Plan a recipe into a meal at a scale multiplier (1 = as written). Returns compact meal identity plus cost/kcal coverage. Nutrition defaults to none; request kcal, macros, or full when needed.",
      }),
      update: mcpAction({
        op: mealContract.ops.updateRecipe,
        project: slimMeal,
        output: mealMcpOut,
        description:
          "Adjust a planned recipe's scale or sort order within its meal.",
      }),
      remove: mcpAction({
        op: mealContract.ops.removeRecipe,
        project: slimMeal,
        output: mealMcpOut,
        description: "Remove a planned recipe from its meal.",
      }),
      save_preparation: mcpAction({
        op: mealContract.ops.savePreparation,
        description:
          "Record measured yield and portions served from one planned recipe occurrence. Assigned portions count in daily intake by the target meal date: future is planned, today/past is logged. Confirmation fields remain for legacy compatibility and do not gate daily intake.",
      }),
    },
  },

  recipe_import: {
    description:
      "Save recipes from a URL or pasted text, and patch one ingredient line in place.",
    actions: {
      import: mcpAction({
        op: recipeContract.ops.importFromUrl,
        openWorld: true,
        description:
          "Scrape a recipe from a URL and save it in one step; returns the new recipe's shortcode and `lineCoverage` (per line, which of price/weight/nutrients are still missing). recipe_insights.scrape parses without saving.",
      }),
      from_text: mcpAction({
        op: recipeContract.ops.createFromText,
        description:
          "Create a recipe from raw text lines WITHOUT pre-resolving ingredient IDs — the path for a pasted prep sheet. Use entity.create(recipe) when you already have ingredient ids. Also returns `lineCoverage`.",
      }),
      patch_line: mcpAction({
        op: recipeContract.ops.patchLine,
        description:
          "Change one recipe ingredient line — its amounts, the ingredient or sub-recipe it points at, or its source text/modifier — without resending the recipe's sections. The line keeps its position and every other line and instruction is left as-is. `lineId` comes from recipe_insights.costing's per-line diagnostics or recipe_insights.using_ingredient's usages. Also returns the recipe's refreshed `lineCoverage`.",
      }),
    },
  },

  image: {
    description:
      "Files and images on gallery records (every entity in the attach schemas, including Garden Entries, meals, and tasks). Covers and vendor logos have their own replacement fields, not gallery targets.",
    actions: {
      create_uploads: mcpAction({
        op: imageUploadContract.ops.createFileUpload,
        batch: { resultDetail: "full", reference: (item) => item.uploadId },
        description:
          "Stage up to 50 LOCAL files (`items`) and get one presigned PUT URL per successful item — how files on disk reach Cubby, since the server is remote and `url` cannot name a local path. Three steps: call this, upload each successful item with `curl -X PUT -H 'Content-Type: <contentType>' --upload-file <path> '<uploadUrl>'`, then image.attach_files with the returned uploadIds. A failed item does not roll back successful presigns; results keep input indexes for retrying only failures. Each staged object is discarded once attached. Supported types: image/jpeg, image/png, image/gif, image/webp, image/avif, image/heic, image/heif, application/pdf.",
      }),
      attach_files: mcpAction({
        op: imageUploadContract.ops.attachFile,
        // `full`, not the compact default: an attach response is a handful of
        // short fields, and `reused` exists so a caller can tell a replay from
        // an upload. Items may target many records, so no duplicate-id guard.
        batch: { resultDetail: "full", reference: (item) => item.imageId },
        // Batch telemetry reads the first item: a batch may mix entities, and
        // first-item attribution beats none for the common single-entity sweep.
        telemetryEntity: (item) => parseShortcode(item.entityId)?.type,
        description:
          "Attach up to 50 files (`items`) in request order; each item carries its own entityId, so one call can cover many records — the cover-image pass of an enrichment sweep. Provide each file exactly one way: `url` (an http(s) link the server fetches) or `uploadId` (from image.create_uploads — the route for a local file). A Purchase attachment requires documentKind. Provide a deterministic idempotencyKey per item so a retry of a partially-failed batch cannot double-attach, and the freshly read expectedImageCount for Product gallery writes (a mismatch is a precondition failure and attaches nothing). MIME/signature conflicts are rejected.",
      }),
      attach_existing: mcpAction({
        op: imageContract.ops.attachExisting,
        telemetryEntity: (input) => parseShortcode(input.targetId)?.type,
        description:
          "Attach an existing uploaded image to a live gallery record without re-uploading it; the target shortcode's prefix names the record. Repeated requests are idempotent and restore a previously soft-deleted link.",
      }),
      correct_description: mcpAction({
        op: imageProcessingContract.ops.correctDescription,
        description: "Save a confirmed correction for an image description.",
      }),
      schedule_processing: mcpAction({
        op: imageProcessingContract.ops.schedule,
        description:
          "Schedule description and/or transparent-cutout processing for an uploaded image.",
      }),
    },
  },

  data_exception: {
    description:
      "Explicit negative knowledge on one completeness check of a Product, Vendor, Purchase, FinancialTransaction, or Expense; each call returns the recomputed dataQuality.",
    actions: {
      set: mcpAction({
        op: dataQualityContract.ops.setException,
        description:
          "Record why a fact is absent or a mismatch is expected. The note is required and should explain why the fact was not issued, is unavailable/not applicable, lacks sufficient detail, or why a mismatch is expected. Upserts by check without duplicates. Only after the available sources have been searched.",
      }),
      clear: mcpAction({
        op: dataQualityContract.ops.clearException,
        description:
          "Clear exactly one explicit exception; any still-missing fact immediately reappears as a gap.",
      }),
    },
  },
});
