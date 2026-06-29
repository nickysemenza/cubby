import { describe, expect, it } from "vitest";
import {
  buildLocationAnalysisFingerprint,
  LOCATION_INVENTORY_DETECTION_FEATURE,
} from "./features";
import {
  evaluateInventoryDetection,
  INVENTORY_DETECTION_EVALS,
} from "./inventory-detection-evals";

describe("AI feature fingerprints", () => {
  it("is stable across image ordering", () => {
    const imageA = {
      id: "00000000-0000-4000-8000-000000000001",
      updatedAt: new Date("2026-06-28T10:00:00Z"),
    };
    const imageB = {
      id: "00000000-0000-4000-8000-000000000002",
      updatedAt: new Date("2026-06-28T11:00:00Z"),
    };

    expect(
      buildLocationAnalysisFingerprint(LOCATION_INVENTORY_DETECTION_FEATURE, {
        locationName: "tarps cloths blankets",
        images: [imageA, imageB],
      }),
    ).toEqual(
      buildLocationAnalysisFingerprint(LOCATION_INVENTORY_DETECTION_FEATURE, {
        locationName: "tarps cloths blankets",
        images: [imageB, imageA],
      }),
    );
  });

  it("changes when an image changes", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000001",
      updatedAt: new Date("2026-06-28T10:00:00Z"),
    };

    const first = buildLocationAnalysisFingerprint(
      LOCATION_INVENTORY_DETECTION_FEATURE,
      {
        locationName: "tarps cloths blankets",
        images: [base],
      },
    );
    const second = buildLocationAnalysisFingerprint(
      LOCATION_INVENTORY_DETECTION_FEATURE,
      {
        locationName: "tarps cloths blankets",
        images: [
          {
            ...base,
            updatedAt: new Date("2026-06-28T10:01:00Z"),
          },
        ],
      },
    );

    expect(second).not.toEqual(first);
  });
});

describe("inventory detection eval fixtures", () => {
  it("includes the tarp/drop-cloth target fixture", () => {
    expect(INVENTORY_DETECTION_EVALS).toContainEqual({
      name: "tarps cloths blankets",
      locationName: "tarps cloths blankets",
      expectedItems: ["blue tarp", "painters drop cloth", "plastic drop cloth"],
      excludedItems: [
        "black plastic crate",
        "small blue plastic bag",
        "cream cloth items",
        "various packaged items",
      ],
    });
  });

  it("passes the tarp/drop-cloth target fixture with canonical items", () => {
    const fixture = INVENTORY_DETECTION_EVALS[0]!;
    const result = evaluateInventoryDetection(fixture, {
      summary: "Tarps and drop cloths are visible.",
      items: [
        {
          name: "blue tarp",
          manufacturer: "(unspecified)",
          estimatedQuantity: 1,
          unit: "each",
          category: "supplies",
          confidence: "medium",
          evidence: "Blue folded plastic material is visible.",
          isMisc: false,
        },
        {
          name: "painters drop cloth",
          manufacturer: "(unspecified)",
          estimatedQuantity: 1,
          unit: "each",
          category: "supplies",
          confidence: "medium",
          evidence:
            "Folded cream fabric is consistent with a painter drop cloth.",
          isMisc: false,
        },
        {
          name: "plastic drop cloth",
          manufacturer: "(unspecified)",
          estimatedQuantity: 1,
          unit: "each",
          category: "supplies",
          confidence: "low",
          evidence:
            "Lower packaged plastic sheet is compatible with location context.",
          isMisc: false,
        },
      ],
    });

    expect(result).toEqual({
      passed: true,
      missingExpectedItems: [],
      presentExcludedItems: [],
      recognizableMiscItems: [],
      missingEvidenceItems: [],
    });
  });

  it("fails the tarp/drop-cloth fixture on vague excluded items", () => {
    const fixture = INVENTORY_DETECTION_EVALS[0]!;
    const result = evaluateInventoryDetection(fixture, {
      summary: "A crate contains cloths and packages.",
      items: [
        {
          name: "cream cloth items",
          manufacturer: "(unspecified)",
          estimatedQuantity: 4,
          unit: "each",
          category: "storage",
          confidence: "low",
          evidence: "",
          isMisc: true,
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.missingExpectedItems).toEqual(fixture.expectedItems);
    expect(result.presentExcludedItems).toContain("cream cloth items");
    expect(result.missingEvidenceItems).toContain("cream cloth items");
  });
});
