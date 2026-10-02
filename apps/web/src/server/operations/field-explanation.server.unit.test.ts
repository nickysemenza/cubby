import {
  dataCheckKind,
  dataCheckMessage,
  dataChecksByEntity,
} from "@cubby/schemas/data-quality";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildQualityBreakdown } from "~/server/repo/data-quality/hydrate";

import {
  boundExplanationSources,
  explainInterpretation,
  explainProjectionSources,
  readExplanationPath,
} from "./field-explanation.server";

it.each([
  {
    check: dataChecksByEntity.financialAccount.enum.financial_account_unclaimed,
    summary: "does not reduce this record's score",
    score: 100,
    noWeightedChecks: true,
  },
  {
    check: dataChecksByEntity.financialAccount.enum.financial_account_confirmed,
    summary: "reduces this record's score",
    score: 0,
    noWeightedChecks: false,
  },
])(
  "explains the scoring policy of $check without hiding its gap",
  ({ check, summary, score, noWeightedChecks }) => {
    const field = entityFieldModels.financialAccount.fields.find(
      (entry) => entry.key === "dataQuality",
    );
    if (!field) throw new Error("Declared quality field is missing");
    const breakdown = buildQualityBreakdown([check], [check], []);
    const status = dataCheckKind[check] === "defect" ? "defect" : "needs_data";
    const result = explainInterpretation(
      field,
      status,
      {
        dataQuality: {
          status,
          score: breakdown.score,
          facets: [],
          gaps: [
            {
              check,
              facet: "identity",
              kind: dataCheckKind[check],
              targetType: "financialAccount",
              targetId: testShortcode("financialAccount", "unclaimed-account"),
              message: dataCheckMessage[check],
            },
          ],
          exceptions: [],
          relatedGaps: [],
          relatedExceptions: [],
        },
      },
      [],
      false,
      null,
      breakdown,
      false,
    );
    expect(result.interpretation.nextSteps).toContain(dataCheckMessage[check]);
    expect(result.interpretation.summary).toContain(summary);
    expect(result.interpretation.caveats.join(" ")).not.toContain(
      "No checks apply",
    );
    expect(
      result.interpretation.caveats
        .join(" ")
        .includes("No weighted checks apply"),
    ).toBe(noWeightedChecks);
    expect(breakdown.score).toBe(score);
  },
);

describe("field explanation projection", () => {
  it("treats a nullable computed parent as a real null value", () => {
    expect(
      readExplanationPath({ totals: null }, "totals.nutrition.kcal"),
    ).toEqual({ found: true, value: null });
  });

  it("distinguishes a declaration mismatch from a null result", () => {
    expect(
      readExplanationPath(
        { quantityLedger: {} },
        "quantityLedger.expectedQuantity",
      ),
    ).toEqual({ found: false, value: null });
  });

  it("takes value and trace dependencies from one product pricing projection", () => {
    const projection = {
      price: null,
      pricing: {
        derivedPrice: 12.5,
        effectivePrice: 12.5,
        source: "expenses",
        partial: true,
      },
    };
    const sources = explainProjectionSources(
      projection,
      {
        ruleId: "product.effective-valuation-price",
        version: 1,
        description: "test",
        readPath: null,
        resolver: "productValuation",
        projections: {
          list: "pricing.effectivePrice",
          detail: "pricing.effectivePrice",
          summary: "pricing.effectivePrice",
        },
        sourceDependencies: [
          { path: "price", label: "Manual valuation price" },
          { path: "pricing.derivedPrice", label: "Expense-derived unit price" },
          { path: "pricing.source", label: "Selected price source" },
          { path: "pricing.partial", label: "Incomplete expense coverage" },
        ],
        actions: ["editSource"],
      },
      12.5,
    );

    expect(sources).toEqual([
      { label: "Manual valuation price", entity: null, value: null },
      { label: "Expense-derived unit price", entity: null, value: 12.5 },
      { label: "Selected price source", entity: null, value: "expenses" },
      { label: "Incomplete expense coverage", entity: null, value: true },
    ]);
  });

  it("links projected evidence records and recursively bounds nested lists", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      id: testShortcode("product", `candidate-${index}`),
      history: Array.from({ length: 40 }, (__, historyIndex) => historyIndex),
    }));
    const sources = explainProjectionSources(
      { candidates },
      {
        ruleId: "wish.candidate-count",
        version: 1,
        description: "test",
        resolver: "field",
        sourceDependencies: [
          { path: "candidates", label: "Candidate products" },
        ],
      },
      candidates.length,
    );
    const bounded = boundExplanationSources(sources);

    expect(bounded.truncated).toBe(true);
    expect(bounded.sources[0]?.entity).toEqual({
      entityKind: "product",
      entityId: candidates[0]!.id,
    });
    const boundedCandidate = z
      .object({ history: z.array(z.number()) })
      .parse(bounded.sources[0]?.value);
    expect(boundedCandidate.history).toHaveLength(25);
    expect(sources).toHaveLength(candidates.length);
  });

  it("links the same images selected by the display projection", () => {
    const first = testShortcode("image", "IMG-FIRST");
    const second = testShortcode("image", "IMG-SECOND");
    const displayImages = [
      { id: first, url: "https://example.com/first.jpg" },
      { id: second, url: "https://example.com/second.jpg" },
    ];

    const sources = explainProjectionSources(
      { displayImages },
      {
        ruleId: "product.images",
        version: 1,
        description: "test",
        resolver: "field",
        projections: {
          list: "displayImages",
          detail: "images",
          summary: "displayImages",
        },
        sourceDependencies: [
          { path: "displayImages", label: "Selected product images" },
        ],
      },
      displayImages,
    );

    expect(sources.map((source) => source.entity)).toEqual([
      { entityKind: "image", entityId: first },
      { entityKind: "image", entityId: second },
    ]);
  });

  it("traces image representation selection without recomputing it", () => {
    const projection = {
      representations: {
        original: "https://example.com/original.jpg",
        transparent: "https://example.com/transparent.png",
        preferred: "https://example.com/original.jpg",
        preferredKind: "original",
      },
      useOriginal: true,
    };

    expect(
      explainProjectionSources(
        projection,
        {
          ruleId: "image.representations",
          version: 1,
          description: "test",
          resolver: "imageRepresentation",
          sourceDependencies: [
            {
              path: "representations.original",
              label: "Original image",
            },
            {
              path: "representations.transparent",
              label: "Validated transparent derivative",
            },
            {
              path: "representations.preferredKind",
              label: "Selected representation",
            },
            { path: "useOriginal", label: "Use original preference" },
          ],
        },
        projection.representations,
      ),
    ).toEqual([
      {
        label: "Original image",
        entity: null,
        value: "https://example.com/original.jpg",
      },
      {
        label: "Validated transparent derivative",
        entity: null,
        value: "https://example.com/transparent.png",
      },
      { label: "Selected representation", entity: null, value: "original" },
      { label: "Use original preference", entity: null, value: true },
    ]);
  });
});
