import { describe, expect, it } from "vitest";
import {
  buildLocationAnalysisFingerprint,
  LOCATION_INVENTORY_DETECTION_FEATURE,
} from "./features";
import { INVENTORY_DETECTION_EVALS } from "./inventory-detection-evals";

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
});
