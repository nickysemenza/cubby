import {
  aiSmokeInputs,
  aiSmokeRunInput,
  type AiSmokeScenario,
} from "@cubby/schemas/ai-smoke";
import {
  type ImportRunId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  extractedPurchaseLine,
  browserCapture,
  type ExtractedPurchaseLine,
} from "@cubby/schemas/purchase-import";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import {
  auditPurchaseImportBatch,
  extractPurchaseEvidence,
} from "~/server/agents/purchase-import/extract";
import { purchaseExtractionPrompt } from "~/server/agents/purchase-import/prompts";
import { suggestExternalIdKind } from "~/server/ai/external-id-kind";
import {
  ENTITY_EMBEDDING_FEATURE,
  PURCHASE_IMPORT_EXTRACTION_FEATURE,
  PURCHASE_IMPORT_MAIL_FEATURE,
  PURCHASE_IMPORT_PRODUCT_IDENTITY_FEATURE,
  PURCHASE_IMPORT_REPAIR_FEATURE,
  SEMANTIC_QUERY_FEATURE,
  USDA_FOOD_SUGGEST_FEATURE,
} from "~/server/ai/features";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { JEV_MAX_CANDIDATES, runJevChoice } from "~/server/ai/jev";
import {
  runStructuredFeature,
  type StructuredRunPorts,
} from "~/server/ai/run-feature";
import { runAiSelection } from "~/server/ai/selection";
import { getAiClient } from "~/server/clients/ai";
import { aiUsage, image, importRun } from "~/server/db/schema";
import { loadPurchaseAuditBatch } from "~/server/purchase-import/audit-batch";
import {
  chooseLineStage,
  PRODUCT_IDENTITY_RULES,
} from "~/server/purchase-import/writer";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { getUploadedImageProcessingSource } from "~/server/repo/image-processing";
import { getLocationById } from "~/server/repo/location";
import { getProductByID } from "~/server/repo/product";
import { getRecipeByID } from "~/server/repo/recipe";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { ensureRun } from "~/server/runs/ensure-run";
import { embedTexts } from "~/server/semantic/embeddings";
import { suggestIngredientMergeBatch } from "~/server/services/ai-enrichment/ingredient-merge";
import {
  suggestUsdaFood,
  suggestUsdaFoodBatch,
} from "~/server/services/ai-enrichment/usda-match";
import {
  descriptionRequest,
  imageAnalysisRenditionUrl,
} from "~/server/services/image-description.service";
import {
  assessRecipeFlowCandidate,
  flowPromptInput,
} from "~/server/services/recipe-flow/recipe-flow.service";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { finishSmokeAttempt, withSmokeUsage } from "./smoke-attempt";
import { AI_SMOKE_CASES } from "./smoke-catalog";

const purchaseLine = (
  fixture: "standard" | "ambiguous",
): ExtractedPurchaseLine =>
  extractedPurchaseLine.parse(
    fixture === "standard"
      ? {
          title: "Cordless drill kit",
          amount: 79.95,
          quantity: 1,
          sku: "DRILL-20",
        }
      : { title: "Adjustment for returned item", amount: -12.5, quantity: 1 },
  );

const purchaseCapture = (fixture: "standard" | "ambiguous") =>
  browserCapture.parse({
    url: "https://example.com/orders/example",
    title: "Example order",
    text:
      fixture === "standard"
        ? "Order: cordless drill kit $79.95. Total: $79.95 USD."
        : "Order adjustment: $12.50 refund. Other lines unavailable.",
    links: [],
    images: [],
    capturedAt: "2026-01-01T12:00:00.000Z",
  });

async function imageSources(
  db: AuthenticatedStartOperationContext["db"],
  shortcodes: string[],
) {
  const ids = await Promise.all(
    shortcodes.map((code) => resolveOrThrow(db, "image", code)),
  );
  const rows = await getDb(db)
    .select({
      id: image.id,
      key: image.key,
      status: image.status,
      contentType: image.contentType,
    })
    .from(image)
    .where(and(inArray(image.id, ids), notDeleted(image)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (
    rows.length !== ids.length ||
    rows.some((row) => !row.key || row.status !== "UPLOADED")
  )
    throw new Error("Select uploaded images with available source files.");
  return ids.map((id) => {
    const source = byId.get(id)!;
    return { url: getR2PublicUrl(source.key), contentType: source.contentType };
  });
}

async function ingredientSources(
  db: AuthenticatedStartOperationContext["db"],
  shortcodes: string[],
) {
  return Promise.all(
    shortcodes.map(async (code) => {
      const id = await resolveOrThrow(db, "ingredient", code);
      const row = await getDb(db).query.ingredient.findFirst({
        where: (table, { eq }) => eq(table.id, id),
        columns: { name: true },
      });
      if (!row) throw new Error("Ingredient was not found.");
      return {
        id,
        shortcode: parseShortcodeFor("ingredient", code),
        name: row.name,
      };
    }),
  );
}

type CaseResult = { result: unknown; noModelCall?: boolean };
type SmokeJson = z.infer<typeof aiSmokeRunInput>["input"];

// The switch lists caller shapes; each branch delegates its work to a production AI helper.
// eslint-disable-next-line complexity
async function runCase(
  context: AuthenticatedStartOperationContext,
  scenario: AiSmokeScenario,
  raw: SmokeJson,
  runId: ImportRunId,
  structuredPorts?: StructuredRunPorts,
): Promise<CaseResult> {
  const db = context.db;
  switch (scenario) {
    case "fieldSuggestions": {
      const input = aiSmokeInputs.fieldSuggestions.parse(raw);
      const result = await suggestFields(db, runId, input);
      return {
        result,
        noModelCall: Object.values(result.outcomes ?? {}).every(
          (outcome) => outcome.kind === "skipped",
        ),
      };
    }
    case "externalIdKind": {
      const { fixture } = aiSmokeInputs.externalIdKind.parse(raw);
      const input =
        fixture === "barcode"
          ? {
              source: "retailer",
              identifier: "012345678905",
              url: null,
              productName: null,
              manufacturer: null,
            }
          : {
              source: "manufacturer",
              identifier: "DRILL-20",
              url: null,
              productName: "cordless drill",
              manufacturer: "Example Tools",
            };
      return {
        result: await suggestExternalIdKind(input, {
          db,
          runId,
          operation: "smoke.externalIdKind",
        }),
        noModelCall: fixture === "barcode",
      };
    }
    case "usdaFood": {
      const { ingredientId } = aiSmokeInputs.usdaFood.parse(raw);
      const [source] = await ingredientSources(db, [ingredientId]);
      if (!source) throw new Error("Ingredient was not found.");
      const result = await suggestUsdaFood(
        context.usdaService,
        db,
        source.name,
        { runId, ingredientId: source.id },
      );
      return {
        result,
        noModelCall: result.reasoning === "No USDA candidates found.",
      };
    }
    case "usdaFoodBatch": {
      const { ingredientIds } = aiSmokeInputs.usdaFoodBatch.parse(raw);
      const sources = await ingredientSources(db, ingredientIds);
      const result = await suggestUsdaFoodBatch(
        context.usdaService,
        db,
        sources,
        runId,
      );
      return {
        result,
        noModelCall: result.every(
          (item) => item.reasoning === "No USDA candidates found.",
        ),
      };
    }
    case "ingredientMerge": {
      const { ingredientIds } = aiSmokeInputs.ingredientMerge.parse(raw);
      const result = await suggestIngredientMergeBatch(
        db,
        await ingredientSources(db, ingredientIds),
        runId,
      );
      return { result };
    }
    case "selectionOverflow": {
      const { fixture } = aiSmokeInputs.selectionOverflow.parse(raw);
      const candidates = Array.from(
        { length: JEV_MAX_CANDIDATES + 1 },
        (_, index) => ({
          id: `item-${index + 1}`,
          label: `Example item ${index + 1}`,
        }),
      );
      return {
        result: await runAiSelection(
          {
            feature: USDA_FOOD_SUGGEST_FEATURE,
            rules:
              fixture === "standard"
                ? "Choose Example item 1."
                : "Choose none if no item fits.",
            idOf: (c) => c.id,
            renderLine: (c) => `${c.id}: ${c.label}`,
            maxCandidates: candidates.length,
          },
          {
            subject:
              fixture === "standard"
                ? "Find Example item 1"
                : "Find a non-existent item",
            candidates,
            usage: { db, runId, operation: "smoke.selectionOverflow" },
          },
        ),
      };
    }
    case "productIdentification": {
      const { imageIds } = aiSmokeInputs.productIdentification.parse(raw);
      return {
        result: await getAiClient().identifyProduct(
          (await imageSources(db, imageIds)).map((source) => source.url),
          { db, runId, operation: "smoke.identifyProduct" },
        ),
      };
    }
    case "locationDescription":
    case "inventoryDetection": {
      const { locationId } = aiSmokeInputs[scenario].parse(raw);
      const id = await resolveOrThrow(db, "location", locationId);
      const location = await getLocationById(db, id);
      const urls = (location.images ?? []).slice(0, 5).map((item) => item.url);
      if (!urls.length) throw new Error("Select a location with images.");
      const usage = {
        db,
        runId,
        operation: `smoke.${scenario}`,
        entity: { entityType: "location", entityId: id },
      };
      return {
        result:
          scenario === "locationDescription"
            ? await getAiClient().describeLocation(urls, location.name, usage)
            : await getAiClient().detectInventoryItems(
                urls,
                location.name,
                usage,
              ),
      };
    }
    case "imageDescription": {
      const { imageId } = aiSmokeInputs.imageDescription.parse(raw);
      const id = await resolveOrThrow(db, "image", imageId);
      const source = await getUploadedImageProcessingSource(db, id);
      if (!source)
        throw new Error(
          "Select an uploaded image that passed integrity checks.",
        );
      const url = imageAnalysisRenditionUrl(getR2PublicUrl(source.key));
      const { IMAGE_DESCRIPTION_FEATURE } =
        await import("~/server/ai/features");
      return {
        result: await runStructuredFeature(
          IMAGE_DESCRIPTION_FEATURE,
          descriptionRequest(url),
          {
            db,
            runId,
            operation: "smoke.imageDescription",
            entity: { entityType: "image", entityId: id },
          },
          structuredPorts,
        ),
      };
    }
    case "recipeFlow": {
      const { recipeId } = aiSmokeInputs.recipeFlow.parse(raw);
      const id = await resolveOrThrow(db, "recipe", recipeId);
      const recipe = await getRecipeByID(db, id);
      if (!recipe) throw new Error("Recipe was not found.");
      return {
        result: await getAiClient().generateRecipeFlow(
          JSON.stringify(flowPromptInput(recipe), null, 2),
          null,
          {
            db,
            runId,
            operation: "smoke.recipeFlow",
            entity: { entityType: "recipe", entityId: id },
            validate: (plan) => assessRecipeFlowCandidate(recipe, plan),
          },
        ),
      };
    }
    case "purchaseExpenseLineRole":
    case "purchaseKitDetection":
    case "purchaseProductPromotion":
    case "purchaseReversalKind": {
      const { fixture } = aiSmokeInputs[scenario].parse(raw);
      const stage = {
        purchaseExpenseLineRole: "role",
        purchaseKitDetection: "kit",
        purchaseProductPromotion: "promotion",
        purchaseReversalKind: "reversal",
      } as const;
      return {
        result: await chooseLineStage(
          db,
          runId,
          0,
          purchaseLine(fixture),
          stage[scenario],
        ),
      };
    }
    case "purchaseProductIdentity": {
      const { fixture, productId } =
        aiSmokeInputs.purchaseProductIdentity.parse(raw);
      const chosen = productId
        ? await getProductByID(
            db,
            await resolveOrThrow(db, "product", productId),
          )
        : null;
      const line = purchaseLine(fixture);
      const labels = chosen
        ? [
            `${chosen.name} | manufacturer=${chosen.manufacturer || "unknown"} | model=${chosen.model ?? "unknown"}`,
          ]
        : [
            "Cordless drill kit | manufacturer=Example Tools | model=DRILL-20",
            "Garden rake | manufacturer=Example Tools | model=RAKE-10",
          ];
      return {
        result: await runJevChoice({
          feature: PURCHASE_IMPORT_PRODUCT_IDENTITY_FEATURE,
          subject: JSON.stringify({
            title: line.title,
            sku: line.sku ?? null,
            seller: line.seller ?? null,
            productUrl: line.productUrl ?? null,
          }),
          rules: PRODUCT_IDENTITY_RULES,
          choices: labels,
          usage: { db, runId, operation: "smoke.purchaseProductIdentity" },
        }),
      };
    }
    case "purchaseExtraction": {
      const { fixture } = aiSmokeInputs.purchaseExtraction.parse(raw);
      return {
        result: await runStructuredFeature(
          PURCHASE_IMPORT_EXTRACTION_FEATURE,
          purchaseExtractionPrompt(purchaseCapture(fixture)),
          { db, runId, operation: "smoke.purchaseExtraction" },
          structuredPorts,
        ),
      };
    }
    case "purchaseReceipt": {
      const { imageId } = aiSmokeInputs.purchaseReceipt.parse(raw);
      const [source] = await imageSources(db, [imageId]);
      if (!source) throw new Error("Select an uploaded receipt image.");
      return {
        result: await extractPurchaseEvidence({
          db,
          runId,
          evidenceUrl: source.url,
          mediaType: source.contentType,
        }),
      };
    }
    case "purchaseMail": {
      const { fixture } = aiSmokeInputs.purchaseMail.parse(raw);
      const { orderMailRequest } =
        await import("~/server/agents/purchase-import/extract");
      return {
        result: await runStructuredFeature(
          PURCHASE_IMPORT_MAIL_FEATURE,
          orderMailRequest({
            sender: "orders@example.com",
            subject:
              fixture === "standard"
                ? "Your order shipped"
                : "About your order",
            receivedAt: "2026-01-01T12:00:00.000Z",
            content:
              fixture === "standard"
                ? "Order example-1 shipped."
                : "Please contact support.",
          }),
          { db, runId, operation: "smoke.purchaseMail" },
          structuredPorts,
        ),
      };
    }
    case "purchaseAudit": {
      const {
        source,
        fixture,
        runId: sourceRunCode,
      } = aiSmokeInputs.purchaseAudit.parse(raw);
      const renderedBatch =
        source === "run"
          ? await loadPurchaseAuditBatch(
              db,
              await resolveOrThrow(db, "importRun", sourceRunCode ?? ""),
            )
          : [
              {
                id: "example-purchase",
                orderId: "example-1",
                statedTotal: fixture === "standard" ? 79.95 : 80,
                displayLabel: "Example order",
                expenses: [
                  {
                    id: "example-expense",
                    name: "Cordless drill kit",
                    amount: 79.95,
                    lineKind: "principal",
                    quantity: 1,
                    product: null,
                  },
                ],
                paymentEvidence: [],
              },
            ];
      if (renderedBatch.length === 0)
        throw new Error("Select a Run that imported purchases to audit.");
      return {
        result: await auditPurchaseImportBatch({
          db,
          runId,
          renderedBatch,
        }),
      };
    }
    case "purchaseRepair": {
      const { fixture } = aiSmokeInputs.purchaseRepair.parse(raw);
      const { purchaseRepairRequest } =
        await import("~/server/agents/purchase-import/extract");
      return {
        result: await runStructuredFeature(
          PURCHASE_IMPORT_REPAIR_FEATURE,
          purchaseRepairRequest(purchaseCapture(fixture)),
          { db, runId, operation: "smoke.purchaseRepair" },
          structuredPorts,
        ),
      };
    }
    case "semanticQuery": {
      const { fixture } = aiSmokeInputs.semanticQuery.parse(raw);
      const [vector] = await embedTexts(
        [fixture === "standard" ? "cordless drill" : "garden tool"],
        {
          db,
          runId,
          feature: SEMANTIC_QUERY_FEATURE.feature,
          operation: "smoke.semanticQuery",
        },
      );
      return {
        result: {
          dimensions: vector?.length ?? 0,
          sample: vector?.slice(0, 5) ?? [],
        },
      };
    }
    case "entityEmbedding": {
      const { productId } = aiSmokeInputs.entityEmbedding.parse(raw);
      const id = await resolveOrThrow(db, "product", productId);
      const product = await getProductByID(db, id);
      if (!product) throw new Error("Product was not found.");
      const [vector] = await embedTexts(
        [`${product.name} ${product.manufacturer ?? ""}`.trim()],
        {
          db,
          runId,
          feature: ENTITY_EMBEDDING_FEATURE.feature,
          operation: "smoke.entityEmbedding",
          entity: { entityType: "product", entityId: id },
        },
      );
      return {
        result: {
          dimensions: vector?.length ?? 0,
          sample: vector?.slice(0, 5) ?? [],
        },
      };
    }
  }
}

export async function runAiSmoke(
  context: AuthenticatedStartOperationContext,
  scenario: AiSmokeScenario,
  raw: SmokeJson,
  structuredPorts?: StructuredRunPorts,
) {
  // Reject malformed input before opening a Run. Every accepted attempt has a link.
  aiSmokeInputs[scenario].parse(raw);
  const spec = AI_SMOKE_CASES[scenario];
  const runId = await ensureRun(
    context.db,
    { ...context.actorContext, runId: null },
    {
      purpose: "ai_action",
    },
  );
  const [run] = await getDb(context.db)
    .select({ shortcode: importRun.shortcode })
    .from(importRun)
    .where(eq(importRun.id, runId))
    .limit(1);
  if (!run) throw new Error("Smoke Run was not found after creation.");
  const attempt = await finishSmokeAttempt(spec.feature, run.shortcode, () =>
    runCase(context, scenario, raw, runId, structuredPorts),
  );
  const usages = await getDb(context.db)
    .select({
      feature: aiUsage.feature,
      model: aiUsage.model,
      cacheStatus: aiUsage.cacheStatus,
      applicationCacheStatus: aiUsage.applicationCacheStatus,
    })
    .from(aiUsage)
    .where(eq(aiUsage.runId, runId));
  return withSmokeUsage(attempt, usages);
}
