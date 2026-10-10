import path from "node:path";

import { z } from "zod";

type ComparableDecisionValue =
  | string
  | number
  | boolean
  | null
  | ComparableDecisionValue[]
  | { [key: string]: ComparableDecisionValue };
const comparableDecisionValueSchema: z.ZodType<ComparableDecisionValue> =
  z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(comparableDecisionValueSchema),
      z.record(z.string(), comparableDecisionValueSchema),
    ]),
  );

export interface DecisionLabel {
  id: string;
  recordId: string;
  entity: string;
  field: string;
  currentValue: unknown;
  suggestedValue: unknown;
  label: unknown;
  negative: boolean;
  confidence: number;
  pairKey: string | null;
}

export interface DecisionSuggestionRow {
  id: string;
  runId: string;
  entity: string;
  recordId: string;
  field: string;
  currentValue: unknown;
  suggestedValue: unknown;
  confidence: number;
  model: string;
  pairKey: string | null;
  status: string;
  correctValue: unknown;
}

export function buildDecisionLabels(
  rows: readonly DecisionSuggestionRow[],
): DecisionLabel[] {
  return rows.flatMap((row) => {
    if (row.status === "applied")
      return [{ ...row, label: row.suggestedValue, negative: false }];
    if (row.status === "rejected")
      return [
        {
          ...row,
          label: row.correctValue ?? row.suggestedValue,
          negative: row.correctValue == null,
        },
      ];
    return [];
  });
}

export interface DecisionResult {
  field: string;
  model: string;
  label: unknown;
  prediction: unknown;
  confidence: number;
  negative?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

export interface DecisionScore {
  field: string;
  model: string;
  count: number;
  correct: number;
  accuracy: number;
  repeatMisses: number;
  meanCorrectConfidence: number | null;
  meanWrongConfidence: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

function comparableValue(rawValue: unknown): string | null {
  const value = comparableDecisionValueSchema.parse(rawValue);
  const nullValue = z.null().safeParse(value);
  if (nullValue.success) return null;
  const stringValue = z.string().safeParse(value);
  if (stringValue.success) return stringValue.data;
  const numberValue = z.number().safeParse(value);
  if (numberValue.success) return String(numberValue.data);
  const booleanValue = z.boolean().safeParse(value);
  if (booleanValue.success) return String(booleanValue.data);
  return JSON.stringify(value);
}

export function scoreDecisionResults(
  results: readonly DecisionResult[],
): DecisionScore[] {
  const groups = new Map<string, DecisionResult[]>();
  for (const result of results) {
    const key = JSON.stringify([result.field, result.model]);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups.values()].map((group) => {
    const isCorrect = (result: DecisionResult) =>
      result.negative
        ? comparableValue(result.prediction) !== comparableValue(result.label)
        : comparableValue(result.prediction) === comparableValue(result.label);
    const correct = group.filter(isCorrect);
    const wrong = group.filter((result) => !isCorrect(result));
    const mean = (items: readonly DecisionResult[]) =>
      items.length
        ? items.reduce((sum, item) => sum + item.confidence, 0) / items.length
        : null;
    const tokenTotal = (key: "inputTokens" | "outputTokens") =>
      group.every((entry) => entry[key] !== undefined)
        ? group.reduce((sum, entry) => sum + (entry[key] ?? 0), 0)
        : null;
    const costUsd = group.every(
      (entry) => entry.costUsd !== undefined && entry.costUsd !== null,
    )
      ? group.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)
      : null;
    return {
      field: group[0]!.field,
      model: group[0]!.model,
      count: group.length,
      correct: correct.length,
      accuracy: correct.length / group.length,
      repeatMisses: group.filter(
        (result) =>
          result.negative &&
          comparableValue(result.prediction) === comparableValue(result.label),
      ).length,
      meanCorrectConfidence: mean(correct),
      meanWrongConfidence: mean(wrong),
      inputTokens: tokenTotal("inputTokens"),
      outputTokens: tokenTotal("outputTokens"),
      costUsd,
    };
  });
}

export async function replayDecisionLabels<
  T extends {
    prediction: unknown;
    confidence: number;
    inputTokens?: number;
    outputTokens?: number;
  },
  M extends string = string,
>(
  labels: readonly DecisionLabel[],
  models: readonly M[],
  decide: (label: DecisionLabel, model: M) => Promise<T>,
): Promise<(DecisionResult & { recordId: string; entity: string })[]> {
  const results = [];
  for (const label of labels) {
    for (const model of models) {
      const answer = await decide(label, model);
      results.push({
        field: label.field,
        model,
        label: label.label,
        negative: label.negative,
        recordId: label.recordId,
        entity: label.entity,
        ...answer,
      });
    }
  }
  return results;
}

export function assertDecisionEvalDatabaseUrl(
  value: string | undefined,
): string {
  if (!value)
    throw new Error(
      "DECISION_EVAL_DATABASE_URL is required for eval:decisions",
    );
  return value;
}

export function assertDecisionEvalReportOutsideRepo(
  reportPath: string,
  repositoryRoot: string,
): string {
  const resolvedReport = path.resolve(reportPath);
  const resolvedRepo = path.resolve(repositoryRoot);
  if (
    resolvedReport === resolvedRepo ||
    resolvedReport.startsWith(`${resolvedRepo}${path.sep}`)
  )
    throw new Error("DECISION_EVAL_REPORT must be outside the repository");
  return resolvedReport;
}
