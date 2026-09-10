import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  projectCookbookImportEvent,
  projectNotionImportEvent,
} from "./recipe-import-projection";
import {
  attachCookbookRecipePhotoWorkflow,
  deleteCookbookWorkflow,
  extractCookbookChunkWorkflow,
  getCookbookDiffWorkflow,
  getCookbookSourceWorkflow,
  importCookbookWorkflow,
  importNotionSyncWorkflow,
  insertImportWorkflow,
  parseHtmlWorkflow,
  previewNotionSyncWorkflow,
  reprocessCookbookWorkflow,
  scrapeWorkflow,
  setCookbookProductWorkflow,
  upsertCookbookWorkflow,
} from "./recipe-import.server";

describe("recipe import workflow graphs", () => {
  const receipt = {
    id: testEntityId("recipe", "recipe-import-receipt"),
    shortcode: testShortcode("recipe", "RCP-RECEIPT"),
  };

  it("registers remaining non-streaming operation identities", () => {
    for (const [workflow, name] of [
      [scrapeWorkflow, "recipe.scrape"],
      [parseHtmlWorkflow, "recipe.parseHtml"],
      [insertImportWorkflow, "recipe.insertImport"],
      [upsertCookbookWorkflow, "recipe.upsertCookbook"],
      [getCookbookSourceWorkflow, "recipe.getCookbookSource"],
      [attachCookbookRecipePhotoWorkflow, "recipe.attachCookbookRecipePhoto"],
      [getCookbookDiffWorkflow, "recipe.getCookbookDiff"],
      [previewNotionSyncWorkflow, "recipe.previewNotionSync"],
      [setCookbookProductWorkflow, "recipe.setCookbookProduct"],
      [deleteCookbookWorkflow, "recipe.deleteCookbook"],
      [extractCookbookChunkWorkflow, "recipe.extractCookbookChunk"],
    ] as const) {
      expect(workflow.definition.name).toBe(name);
    }
  });

  it("drains required import effects after domain commits", () => {
    expect(
      inspectWorkflow(insertImportWorkflow.definition).steps.map(
        (step) => step.type,
      ),
    ).toEqual([
      "committedCall",
      "committedEffect",
      "committedEffect",
      "committedEffect",
    ]);
    expect(
      inspectWorkflow(upsertCookbookWorkflow.definition).steps.map(
        (step) => step.type,
      ),
    ).toEqual(["committedCall", "committedEffect", "committedEffect"]);
    expect(
      inspectWorkflow(deleteCookbookWorkflow.definition).steps.map(
        (step) => step.type,
      ),
    ).toEqual([
      "call",
      "call",
      "call",
      "committedCall",
      "committedEffect",
      "committedEffect",
      "committedEffect",
    ]);
  });

  it("keeps cookbook and Notion imports sequential, eventful bulk graphs", () => {
    for (const definition of [
      importCookbookWorkflow.definition,
      importNotionSyncWorkflow.definition,
    ]) {
      expect(definition).toMatchObject({
        kind: "bulk",
        onItemError: "continue",
      });
      expect(definition.concurrency).toBeUndefined();
    }
    expect(importCookbookWorkflow.definition.name).toBe(
      "recipe.importCookbookStream",
    );
    expect(importNotionSyncWorkflow.definition.name).toBe(
      "recipe.importNotionSyncStream",
    );
    expect(
      inspectWorkflow(importCookbookWorkflow.definition.item).steps,
    ).toContainEqual(
      expect.objectContaining({ type: "committedCall", name: "imported" }),
    );
    expect(
      inspectWorkflow(importNotionSyncWorkflow.definition.item).steps,
    ).toContainEqual(
      expect.objectContaining({ type: "committedCall", name: "imported" }),
    );
  });

  it("prepares cookbook reprocessing before its no-initial-tick bulk graph", () => {
    const definition = reprocessCookbookWorkflow.definition;
    expect(definition).toMatchObject({
      kind: "preparedBulk",
      name: "recipe.reprocessCookbook",
    });
    expect(
      inspectWorkflow(definition.prepare).steps.map((step) => step.name),
    ).toEqual(["cookbookId", "selection", "prepared"]);
    expect(definition.bulk).toMatchObject({
      kind: "bulk",
      name: "recipe.reprocessCookbook",
      initialProgress: false,
      onItemError: "stop",
    });
    expect(inspectWorkflow(definition.bulk.item).steps).toMatchObject([
      { type: "committedCall", name: "reprocessed" },
    ]);
  });

  it("retains committed recipes when event projection fails", async () => {
    await expect(
      projectCookbookImportEvent(
        4,
        receipt,
        Promise.reject(new Error("Image state unavailable")),
      ),
    ).resolves.toEqual({
      recipeId: receipt.id,
      event: { index: 4, ok: false, error: "Image state unavailable" },
    });
    expect(projectNotionImportEvent("page-4", true, receipt)).toEqual({
      recipeId: receipt.id,
      event: {
        pageId: "page-4",
        ok: true,
        id: receipt.shortcode,
        status: "updated",
      },
    });
  });

  it("settles an already-started image read even when the imported shortcode is invalid", async () => {
    let rejectRead: (error: Error) => void = () => {};
    const read = new Promise<boolean>((_, reject) => {
      rejectRead = reject;
    });
    let finished = false;
    const pending = projectCookbookImportEvent(
      0,
      { ...receipt, shortcode: "invalid" },
      read,
    ).then((result) => {
      finished = true;
      return result;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    rejectRead(new Error("Image read failed"));
    expect(await pending).toMatchObject({
      recipeId: receipt.id,
      event: { index: 0, ok: false },
    });
  });
});
