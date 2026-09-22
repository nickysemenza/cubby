import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AGENT_ASK_FEATURE,
  AI_FEATURES,
  buildLocationAnalysisFingerprint,
  LOCATION_INVENTORY_DETECTION_FEATURE,
  MODEL_FOR_TIER,
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

describe("the AI feature table", () => {
  it("derives every record's model from its tier", () => {
    for (const feature of AI_FEATURES) {
      expect(feature.model).toBe(MODEL_FOR_TIER[feature.tier]);
    }
  });

  it("declares an output schema for every cacheable chat feature", () => {
    // The gateway's response cache keys on the exact request body, which is
    // only deterministic for a structured, single-turn call. Anything
    // cacheable must therefore be one (a decision call is single-turn by
    // construction).
    for (const feature of AI_FEATURES) {
      if (!feature.cache || feature.tier === "decision") continue;
      expect("schema" in feature).toBe(true);
    }
  });

  it("leaves the streaming, tool-calling agent uncacheable", () => {
    expect(AGENT_ASK_FEATURE.cache).toBe(false);
    expect("schema" in AGENT_ASK_FEATURE).toBe(false);
  });

  it("gives every feature a unique label", () => {
    const labels = AI_FEATURES.map((feature) => feature.feature);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("caps every chat feature's output", () => {
    for (const feature of AI_FEATURES) {
      if (feature.tier === "decision") continue;
      expect(feature.maxTokens).toBeGreaterThan(0);
    }
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
          confidence: "medium",
          evidence: "Blue folded plastic material is visible.",
          isMisc: false,
        },
        {
          name: "painters drop cloth",
          manufacturer: "(unspecified)",
          estimatedQuantity: 1,
          unit: "each",
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

describe("reasoning-tier output schemas", () => {
  // Anthropic structured outputs reject array bounds (`maxItems`/`minItems`)
  // with a 400 that no retry can fix. The audit feature shipped one and
  // every stop-for-review of an account-sync run failed on it.
  it("carry no array bounds Anthropic rejects", () => {
    for (const feature of AI_FEATURES) {
      if (feature.tier !== "reasoning" || !("schema" in feature)) continue;
      const rendered = JSON.stringify(z.toJSONSchema(feature.schema));
      expect(rendered).not.toMatch(/"(max|min)Items"/);
    }
  });
});
