import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fieldSuggestionsInput } from "@cubby/schemas/ai";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  providerFor,
  supportedDecisionModelSchema,
} from "@cubby/shared/ai/models";
import {
  createAiModelPricing,
  estimateAiUsageCost,
} from "@cubby/shared/ai/pricing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { evalWebRoot } from "tooling/ai/eval-support";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { DatabaseRuntime } from "~/server/db/database";
import { Database } from "~/server/db/database";
import * as schema from "~/server/db/schema";

import { localSecret } from "../../../tooling/local-secret";
import {
  assertDecisionEvalDatabaseUrl,
  assertDecisionEvalReportOutsideRepo,
  buildDecisionLabels,
  replayDecisionLabels,
  scoreDecisionResults,
  type DecisionLabel,
  type DecisionSuggestionRow,
} from "./decision-eval";

const dbUrl = assertDecisionEvalDatabaseUrl(
  process.env.DECISION_EVAL_DATABASE_URL,
);
const apiKey = localSecret(["AI_GATEWAY_API_KEY"]);
if (!apiKey)
  throw new Error("AI_GATEWAY_API_KEY is required for the live eval");
process.env.AI_GATEWAY_API_KEY = apiKey;
const models = z
  .array(supportedDecisionModelSchema)
  .min(1)
  .parse(
    (process.env.DECISION_EVAL_MODELS ?? "typesafe/jev,@cf/cloudflare/clef")
      .split(",")
      .map((value) => value.trim()),
  );
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const decisionSuggestionRowSchema = z.object({
  id: z.string(),
  runId: z.string(),
  entity: z.string(),
  recordId: z.string(),
  field: z.string(),
  currentValue: jsonValueSchema.nullable(),
  suggestedValue: jsonValueSchema,
  confidence: z.number(),
  model: z.string(),
  pairKey: z.string().nullable(),
  status: z.string(),
  correctValue: jsonValueSchema.nullable(),
});
const persistedValueSchema = z.union([jsonValueSchema, z.date()]);
const savedEntityRecordSchema = z.record(z.string(), persistedValueSchema);
type PersistedValue = z.infer<typeof persistedValueSchema>;
interface DecisionEvalTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}
interface DecisionEvalAnswer {
  prediction: unknown;
  confidence: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number | null;
}
const pricing = createAiModelPricing({
  onError: (error) => console.warn(error.message),
});
const evalDatabaseClient = new Client({ connectionString: dbUrl });
await evalDatabaseClient.connect();
await evalDatabaseClient.query("BEGIN TRANSACTION READ ONLY");
const drizzleClient = drizzle({ client: evalDatabaseClient, schema });
const runtime: DatabaseRuntime = {
  client: drizzleClient,
  withConnection: (fn) => fn(drizzleClient),
};
const db = new Database(() => runtime);
const repositoryRoot = path.resolve(evalWebRoot, "../..");

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function basisString(rawValue: PersistedValue | undefined): string | null {
  if (rawValue === undefined || rawValue === null) return null;
  const date = z.date().safeParse(rawValue);
  if (date.success) return date.data.toISOString();
  const value = jsonValueSchema.parse(rawValue);
  const stringValue = z.string().safeParse(value);
  if (stringValue.success) return stringValue.data;
  const numberValue = z.number().safeParse(value);
  if (numberValue.success) return String(numberValue.data);
  const booleanValue = z.boolean().safeParse(value);
  if (booleanValue.success) return String(booleanValue.data);
  return JSON.stringify(value);
}

function valueForComparison(value: string | null): string | null {
  return value;
}

async function readRows(): Promise<DecisionSuggestionRow[]> {
  const { rows } = await evalDatabaseClient.query(`
    SELECT s."id", s."runId", s."entity", s."recordId", s."field",
      s."currentValue", s."suggestedValue", s."confidence", s."model",
      s."pairKey", s."status", s."correctValue"
    FROM "Suggestion" s
    JOIN "Run" r ON r."id" = s."runId"
    WHERE r."purpose" = 'suggestion_sweep'
      AND s."status" IN ('applied', 'rejected')
    ORDER BY s."createdAt", s."id"
  `);
  return z.array(decisionSuggestionRowSchema).parse(rows);
}

async function recordFor(label: DecisionLabel) {
  const descriptor = Object.entries(entityManifest).find(
    ([entity]) => entity === label.entity,
  )?.[1];
  const tableName = descriptor?.dbTable;
  if (!tableName)
    throw new Error(`Suggestion entity has no table: ${label.entity}`);
  const model = Object.entries(entityFieldModels).find(
    ([entity]) => entity === label.entity,
  )?.[1];
  const field = model?.fields.find((entry) => entry.key === label.field);
  if (!field?.control?.suggest)
    throw new Error(
      `No current suggest prompt for ${label.entity}.${label.field}`,
    );
  const { rows } = await evalDatabaseClient.query(
    `SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" = $1`,
    [label.recordId],
  );
  const record = rows[0] && savedEntityRecordSchema.parse(rows[0]);
  if (!record)
    throw new Error(
      `Saved record is missing for ${label.entity}.${label.field}`,
    );
  const basisEntries = await Promise.all(
    (field.control.suggest.basis ?? []).map(async (key) => {
      const rawValue = record[key];
      const basisField = model?.fields.find((entry) => entry.key === key);
      const rawId = z.string().safeParse(rawValue);
      if (basisField?.reference && rawId.success) {
        const referenced = Object.entries(entityManifest).find(
          ([entity]) => entity === basisField.reference?.entity,
        )?.[1];
        if (referenced?.dbTable) {
          const { rows: referencedRows } = await evalDatabaseClient.query(
            `SELECT "shortcode" FROM ${quoteIdentifier(referenced.dbTable)} WHERE "id" = $1`,
            [rawId.data],
          );
          const shortcode = z
            .string()
            .nullable()
            .parse(referencedRows[0]?.shortcode ?? null);
          return { key, value: shortcode };
        }
      }
      return { key, value: basisString(rawValue) };
    }),
  );
  const basis = Object.fromEntries(
    basisEntries.map(({ key, value }) => [key, value]),
  );
  return {
    entity: label.entity,
    field: label.field,
    recordId: label.recordId,
    basis,
  };
}

describe("live decision prompt evaluation", () => {
  it("replays labeled saved records through the current field prompt", async () => {
    const storedRows = await readRows();
    const labels = buildDecisionLabels(storedRows);
    const recordInputs = await Promise.all(labels.map(recordFor));
    const uniqueRecords = new Map(
      recordInputs.map((entry) => [
        `${entry.entity}/${entry.recordId}/${entry.field}`,
        entry,
      ]),
    );
    const runId = runEntityId.parse(randomUUID());
    const { suggestFields } = await import("./field-suggest/suggest-fields");
    const results = await replayDecisionLabels(
      labels,
      models,
      async (label, model) => {
        const saved = uniqueRecords.get(
          `${label.entity}/${label.recordId}/${label.field}`,
        )!;
        let tokenUsage: DecisionEvalTokenUsage = {
          inputTokens: null,
          outputTokens: null,
        };
        const output = await suggestFields(
          db,
          runId,
          fieldSuggestionsInput.parse({
            entity: label.entity,
            targets: [label.field],
            basisMode: "provided",
            basis: saved.basis,
            entityId: label.recordId,
          }),
          {
            decisionModel: model,
            recordUsage: false,
            force: true,
            onTokenUsage: (usage) => {
              tokenUsage = usage;
            },
          },
        );
        const answer = output.suggestions[label.field];
        const costUsd = estimateAiUsageCost(
          await pricing.current(),
          providerFor(model),
          model,
          {
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          },
        );
        const replay: DecisionEvalAnswer = {
          prediction: valueForComparison(answer?.value ?? null),
          confidence: answer?.probability ?? 0,
          costUsd,
        };
        if (tokenUsage.inputTokens !== null)
          replay.inputTokens = tokenUsage.inputTokens;
        if (tokenUsage.outputTokens !== null)
          replay.outputTokens = tokenUsage.outputTokens;
        return replay;
      },
    );
    const scored = scoreDecisionResults(results);
    const paired = storedRows
      .filter((row) => row.pairKey)
      .reduce<Record<string, DecisionSuggestionRow[]>>((groups, row) => {
        groups[row.pairKey!] = [...(groups[row.pairKey!] ?? []), row];
        return groups;
      }, {});
    const storedPairs = Object.values(paired)
      .filter((pair) => pair.length > 1)
      .map((pair) => ({
        pairKey: pair[0]!.pairKey,
        entity: pair[0]!.entity,
        field: pair[0]!.field,
        recordId: pair[0]!.recordId,
        answers: pair.map((row) => ({
          model: row.model,
          value: row.suggestedValue,
          status: row.status,
          label: row.correctValue,
        })),
      }));
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const reportPath = assertDecisionEvalReportOutsideRepo(
      process.env.DECISION_EVAL_REPORT ??
        path.join(os.tmpdir(), "cubby-decision-eval", `${timestamp}.json`),
      repositoryRoot,
    );
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          revision: execFileSync(
            "git",
            ["-C", repositoryRoot, "rev-parse", "HEAD"],
            { encoding: "utf8" },
          ).trim(),
          replayCommand: `DECISION_EVAL_DATABASE_URL=<read-only-url> pnpm --dir ${evalWebRoot} eval:decisions`,
          models,
          count: results.length,
          scores: scored,
          pairedStoredAnswers: storedPairs,
          results,
          reportPath,
        },
        null,
        2,
      ),
    );
    console.table(scored);
    console.log("Stored paired answer agreement:");
    console.table(
      storedPairs.map((pair) => ({
        field: pair.field,
        models: pair.answers.map((answer) => answer.model).join(", "),
        agreed:
          new Set(pair.answers.map((answer) => JSON.stringify(answer.value)))
            .size === 1,
      })),
    );
    console.log(`JSON report: ${reportPath}`);
    expect(scored.length).toBeGreaterThan(0);
  });
});

afterAll(async () => {
  await evalDatabaseClient.query("ROLLBACK").catch(() => undefined);
  await evalDatabaseClient.end();
});
