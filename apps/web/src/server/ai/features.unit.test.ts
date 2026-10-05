import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AI_FEATURES,
  buildLocationAnalysisFingerprint,
  LOCATION_INVENTORY_DETECTION_FEATURE,
  PURCHASE_IMPORT_AUDIT_FEATURE,
} from "./features";

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
  it("declares an output schema for every cacheable chat feature", () => {
    // The gateway's response cache keys on the exact request body, which is
    // only deterministic for a structured, single-turn call. Anything
    // cacheable must therefore be one (a decision call is single-turn by
    // construction).
    for (const feature of AI_FEATURES) {
      if (
        !feature.cache ||
        feature.tier === "decision" ||
        feature.tier === "embedding"
      )
        continue;
      expect("schema" in feature).toBe(true);
    }
  });

  it("gives every feature a unique label", () => {
    const labels = AI_FEATURES.map((feature) => feature.feature);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("caps every chat feature's output", () => {
    for (const feature of AI_FEATURES) {
      if (feature.tier === "decision" || feature.tier === "embedding") continue;
      expect(feature.maxTokens).toBeGreaterThan(0);
    }
  });
});

describe("output schemas an Anthropic model may receive", () => {
  // Anthropic structured outputs reject array bounds (`maxItems`/`minItems`)
  // with a 400 that no retry can fix. The audit feature shipped one and
  // every stop-for-review of an account-sync run failed on it. The audit's
  // recovery call goes to Anthropic whatever the audit's own tier.
  it("carry no array bounds Anthropic rejects", () => {
    for (const feature of AI_FEATURES) {
      if (
        !("schema" in feature) ||
        (feature.tier !== "reasoning" &&
          feature !== PURCHASE_IMPORT_AUDIT_FEATURE)
      )
        continue;
      const rendered = JSON.stringify(z.toJSONSchema(feature.schema));
      expect(rendered).not.toMatch(/"(max|min)Items"/);
    }
  });
});
