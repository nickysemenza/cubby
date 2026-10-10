import { describe, expect, it } from "vitest";

import {
  assertDecisionEvalDatabaseUrl,
  assertDecisionEvalReportOutsideRepo,
  buildDecisionLabels,
  replayDecisionLabels,
  scoreDecisionResults,
} from "./decision-eval";

const rows = [
  {
    id: "s1",
    runId: "r1",
    entity: "product",
    recordId: "p1",
    field: "feature",
    currentValue: null,
    suggestedValue: "heat",
    confidence: 0.9,
    model: "typesafe/jev",
    pairKey: "pair-1",
    status: "applied",
    correctValue: null,
  },
  {
    id: "s2",
    runId: "r1",
    entity: "product",
    recordId: "p1",
    field: "feature",
    currentValue: null,
    suggestedValue: "heat",
    confidence: 0.8,
    model: "@cf/cloudflare/clef",
    pairKey: "pair-1",
    status: "rejected",
    correctValue: "cooling",
  },
  {
    id: "s3",
    runId: "r2",
    entity: "product",
    recordId: "p2",
    field: "feature",
    currentValue: "cooling",
    suggestedValue: "heat",
    confidence: 0.7,
    model: "typesafe/jev",
    pairKey: null,
    status: "rejected",
    correctValue: null,
  },
];

describe("decision evaluation", () => {
  it("uses accepted values, explicit corrections, and marks bare rejections negative", () => {
    expect(buildDecisionLabels(rows)).toEqual([
      expect.objectContaining({ label: "heat", negative: false }),
      expect.objectContaining({ label: "cooling", negative: false }),
      expect.objectContaining({ label: "heat", negative: true }),
    ]);
  });

  it("scores independently per model and field and counts re-proposed misses", () => {
    const scores = scoreDecisionResults([
      {
        field: "feature",
        model: "jev",
        label: "red",
        prediction: "red",
        confidence: 0.8,
      },
      {
        field: "feature",
        model: "jev",
        label: "red",
        prediction: "blue",
        confidence: 0.2,
        negative: true,
      },
      {
        field: "category",
        model: "jev",
        label: "tool",
        prediction: "tool",
        confidence: 0.7,
      },
      {
        field: "feature",
        model: "clef",
        label: "red",
        prediction: "red",
        confidence: 0.9,
      },
    ]);
    expect(scores).toEqual([
      expect.objectContaining({
        field: "feature",
        model: "jev",
        count: 2,
        correct: 2,
        repeatMisses: 0,
        meanCorrectConfidence: 0.5,
        meanWrongConfidence: null,
      }),
      expect.objectContaining({
        field: "category",
        model: "jev",
        count: 1,
        correct: 1,
      }),
      expect.objectContaining({
        field: "feature",
        model: "clef",
        count: 1,
        correct: 1,
      }),
    ]);
    const repeatMiss = scoreDecisionResults([
      {
        field: "feature",
        model: "jev",
        label: "wrong",
        prediction: "wrong",
        confidence: 0.6,
        negative: true,
      },
    ]);
    expect(repeatMiss[0]?.repeatMisses).toBe(1);
    expect(repeatMiss[0]?.correct).toBe(0);
  });

  it("replays each label for each candidate through an injected decision port", async () => {
    const seen: string[] = [];
    await replayDecisionLabels(
      buildDecisionLabels(rows).slice(0, 1),
      ["jev", "clef"],
      async (_entry, model) => {
        seen.push(model);
        return { prediction: "red", confidence: 0.8 };
      },
    );
    expect(seen).toEqual(["jev", "clef"]);
  });

  it("refuses to run without the explicit database URL", () => {
    expect(() => assertDecisionEvalDatabaseUrl(undefined)).toThrow(
      /DECISION_EVAL_DATABASE_URL/,
    );
    expect(assertDecisionEvalDatabaseUrl("postgres://localhost/eval")).toBe(
      "postgres://localhost/eval",
    );
  });

  it("keeps record-level reports outside the repository", () => {
    expect(() =>
      assertDecisionEvalReportOutsideRepo("/repo/report.json", "/repo"),
    ).toThrow(/outside the repository/);
    expect(
      assertDecisionEvalReportOutsideRepo("/tmp/report.json", "/repo"),
    ).toBe("/tmp/report.json");
  });
});
