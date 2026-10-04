import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  aiDescriptionItems,
  cookbookItems,
  imageAssociationItems,
  labelImageItems,
  recipeUsageItems,
  runHistoryItems,
} from "./collection-items";

const cookbookId = testShortcode("cookbook", "weeknight");
const imageId = testShortcode("image", "panel");
const recipeId = testShortcode("recipe", "stew");
const otherRecipeId = testShortcode("recipe", "bread");
const runId = testShortcode("run", "validate");

describe("cookbookItems", () => {
  it("words a cookbook copy's recipe count and opens the cookbook", () => {
    expect(
      cookbookItems([
        { id: cookbookId, name: "Weeknight Dinners", recipeCount: 1 },
      ]),
    ).toMatchObject([
      {
        entity: "cookbook",
        id: cookbookId,
        title: "Weeknight Dinners",
        subtitle: "1 recipe",
      },
    ]);
    expect(
      cookbookItems([{ id: cookbookId, name: "Weeknight", recipeCount: 12 }])[0]
        ?.subtitle,
    ).toBe("12 recipes");
  });
});

describe("labelImageItems", () => {
  it("shows a package label's retained original, never a cutout derivative", () => {
    const [row] = labelImageItems([
      {
        id: imageId,
        filename: "nutrition-panel.jpg",
        url: "https://media.example.test/cutout.png",
        representations: { original: "https://media.example.test/panel.jpg" },
      },
    ]);
    expect(row).toMatchObject({
      entity: "image",
      id: imageId,
      title: "nutrition-panel.jpg",
      imageUrl: "https://media.example.test/panel.jpg",
    });
    expect(
      labelImageItems([
        {
          id: imageId,
          filename: "x.jpg",
          url: "https://media.example.test/x.jpg",
          representations: undefined,
        },
      ])[0]?.imageUrl,
    ).toBe("https://media.example.test/x.jpg");
  });
});

describe("recipeUsageItems", () => {
  const usage = (
    id: string,
    recipe: { id: string; name: string },
    sectionName: string | null,
    rawLine: string | null,
  ) => ({
    id,
    recipe,
    sectionName,
    amounts: [{ value: 2, unit: "cup" }],
    rawLine,
    modifier: "sifted",
  });

  it("lists recipe lines by recipe then section, with the written line beneath", () => {
    const rows = recipeUsageItems(
      [
        usage("u2", { id: otherRecipeId, name: "Sourdough" }, null, null),
        usage(
          "u1",
          { id: recipeId, name: "Beef Stew" },
          "Gravy",
          "2 cups flour",
        ),
      ],
      (amount) => `${amount.value} ${amount.unit}`,
    );
    expect(rows.map((row) => row.title)).toEqual(["Beef Stew", "Sourdough"]);
    expect(rows[0]).toMatchObject({
      entity: "recipe",
      id: recipeId,
      subtitle: "Gravy · 2 cup · sifted\n2 cups flour",
    });
    // A line with no captured source says so instead of leaving the row bare.
    expect(rows[1]?.subtitle).toBe("2 cup · sifted\n(no source line)");
  });
});

describe("imageAssociationItems", () => {
  it("opens each record an image is attached to, naming the role", () => {
    expect(
      imageAssociationItems([
        {
          entityKind: "recipe",
          entityId: recipeId,
          entityName: "Beef Stew",
          role: "cover",
        },
      ]),
    ).toMatchObject([
      { entity: "recipe", id: recipeId, title: "Beef Stew", subtitle: "cover" },
    ]);
  });
});

describe("aiDescriptionItems", () => {
  it("makes the latest AI description one row, and nothing when there is none", () => {
    expect(aiDescriptionItems("Three shelves of canned goods.")).toMatchObject([
      { entity: null, id: null, title: "Three shelves of canned goods." },
    ]);
    expect(aiDescriptionItems(null)).toEqual([]);
    expect(aiDescriptionItems("")).toEqual([]);
  });
});

describe("runHistoryItems", () => {
  it("summarises an import run on two lines and flags a failure", () => {
    const [row] = runHistoryItems([
      {
        publicId: runId,
        purpose: "purchase_validation",
        vendorAccountLabel: null,
        vendorName: null,
        trigger: "manual",
        status: "failed",
        startedAt: "2026-03-04T10:15:00.000Z",
        endedAt: null,
        ordersSeen: 4,
        imported: 2,
        updated: 1,
        skipped: 1,
        failureCode: "login_expired",
        estimatedCost: 0,
      },
    ]);
    expect(row).toMatchObject({
      entity: "run",
      id: runId,
      title: "Purchase import",
      subtitle:
        "purchase validation · manual\n4 seen · 2 imported · 1 updated · 1 skipped",
      trailing: "failed",
      at: "2026-03-04T10:15:00.000Z",
      badges: ["login_expired"],
    });
  });
});
