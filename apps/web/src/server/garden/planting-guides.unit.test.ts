import { gardenGuidesDocument } from "@cubby/schemas/garden-guide";
import { describe, expect, it } from "vitest";

import plantingGuides from "./planting-guides.json";

describe("planting guides", () => {
  it("validates the checked-in source-specific calendar data", () => {
    const document = gardenGuidesDocument.parse(plantingGuides);

    expect(document.sources.map((source) => source.id)).toEqual([
      "uc-sunny",
      "uc-foggy",
      "sf-bay-gardening",
      "sloat",
    ]);
    expect(document.guides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "tomato" }),
        expect.objectContaining({ key: "broccoli" }),
        expect.objectContaining({ key: "basil" }),
      ]),
    );
  });

  it("keeps every crop from both UC calendars addressable by a guide key", () => {
    const document = gardenGuidesDocument.parse(plantingGuides);
    const expectedUCKeys = [
      "artichoke",
      "bean-fava",
      "bean-runner",
      "bean-snap",
      "beet",
      "broccoli",
      "brussels-sprout",
      "cabbage",
      "carrot",
      "cauliflower",
      "celery",
      "chard",
      "collard",
      "corn",
      "cucumber",
      "eggplant",
      "garlic",
      "kale",
      "kohlrabi",
      "leek",
      "lettuce",
      "mustard",
      "onion",
      "parsnip",
      "pea",
      "pepper",
      "potato",
      "radish",
      "rhubarb",
      "shallot",
      "spinach",
      "squash-summer",
      "squash-winter",
      "sunflower",
      "tomato",
      "turnip",
    ];

    for (const sourceId of ["uc-sunny", "uc-foggy"]) {
      const guideKeys = document.guides
        .filter((guide) =>
          guide.windows.some((window) => window.sourceId === sourceId),
        )
        .map((guide) => guide.key)
        .sort();
      expect(guideKeys).toEqual([...expectedUCKeys].sort());
    }
  });

  it("keeps the UC sow symbol distinct from a claimed direct-sowing location", () => {
    const document = gardenGuidesDocument.parse(plantingGuides);
    const ucWindows = document.guides.flatMap((guide) =>
      guide.windows.filter((window) => window.sourceId.startsWith("uc-")),
    );

    expect(ucWindows.some((window) => window.method === "direct-sow")).toBe(
      false,
    );
    expect(ucWindows.some((window) => window.method === "sow")).toBe(true);
  });

  it("records SF Bay Gardening's microclimate-only months as separate windows", () => {
    const document = gardenGuidesDocument.parse(plantingGuides);
    const fava = document.guides.find((guide) => guide.key === "bean-fava");
    const sfWindows = fava?.windows.filter(
      (window) => window.sourceId === "sf-bay-gardening",
    );

    expect(sfWindows).toEqual([
      expect.objectContaining({
        microclimate: "bay-area",
        months: [1, 2, 3, 9, 10, 11, 12],
      }),
      expect.objectContaining({ microclimate: "foggy", months: [5, 6, 7, 8] }),
    ]);
  });

  it("rejects invalid month values and unknown sources", () => {
    const invalid = structuredClone(plantingGuides);
    invalid.guides[0]!.windows[0]!.months = [13];
    invalid.guides[1]!.windows[0]!.sourceId = "not-a-source";

    const parsed = gardenGuidesDocument.safeParse(invalid);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining(["Unknown garden-guide source id: not-a-source"]),
    );
  });
});
