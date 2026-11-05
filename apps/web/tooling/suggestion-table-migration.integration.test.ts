import { drizzle } from "drizzle-orm/node-postgres";
import { type Client, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PREDECESSOR = "0075_drop_redundant_indexes";
const MEMBER = "synthetic-member";

type Db = Client | PoolClient;

/** A retired source row at the final predecessor shape, written directly. */
async function publish(
  client: Db,
  input: {
    id: string;
    family: string;
    subject: unknown;
    judgment?: unknown;
    fingerprint?: string | null;
    evidence?: unknown;
    served?: boolean;
    createdAt?: string;
    state?: Record<string, unknown>;
  },
) {
  const createdAt = input.createdAt ?? "2026-01-01T00:00:00Z";
  await client.query(
    `INSERT INTO "Assessment" (id, "publicationKey", family, subject, judgment, fingerprint, evidence, served, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      `synthetic:${input.id}`,
      input.family,
      JSON.stringify(input.subject),
      JSON.stringify(input.judgment ?? {}),
      input.fingerprint ?? null,
      input.evidence === undefined ? null : JSON.stringify(input.evidence),
      input.served ?? true,
      createdAt,
    ],
  );
  const state = {
    entity: "product",
    recordId: id(900),
    status: "pending",
    active: true,
    data: {},
    ...input.state,
  };
  await client.query(
    `INSERT INTO "AssessmentState" (id, family, entity, "recordId", status, active, data, suppression, fingerprint, "createdAt", "suggestedValue", "acceptanceReceipt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'null'::jsonb, $11)`,
    [
      input.id,
      input.family,
      state.entity,
      state.recordId,
      state.status,
      state.active,
      JSON.stringify(state.data),
      state.suppression === undefined ? null : JSON.stringify(state.suppression),
      input.fingerprint ?? null,
      createdAt,
      state.acceptanceReceipt === undefined
        ? null
        : JSON.stringify(state.acceptanceReceipt),
    ],
  );
}

async function feedback(
  client: Db,
  input: {
    id: string;
    assessmentId: string;
    operationId: string;
    verdict: string;
    authority: string;
    intent?: string;
    actorUserId?: string | null;
    correction?: unknown;
    reason?: string | null;
    receipt?: unknown;
    metadata?: unknown;
  },
) {
  await client.query(
    `INSERT INTO "Feedback" (id, "assessmentId", "operationId", verdict, correction, reason, intent, authority, "actorUserId", receipt, metadata, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '2026-01-02T03:04:05.678901Z')`,
    [
      input.id,
      input.assessmentId,
      input.operationId,
      input.verdict,
      JSON.stringify(input.correction ?? { present: false }),
      input.reason ?? null,
      input.intent ?? "history",
      input.authority,
      input.actorUserId ?? null,
      input.receipt === undefined ? null : JSON.stringify(input.receipt),
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    ],
  );
}

const connectionSubject = (relation: string) => ({
  kind: "recommendation",
  entity: "expense",
  recordId: id(900),
  scope: `connection.${relation}`,
  candidateKey: `key-${relation}`,
});
const connectionEvidence = {
  version: 1,
  candidate: { relation: "expense-project" },
  basis: { dependencies: { history: ["wide synthetic snapshot"] } },
};

async function seedPredecessor(client: Db) {
  // A field draft a member corrected to explicit null, plus a history-only grade.
  await publish(client, {
    id: id(1),
    family: "field",
    served: false,
    subject: { kind: "field", entity: "product", recordId: id(900), field: "brandId" },
    state: { status: "applied", active: false, acceptanceReceipt: { auditIds: [] } },
    fingerprint: "field-1",
  });
  await feedback(client, {
    id: id(101),
    assessmentId: id(1),
    operationId: "review-null",
    verdict: "wrong",
    authority: "member",
    intent: "apply",
    actorUserId: MEMBER,
    correction: { present: true, value: null },
    reason: "Synthetic reason",
  });
  await feedback(client, {
    id: id(102),
    assessmentId: id(1),
    operationId: "grade",
    verdict: "uncertain",
    authority: "member",
    actorUserId: MEMBER,
  });
  // Replays only State, so it does not carry.
  await feedback(client, {
    id: id(103),
    assessmentId: id(1),
    operationId: "projection:synthetic",
    verdict: "ungraded",
    authority: "system",
    intent: "projection",
  });
  // An undecided trial answer still carries: settled answers name it by id.
  await publish(client, {
    id: id(2),
    family: "field",
    served: false,
    subject: { kind: "field", entity: "product", recordId: id(900), field: "model" },
    state: { status: "superseded", active: false },
  });
  const statement = (source: string, chargeKey: string) => ({
    entity: "sourceTransactionRecord",
    data: { source, chargeKey },
  });
  // The newest revision of a charge carries for its paid labels; older ones do not.
  await publish(client, {
    id: id(10),
    family: "statement_transaction",
    subject: { kind: "statement_transaction" },
    createdAt: "2026-01-01T00:00:00Z",
    state: { ...statement("s", "old"), status: "superseded", active: false },
  });
  await publish(client, {
    id: id(11),
    family: "statement_transaction",
    subject: { kind: "statement_transaction" },
    createdAt: "2026-01-03T00:00:00Z",
    state: { ...statement("s", "old"), status: "superseded", active: false },
  });
  // A decided revision carries even when it is not the newest.
  await publish(client, {
    id: id(12),
    family: "statement_transaction",
    subject: { kind: "statement_transaction" },
    createdAt: "2026-01-02T00:00:00Z",
    state: { ...statement("s", "old"), status: "superseded", active: false },
  });
  await feedback(client, {
    id: id(112),
    assessmentId: id(12),
    operationId: "unapplied-correction",
    verdict: "wrong",
    authority: "member",
    intent: "apply",
    actorUserId: MEMBER,
    correction: { present: true, value: { kind: "synthetic" } },
  });
  // Automatic money receipts carry with the applied row.
  await publish(client, {
    id: id(13),
    family: "statement_transaction",
    subject: { kind: "statement_transaction" },
    state: { ...statement("s", "applied"), status: "applied", active: true },
  });
  await feedback(client, {
    id: id(113),
    assessmentId: id(13),
    operationId: "application",
    verdict: "correct",
    authority: "automatic",
    intent: "apply",
    receipt: { kind: "statement_transaction", auditIds: [] },
    metadata: { kind: "assessment_application" },
  });
  // Pending connections: wide evidence slims; the stale relations drop.
  await publish(client, {
    id: id(20),
    family: "recommendation",
    subject: connectionSubject("expense-project"),
    evidence: connectionEvidence,
    fingerprint: "connection-20",
    state: { entity: "expense" },
  });
  await publish(client, {
    id: id(21),
    family: "recommendation",
    subject: connectionSubject("transaction-purchase"),
    evidence: connectionEvidence,
    state: { entity: "expense" },
  });
  // Member input carries in any relation, with its suppression.
  await publish(client, {
    id: id(22),
    family: "recommendation",
    subject: connectionSubject("transaction-refund"),
    evidence: connectionEvidence,
    state: {
      entity: "expense",
      status: "resolved",
      suppression: { scope: "connection.transaction-refund", candidateKey: "k", fingerprint: null },
    },
  });
  await feedback(client, {
    id: id(122),
    assessmentId: id(22),
    operationId: "never-suggest",
    verdict: "wrong",
    authority: "member",
    actorUserId: MEMBER,
  });
}

const count = async (client: Db, statement: string) =>
  Number((await client.query(statement)).rows[0].count);

describe("Suggestion table migration", () => {
  it("carries every decision and moves the ledgers to the archive unchanged", async () =>
    await withMigrationDatabase(async (client) => {
      const db = drizzle(client);
      await migrateDatabase(db, { through: PREDECESSOR });
      await seedPredecessor(client);
      const snapshot = async (schema: string) => ({
        assessments: (
          await client.query(`SELECT * FROM ${schema}"Assessment" ORDER BY id`)
        ).rows,
        states: (
          await client.query(`SELECT * FROM ${schema}"AssessmentState" ORDER BY id`)
        ).rows,
        events: (
          await client.query(`SELECT * FROM ${schema}"Feedback" ORDER BY id`)
        ).rows,
      });
      const before = await snapshot("");
      const tickets = () => count(client, `SELECT count(*) FROM "WorkItem"`);
      const queued = await tickets();
      await migrateDatabase(db);

      expect(await snapshot("archive.")).toEqual(before);
      // Copying is not a source change: no population is enrolled.
      expect(await tickets()).toBe(queued);
      expect(
        await count(
          client,
          `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
           AND tgrelid IN ('archive."Assessment"'::regclass, 'archive."AssessmentState"'::regclass, 'archive."Feedback"'::regclass)`,
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          `SELECT count(*) FROM pg_constraint WHERE contype = 'f'
           AND (conrelid IN ('archive."Assessment"'::regclass, 'archive."AssessmentState"'::regclass, 'archive."Feedback"'::regclass)
             OR confrelid IN ('archive."Assessment"'::regclass, 'archive."AssessmentState"'::regclass, 'archive."Feedback"'::regclass))`,
        ),
      ).toBe(0);

      const rows = (
        await client.query(`SELECT * FROM "Suggestion" ORDER BY id`)
      ).rows;
      expect(rows.map((row) => row.id)).toEqual(
        [1, 2, 11, 12, 13, 20, 22].map(id),
      );
      const row = (n: number) => rows.find((entry) => entry.id === id(n));

      const decisions = row(1).decisions;
      expect(decisions).toMatchObject([
        {
          id: id(101),
          operationId: "review-null",
          authority: "member",
          actorUserId: MEMBER,
          intent: "apply",
          reason: "Synthetic reason",
          createdAt: "2026-01-02T03:04:05.678901Z",
        },
        { id: id(102), verdict: "uncertain", intent: "history" },
      ]);
      // Corrected null stays distinct from no correction.
      expect(decisions[0].correction).toEqual({ present: true, value: null });
      expect(decisions[1].correction).toEqual({ present: false });
      expect(row(1).acceptanceReceipt).toEqual({ auditIds: [] });
      expect(row(1).served).toBe(false);
      expect(row(2).decisions).toEqual([]);

      expect(row(12).decisions[0].correction.present).toBe(true);
      expect(row(13).decisions[0]).toMatchObject({
        authority: "automatic",
        receipt: { kind: "statement_transaction" },
      });

      expect(row(20).evidence).toEqual({
        version: 1,
        candidate: connectionEvidence.candidate,
      });
      expect(row(20).fingerprint).toBe("connection-20");
      expect(row(22).suppression).toMatchObject({ candidateKey: "k" });
      expect(row(22).decisions[0].verdict).toBe("wrong");
    }));

  it("aborts on a Feedback category nothing accounts for, leaving every table in place", async () =>
    await withMigrationDatabase(async (client) => {
      const db = drizzle(client);
      await migrateDatabase(db, { through: PREDECESSOR });
      await seedPredecessor(client);
      await client.query(
        `INSERT INTO "Assessment" (id, "publicationKey", family, subject, judgment, served)
         VALUES ($1, 'synthetic:sample', 'evaluation_sample', '{"kind":"evaluation_sample"}', '{}', false)`,
        [id(30)],
      );
      await feedback(client, {
        id: id(130),
        assessmentId: id(30),
        operationId: "grade",
        verdict: "wrong",
        authority: "member",
        actorUserId: MEMBER,
      });
      const failure: unknown = await migrateDatabase(db).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(
        String((failure as Error).cause ?? (failure as Error).message),
      ).toContain("Unaccounted Feedback categories");
      expect(await count(client, `SELECT count(*) FROM "Assessment"`)).toBe(10);
      expect(
        (await client.query(`SELECT to_regclass('public."Suggestion"') AS t`))
          .rows[0].t,
      ).toBeNull();
    }));
});
