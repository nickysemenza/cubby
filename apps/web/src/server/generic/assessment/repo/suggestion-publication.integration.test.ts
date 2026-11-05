import type { AssessmentProducer } from "@cubby/schemas/assessment";
import { parseEntityId, type RunId } from "@cubby/schemas/identifiers";
import { asc, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  publishSuggestion,
  publishSuggestionBatches,
  type SuggestionFamily,
} from "~/server/generic/assessment/repo/suggestion-publication";

type Candidate = {
  key: string;
  evidence: string;
  label?: string;
  fail?: boolean;
};

const recordId = parseEntityId(
  "product",
  "00000000-0000-4000-8000-000000000101",
);

/** A synthetic family over `recommendation` rows; only the declaration is fake. */
const synthetic: SuggestionFamily<Candidate> = {
  family: "recommendation",
  slot: ({ key }) => ({
    lock: `synthetic-suggestion:${key}`,
    fields: { candidateKey: key },
  }),
  fingerprint: ({ key, evidence, label }) =>
    `${key}:${evidence}:${label ?? ""}`,
  evidenceFingerprint: ({ key, evidence }) => `${key}:${evidence}`,
  onUnchanged: { reconfirm: "synthetic_reconfirmed" },
  publication: (candidate, prior, producer, fingerprints) => {
    if (candidate.fail) throw new Error("Synthetic publication failure");
    return {
      input: {
        publicationKey: `synthetic:${candidate.key}:${fingerprints.fingerprint}:${prior.length}`,
        family: "recommendation",
        subject: {
          kind: "recommendation",
          entity: "product",
          recordId,
          scope: "related",
          candidateKey: candidate.key,
        },
        judgment: { candidateKey: candidate.key },
        fingerprint: fingerprints.fingerprint,
        producer,
        evidence: null,
      },
      projection: {
        runId: producer.runId,
        data: {
          candidateKey: candidate.key,
          evidenceFingerprint: fingerprints.evidenceFingerprint,
        },
      },
    };
  },
  labelBacklog: sql`s.active`,
};

const rule = (runId: RunId | null): AssessmentProducer => ({
  kind: "rule",
  model: null,
  revision: "synthetic-1",
  runId,
  evaluationId: null,
});

// Failure modes: a dismissal returns on the next pass; unchanged evidence is
// replaced (dropping labels) or stays on its old Run; changed evidence leaves
// two active rows; one bad candidate fails its whole batch.
describe("Suggestion publication", () => {
  const ctx = withTestDb();
  const rows = (key: string) =>
    getDb(ctx.db)
      .select({
        id: suggestionTable.id,
        active: suggestionTable.active,
        status: suggestionTable.status,
        runId: suggestionTable.runId,
      })
      .from(suggestionTable)
      .where(sql`${suggestionTable.data}->>'candidateKey' = ${key}`)
      .orderBy(asc(suggestionTable.createdAt), asc(suggestionTable.id));

  it("keeps suppressed slots, reconfirms unchanged evidence and replaces changed evidence", async () => {
    const first = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const second = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const pair = { key: "synthetic-a", evidence: "one" };
    expect(
      await publishSuggestion(ctx.db, synthetic, pair, rule(first)),
    ).toMatchObject({ outcome: "published" });
    // A labelled row with equal rule evidence is left alone and moves Run.
    expect(
      await publishSuggestion(
        ctx.db,
        synthetic,
        { ...pair, label: "labelled" },
        rule(second),
      ),
    ).toMatchObject({ outcome: "unchanged" });
    const [original] = await rows("synthetic-a");
    expect(original).toMatchObject({ active: true, runId: second });

    expect(
      await publishSuggestion(
        ctx.db,
        synthetic,
        { ...pair, evidence: "two" },
        rule(second),
      ),
    ).toMatchObject({ outcome: "published" });
    // A replaced opinion with no decision of its own is not history.
    const replaced = await rows("synthetic-a");
    expect(replaced).toMatchObject([{ active: true, status: "pending" }]);
    expect(replaced[0]?.id).not.toBe(original!.id);

    // A member's suppression holds the slot against changed evidence.
    await getDb(ctx.db)
      .update(suggestionTable)
      .set({
        suppression: {
          scope: "recommendation",
          candidateKey: "synthetic-a",
          fingerprint: null,
        },
      })
      .where(eq(suggestionTable.id, replaced[0]!.id));
    expect(
      await publishSuggestion(
        ctx.db,
        synthetic,
        { ...pair, evidence: "three" },
        rule(null),
      ),
    ).toEqual({ outcome: "suppressed" });
    expect(await rows("synthetic-a")).toHaveLength(1);
  });

  it("isolates one failing candidate when its batch falls back", async () => {
    const outcomes = new Map<string, string>();
    await publishSuggestionBatches(
      ctx.db,
      synthetic,
      [
        { key: "synthetic-b", evidence: "one" },
        { key: "synthetic-c", evidence: "one", fail: true },
        { key: "synthetic-d", evidence: "one" },
      ],
      rule(null),
      {
        concurrency: 1,
        onOutcome: (candidate, outcome) =>
          outcomes.set(candidate.key, outcome.outcome),
        onFailure: (candidate) => outcomes.set(candidate.key, "failed"),
      },
    );
    expect(Object.fromEntries(outcomes)).toEqual({
      "synthetic-b": "published",
      "synthetic-c": "failed",
      "synthetic-d": "published",
    });
    expect(await rows("synthetic-b")).toHaveLength(1);
    expect(await rows("synthetic-c")).toEqual([]);
    expect(await rows("synthetic-d")).toHaveLength(1);
  });
});
