import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  projectCookbookImportEvent,
  projectNotionImportEvent,
} from "./recipe-import-projection";

describe("recipe import event projection", () => {
  const receipt = {
    id: testEntityId("recipe", "recipe-import-receipt"),
    shortcode: testShortcode("recipe", "RCP-RECEIPT"),
  };

  it("retains committed recipes when event projection fails", async () => {
    await expect(
      projectCookbookImportEvent(
        "001.0004",
        receipt,
        Promise.reject(new Error("Image state unavailable")),
      ),
    ).resolves.toEqual({
      recipeId: receipt.id,
      event: {
        sourceRecipeId: "001.0004",
        ok: false,
        error: "Image state unavailable",
      },
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
      "001.0000",
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
      event: { sourceRecipeId: "001.0000", ok: false },
    });
  });
});
