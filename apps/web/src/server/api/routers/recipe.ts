/**
 * Recipe Router - Direct repo access
 *
 * Recipes do not require external API enrichment (e.g., USDA),
 * so they call repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 *
 * The procedures themselves are split across focused sibling modules under
 * `./recipe/` (CRUD, import/export, analysis/costing). This file composes them
 * back into a single FLAT router so client procedure paths (`recipe.list`,
 * `recipe.getByID`, `recipe.import…`) are unchanged.
 */

import { createTRPCRouter } from "../trpc";
import { recipeAnalysisProcedures } from "./recipe/analysis";
import { recipeCrudProcedures } from "./recipe/crud";
import { recipeImportProcedures } from "./recipe/import";

export const recipeRouter = createTRPCRouter({
  // Import / export (scrape, cookbook, Notion sync)
  insertImport: recipeImportProcedures.insertImport,
  upsertCookbook: recipeImportProcedures.upsertCookbook,
  getCookbookSource: recipeImportProcedures.getCookbookSource,
  importCookbookStream: recipeImportProcedures.importCookbookStream,
  getCookbookDiff: recipeImportProcedures.getCookbookDiff,
  previewNotionSync: recipeImportProcedures.previewNotionSync,
  importNotionSyncStream: recipeImportProcedures.importNotionSyncStream,
  listCookbooks: recipeImportProcedures.listCookbooks,
  deleteCookbook: recipeImportProcedures.deleteCookbook,
  reprocessCookbook: recipeImportProcedures.reprocessCookbook,
  extractCookbookChunk: recipeImportProcedures.extractCookbookChunk,
  scrape: recipeImportProcedures.scrape,
  parseHtml: recipeImportProcedures.parseHtml,

  // CRUD + reads
  getByID: recipeCrudProcedures.getByID,
  getByShortcode: recipeCrudProcedures.getByShortcode,
  getManyByIDs: recipeCrudProcedures.getManyByIDs,
  list: recipeCrudProcedures.list,
  create: recipeCrudProcedures.create,
  update: recipeCrudProcedures.update,
  delete: recipeCrudProcedures.delete,
  getAllTags: recipeCrudProcedures.getAllTags,

  // Analysis + costing maintenance
  harvestEquivalences: recipeAnalysisProcedures.harvestEquivalences,
  recomputeAll: recipeAnalysisProcedures.recomputeAll,
  recomputeAllStream: recipeAnalysisProcedures.recomputeAllStream,
  recomputeAllDurable: recipeAnalysisProcedures.recomputeAllDurable,
  recomputeStaleDurable: recipeAnalysisProcedures.recomputeStaleDurable,
  recomputeOne: recipeAnalysisProcedures.recomputeOne,
  dryRunRecomputeTotals: recipeAnalysisProcedures.dryRunRecomputeTotals,
  explainCosting: recipeAnalysisProcedures.explainCosting,
  getIngredientCooccurrence: recipeAnalysisProcedures.getIngredientCooccurrence,
  getDependencyGraph: recipeAnalysisProcedures.getDependencyGraph,
  getIngredientUsage: recipeAnalysisProcedures.getIngredientUsage,
});
