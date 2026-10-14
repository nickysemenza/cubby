import { z } from "zod";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { OpenApiDocument } from "./openapi.ts";
import type { SwiftRoute } from "./swift-routes.ts";

const swiftComponentAlias = (component: string, id: string) => {
  if (!/^[A-Z][A-Za-z0-9]*$/u.test(component))
    throw new Error(
      `${id}: #/components/schemas/${component} has no APITypes.swift alias, so its CubbyClient method must be hand-written`,
    );
  return component;
};

/**
 * `CubbyClient` methods that are exactly one generated call: the operation
 * takes no path parameters, its JSON body or its query object (never both) is
 * the method's only argument, and its 200 body is the result. A query object
 * is the generated `Operations.<Id>.Input.Query`, aliased as
 * `<Method>Query` in the same file so a call site writes
 * `client.runAiUsage(.init(runId: id))` without importing `CubbyAPI`. Keyed by
 * operation id; the value is the public method name call sites use and an
 * optional doc line. Anything that maps, converts, branches or unwraps stays
 * hand-written in `CubbyClient.swift`.
 */
const CLIENT_PASSTHROUGH_METHODS = {
  "chatgpt.authorizationHost": {
    method: "chatGptAuthorizationHost",
    doc: null,
  },
  "chatgpt.connect": { method: "connectChatGpt", doc: null },
  "purchase.products": { method: "purchaseProducts", doc: null },
  "purchase.settlementCandidates": {
    method: "purchaseSettlementCandidates",
    doc: "Unallocated statement entries near an order, already ranked and worded. Advisory: reading allocates nothing.",
  },
  "purchase.suggestSettlementMatch": {
    method: "suggestPurchaseSettlementMatch",
    doc: "An advisory ordering of equally ranked candidates. It never selects or allocates; the person still chooses and saves.",
  },
  "purchase.checkSettlementAllocation": {
    method: "checkPurchaseSettlementAllocation",
    doc: "Whether typed allocation rows can be saved against a statement entry, and why not. The only allocation rule clients consult.",
  },
  "purchase.splitStart": {
    method: "startExpenseSplit",
    doc: "The starting parts of a split, its wording and the sentence to confirm before it replaces the expense.",
  },
  "purchase.checkSplit": {
    method: "checkExpenseSplit",
    doc: "Whether typed split parts can be saved, and the exact body to send when they can. The only split rule clients consult.",
  },
  "purchase.split": {
    method: "splitExpense",
    doc: "Replaces one expense with its parts. Send the body `checkExpenseSplit` returned, after the person confirmed.",
  },
  "purchase.link": {
    method: "attachExpensesToPurchase",
    doc: "Moves the selected expenses onto a Purchase. Send the ids `checkPurchaseExpenseLink` returned.",
  },
  "purchase.linkExpenseCandidates": {
    method: "purchaseLinkExpenseCandidates",
    doc: "Expenses that can be attached to a Purchase for a scope and search, already worded.",
  },
  "purchase.checkLinkExpenses": {
    method: "checkPurchaseExpenseLink",
    doc: "Whether an expense selection can be attached to a Purchase, what it does to the expense total, and what to confirm.",
  },
  "purchase.linkProductCandidates": {
    method: "purchaseLinkProductCandidates",
    doc: "Products that can be attached to a Purchase: a search minus what is already attached.",
  },
  "purchase.attachProducts": {
    method: "attachProductsToPurchase",
    doc: "Records which products a Purchase bought. The link carries no money or quantity.",
  },
  "product.purchases": { method: "productPurchases", doc: null },
  "recipe.getIngredientUsage": { method: "ingredientUsage", doc: null },
  "meal.addRecipe": {
    method: "addRecipeToMeal",
    doc: "Plans a recipe into a meal at a scale; the composition report's Add recipe command sends it.",
  },
  "meal.updateRecipe": {
    method: "updateMealRecipe",
    doc: "Changes the scale of one recipe in a meal.",
  },
  "meal.removeRecipe": {
    method: "removeMealRecipe",
    doc: "Removes one recipe from a meal, after the report's confirmation.",
  },
  "meal.savePreparation": {
    method: "saveMealPreparation",
    doc: "Sets or removes a prepared recipe's portions and records its yield.",
  },
  "recipe.reprocessCookbookOnce": {
    method: "reprocessCookbook",
    doc: "Re-derives a cookbook's imported recipes from its stored extraction (no AI) and answers once with the summary.",
  },
  "recipe.importCookbookRecipesOnce": {
    method: "importCookbookRecipes",
    doc: "Imports the named source recipes from a cookbook's stored extraction and answers once with the summary.",
  },
  "recipe.generateFlow": {
    method: "generateRecipeFlow",
    doc: "Asks the AI to arrange a recipe's steps into a walkthrough; the report slot offers it behind a confirmation.",
  },
  "recipe.reparseLine": {
    method: "reparseRecipeLine",
    doc: "Re-parses one stored recipe line with the current parser; the server decides what changes and writes only that.",
  },
  // The collection-section actions' operations (`nativeCollectionActionPlans`), decoded from the
  // runner's form values into these typed inputs.
  "ai.describeLocation": { method: "describeLocation", doc: null },
  "image.attachExisting": { method: "attachExistingImage", doc: null },
  "spendingClassification.preview": {
    method: "previewSpendingClassification",
    doc: null,
  },
  "spendingClassification.apply": {
    method: "applySpendingClassification",
    doc: null,
  },
  "ai.detectInventoryItems": { method: "detectInventoryItems", doc: null },
  "ai.approveDetectedInventoryItem": {
    method: "approveDetectedInventoryItem",
    doc: null,
  },
  "ai.suggestFieldsReview": { method: "suggestFieldsReview", doc: null },
  "ai.applyFinanceCategorySuggestion": {
    method: "applyFinanceCategorySuggestion",
    doc: null,
  },
  "financialTransaction.previewBookingCorrection": {
    method: "previewFinancialBookingCorrection",
    doc: null,
  },
  "financialTransaction.commitBookingCorrection": {
    method: "commitFinancialBookingCorrection",
    doc: null,
  },
  "problems.resolveRunFinding": { method: "resolveRunFinding", doc: null },
  "financialTransaction.previewBooking": {
    method: "previewFinancialBooking",
    doc: null,
  },
  "financialTransaction.commitBooking": {
    method: "commitFinancialBooking",
    doc: null,
  },
  "entity.listBase": { method: "entityListBase", doc: null },
  "entity.listEnrichment": { method: "entityListEnrichment", doc: null },
  "entity.listSummary": { method: "entityListSummary", doc: null },
  "activity.detail": { method: "activityDetail", doc: null },
  "activity.devices": { method: "activityDevices", doc: null },
  "activity.events": { method: "activityEvents", doc: null },
  "dashboard.counts": { method: "dashboardCounts", doc: null },
  "inventory.confirmOwnership": {
    method: "confirmInventoryOwnership",
    doc: "Pins the currently inferred owner using the evidence fingerprint returned with the detail. The server rejects stale evidence so native cannot confirm a different acquisition than the one the person reviewed.",
  },
  "inventory.setOwnership": {
    method: "setInventoryOwnership",
    doc: "Applies a stored ownership choice to all or part of one inventory row. A partial quantity may split the row; callers must refresh the returned entry ids rather than assuming the original row is the only record changed.",
  },
  "inventory.receivingContext": {
    method: "inventoryReceivingContext",
    doc: null,
  },
  "inventory.receiveExpense": { method: "receiveExpense", doc: null },
  // The hero-action runner's operations (`nativeHeroActionPlans`); it decodes its form values
  // into these typed inputs, so a contract change is a compile error here, not a silent 400.
  "inventory.bulkAdd": { method: "bulkAddInventory", doc: null },
  "product.discard": { method: "discardProduct", doc: null },
  "product.discardPreview": { method: "discardPreview", doc: null },
  "product.addToInventoryPreview": {
    method: "addToInventoryPreview",
    doc: null,
  },
  "dataQuality.setException": { method: "setDataException", doc: null },
  "dataQuality.clearException": { method: "clearDataException", doc: null },
  "imageProcessing.analyses": { method: "imageAnalyses", doc: null },
  "imageProcessing.status": { method: "imageProcessingStatus", doc: null },
  "imageProcessing.pull": { method: "pullCompanionImageProcessing", doc: null },
  "imageProcessing.complete": {
    method: "completeCompanionImageProcessing",
    doc: null,
  },
  "imageProcessing.release": {
    method: "releaseCompanionImageProcessing",
    doc: null,
  },
  "photoImport.candidates": { method: "photoProductCandidates", doc: null },
  "photoImport.chooseExisting": {
    method: "choosePhotoGroupProduct",
    doc: null,
  },
  "photoImport.commit": { method: "commitPhotoImport", doc: null },
  "photoImport.discardGroup": { method: "discardPhotoGroup", doc: null },
  "photoImport.admitBatch": { method: "admitPhotoImportBatch", doc: null },
  "photoImport.sealBatch": { method: "sealPhotoImportBatch", doc: null },
  "photoImport.registerLiveActivity": {
    method: "registerPhotoRunLiveActivity",
    doc: null,
  },
  "photoImport.endLiveActivity": {
    method: "endPhotoRunLiveActivity",
    doc: null,
  },
  "photoImport.registerNotification": {
    method: "registerPhotoRunNotification",
    doc: null,
  },
  "photoImport.endNotification": {
    method: "endPhotoRunNotification",
    doc: null,
  },
  "photoImport.excludeFailed": {
    method: "excludeFailedPhotoDescriptions",
    doc: null,
  },
  "photoImport.setProcessor": { method: "setPhotoRunProcessor", doc: null },
  "imageProcessing.retry": { method: "retryImageProcessing", doc: null },
  "photoImport.createRun": {
    method: "createPhotoRun",
    doc: "Starts a native-tagged photo-inventory run (`PhotoImportRunUploader`'s bulk-upload entry point). Distinct from the manifest-based `stage`/`commit` pair: a run has no per-photo destination, only ordered positions finalized in chunks.",
  },
  "photoImport.finalize": {
    method: "finalizePhotoRun",
    doc: "Finalizes one chunk (≤100 images) of a bulk upload into `input.runId`. Idempotent: a retry after a transport error replays safely, since a previously finalized image comes back in `alreadyFinalized` rather than erroring.",
  },
  "photoImport.reconcile": {
    method: "reconcilePhotoImport",
    doc: "Waits for any in-flight commit touching these rows, then returns one transactionally consistent status and direct-association snapshot.",
  },
  "photoImport.review": { method: "photoRunReview", doc: null },
  "photoImport.stage": { method: "stagePhotoImport", doc: null },
  "photoImport.startGrouping": { method: "startPhotoGrouping", doc: null },
  "photoImport.updateDraft": { method: "updatePhotoGroupDraft", doc: null },
  "problems.getCounts": { method: "problemCounts", doc: null },
  "run.workSnapshot": { method: "runWorkSnapshot", doc: null },
  "run.control": { method: "controlRun", doc: null },
  "run.commitPrepared": { method: "commitPreparedImport", doc: null },
  "statementRow.commitCsv": { method: "commitStatementCsv", doc: null },
  "statementRow.previewCsv": { method: "previewStatementCsv", doc: null },
  "task.todayBriefing": {
    method: "todayBriefing",
    doc: "The complete ranked task briefing, including summary counts outside the visible prefix.",
  },
} as const satisfies Readonly<
  Record<string, Readonly<{ method: string; doc: string | null }>>
>;

const jsonRef = z
  .object({
    content: z.object({
      "application/json": z.object({ schema: z.object({ $ref: z.string() }) }),
    }),
  })
  .transform(({ content }) =>
    content["application/json"].schema.$ref.replace(
      "#/components/schemas/",
      "",
    ),
  );
const passthroughOperation = z.looseObject({
  requestBody: jsonRef.optional(),
  responses: z.looseObject({ "200": jsonRef }),
});

/** Wraps `text` into `///` lines that fit swift-format's 110 columns at `indent`. */
const swiftDocLines = (text: string, indent: string): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (`${indent}/// ${next}`.length > 110 && line !== "") {
      lines.push(`${indent}/// ${line}`);
      line = word;
    } else line = next;
  }
  if (line !== "") lines.push(`${indent}/// ${line}`);
  return lines;
};

/**
 * `Generated/ClientOperations.swift`: the `CubbyClient` extension holding
 * every `CLIENT_PASSTHROUGH_METHODS` wrapper, typed from the document (the
 * body and 200 components, spelled by their `APITypes.swift` alias names).
 */
export const renderClientOperations = (
  document: OpenApiDocument,
  swiftRoutes: readonly SwiftRoute[],
  generatedOperationIds: ReadonlySet<string>,
): EntityArtifacts => {
  const methods = Object.entries(CLIENT_PASSTHROUGH_METHODS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, { method, doc }]) => {
      const route = swiftRoutes.find((entry) => entry.id === id);
      if (route === undefined || !generatedOperationIds.has(id))
        throw new Error(
          `${id} is a CubbyClient pass-through but not a native operation`,
        );
      if (route.pathParameters.length > 0)
        throw new Error(
          `${id} takes path parameters; its CubbyClient method must be hand-written`,
        );
      if (route.queryParameters.length > 0 && route.hasBody)
        throw new Error(
          `${id} takes both a body and query parameters; its CubbyClient method must be hand-written`,
        );
      const item = Object.entries(document.paths).find(
        ([path]) => path === route.route,
      )?.[1];
      const operation = passthroughOperation.parse(
        Object.entries(item ?? {}).find(
          ([method]) => `.${method}` === route.method,
        )?.[1],
      );
      const output = swiftComponentAlias(operation.responses["200"], id);
      const body =
        operation.requestBody === undefined
          ? null
          : swiftComponentAlias(operation.requestBody, id);
      const hasQuery = route.queryParameters.length > 0;
      const swiftId = id.replaceAll(".", "_");
      // swift-openapi-generator's namespace for an operation: the id with its
      // first letter capitalised (`run_aiUsage` -> `Operations.Run_aiUsage`).
      const queryAlias = `${method[0]!.toUpperCase()}${method.slice(1)}Query`;
      const queryType = `Operations.${swiftId[0]!.toUpperCase()}${swiftId.slice(1)}.Input.Query`;
      const parameter =
        body !== null
          ? `_ input: ${body}`
          : hasQuery
            ? `_ query: ${queryAlias}`
            : "";
      const argument =
        body !== null ? "body: .json(input)" : hasQuery ? "query: query" : "";
      return [
        ...(hasQuery
          ? [`    public typealias ${queryAlias} = ${queryType}`]
          : []),
        ...(doc === null ? [] : swiftDocLines(doc, "    ")),
        `    public func ${method}(${parameter}) async throws -> ${output} {`,
        `        try await perform { try await api.${swiftId}(${argument}).ok.body.json }`,
        "    }",
      ].join("\n");
    });
  return {
    relativePath:
      "apps/apple/CubbyKit/Sources/CubbyKit/Generated/ClientOperations.swift",
    source:
      `${generatedHeader}// swift-format-ignore-file\n\n` +
      "import CubbyAPI\n\n" +
      "/// The `CubbyClient` methods that are one generated call and nothing else, from\n" +
      "/// `CLIENT_PASSTHROUGH_METHODS` in `scripts/generator/http-api/swift-operations.ts`.\n" +
      `extension CubbyClient {\n${methods.join("\n\n")}\n}\n`,
  };
};
