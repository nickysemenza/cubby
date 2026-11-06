import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PREDECESSOR = "0073_image_jobs_own_execution";

type Db = Client | PoolClient;

/** A retired copy source at the final predecessor shape, written directly. */
async function publish(
  client: Db,
  input: {
    id: string;
    family: string;
    publicationKey?: string;
    subject: unknown;
    judgment: unknown;
    fingerprint?: string | null;
    producer?: unknown;
    evidence?: unknown;
    createdAt?: string;
    state?: {
      entity: string;
      recordId: string;
      status: string;
      active: boolean;
      data?: unknown;
      runId?: string | null;
      ledgerPartyId?: string | null;
    };
  },
) {
  await client.query(
    `INSERT INTO "Assessment" (id, "publicationKey", family, subject, judgment, fingerprint, producer, evidence, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamp, now()))`,
    [
      input.id,
      input.publicationKey ?? `synthetic:${input.id}`,
      input.family,
      input.subject,
      JSON.stringify(input.judgment),
      input.fingerprint ?? null,
      input.producer ?? null,
      input.evidence ?? null,
      input.createdAt ?? null,
    ],
  );
  if (input.state)
    await client.query(
      `INSERT INTO "AssessmentState" (id, family, entity, "recordId", status, active, data, fingerprint, "runId", "ledgerPartyId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.id,
        input.family,
        input.state.entity,
        input.state.recordId,
        input.state.status,
        input.state.active,
        input.state.data ?? {},
        input.fingerprint ?? null,
        input.state.runId ?? null,
        input.state.ledgerPartyId ?? null,
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
    actorUserId?: string | null;
    intent?: string;
    correction?: unknown;
    reason?: string | null;
    metadata?: unknown;
    createdAt?: string;
    projection?: unknown;
  },
) {
  await client.query(
    `INSERT INTO "Feedback" (id, "assessmentId", "operationId", verdict, correction, reason, intent, authority, "actorUserId", metadata, projection, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamp, now()))`,
    [
      input.id,
      input.assessmentId,
      input.operationId,
      input.verdict,
      input.correction ?? { present: false },
      input.reason ?? null,
      input.intent ?? "history",
      input.authority,
      input.actorUserId ?? null,
      input.metadata ?? null,
      input.projection ?? null,
      input.createdAt ?? null,
    ],
  );
}

const MEMBER = "synthetic-member";

/** Every retained shape the cutover carries, as production stored them. */
async function seedPredecessor(client: Db) {
  await client.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Synthetic member', 'synthetic@example.test')`,
    [MEMBER],
  );
  const party = id(1);
  await client.query(
    `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'ledgerParty', 'LPY-SYN1')`,
    [party],
  );
  await client.query(
    `INSERT INTO "LedgerParty" (id, shortcode, name, kind, "userId") VALUES ($1, 'LPY-SYN1', 'Synthetic member', 'member', $2)`,
    [party, MEMBER],
  );
  await client.query(
    `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'run', 'RUN-SYN1')`,
    [id(2)],
  );
  await client.query(
    `INSERT INTO "Run" (id, shortcode, purpose, trigger, status, "ledgerPartyId", "actorName", "actorEmail", "actorUserId", "actorLedgerPartyShortcode")
     VALUES ($1, 'RUN-SYN1', 'mail_import', 'manual', 'completed', $2, 'Synthetic member', 'synthetic@example.test', $3, 'LPY-SYN1')`,
    [id(2), party, MEMBER],
  );
  // Linked Email, an Email protected only through its original, and a removed one.
  for (const [n, message] of [
    [10, "synthetic-linked"],
    [11, "synthetic-original-branch"],
    [12, "synthetic-unprotected"],
    [13, "synthetic-only-resolved"],
  ] as const) {
    await client.query(
      `INSERT INTO "OrderMail" (id, "ledgerPartyId", "rawChecksum")
       VALUES ($1, $2, 'synthetic-checksum')`,
      [id(n + 100), party],
    );
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'email', $2)`,
      [id(n), `EML-SYN${n}`],
    );
    await client.query(
      `INSERT INTO "Email" (id, shortcode, "ledgerPartyId", provider, "mailboxId", "messageId", checksum, status, "orderMailId", classification, "classificationStage")
       VALUES ($1, $2, $3, 'gmail', 'synthetic-mailbox', $4, 'synthetic-checksum', 'pending', $5, 'related', 'decision')`,
      [id(n), `EML-SYN${n}`, party, message, id(n + 100)],
    );
  }
  for (const n of [20, 21]) {
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'vendor', $2)`,
      [id(n + 10), `VEN-SYN${n}`],
    );
    await client.query(
      `INSERT INTO "Vendor" (id, shortcode, name) VALUES ($1, $2, $3)`,
      [id(n + 10), `VEN-SYN${n}`, `Synthetic vendor ${n}`],
    );
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'purchase', $2)`,
      [id(n), `PUR-SYN${n}`],
    );
    await client.query(
      `INSERT INTO "Purchase" (id, shortcode, "vendorId") VALUES ($1, $2, $3)`,
      [id(n), `PUR-SYN${n}`, id(n + 10)],
    );
  }
  for (const [n, original] of [
    [40, 110],
    [41, 110],
    [42, 111],
  ] as const)
    await client.query(
      `INSERT INTO "OrderMailEvent" (id, "orderMailId", event, "orderId", "sourceKey")
       VALUES ($1, $2, 'placed', $3, $4)`,
      [id(n), id(original), `SYN-${n}`, `synthetic-event-${n}`],
    );

  const link = (
    n: number,
    input: {
      event: number;
      purchase: number;
      decision: string;
      proposedBy: string | null;
      status: string;
      active: boolean;
      recordId: string | null;
      original: number;
      stateEntity?: string;
    },
  ) =>
    publish(client, {
      id: id(n),
      family: "email_link",
      subject: {
        kind: "email_link",
        entity: "email",
        recordId: input.recordId,
        originalId: id(input.original),
        eventId: id(input.event),
        purchaseId: id(input.purchase),
        checksum: "synthetic-checksum",
      },
      judgment: { decision: input.decision },
      fingerprint: "synthetic-checksum",
      state: {
        entity: input.stateEntity ?? "email",
        recordId: input.stateEntity
          ? id(input.event)
          : (input.recordId ?? id(0)),
        status: input.status,
        active: input.active,
        data: {
          eventId: id(input.event),
          purchaseId: id(input.purchase),
          decision: input.decision,
          evidenceChecksum: "synthetic-checksum",
          decidedByUserId: MEMBER,
          proposedBy: input.proposedBy,
        },
      },
    });
  // Current automatic link with a superseded predecessor on one event.
  await link(50, {
    event: 40,
    purchase: 20,
    decision: "linked",
    proposedBy: "agent",
    status: "resolved",
    active: true,
    recordId: id(10),
    original: 110,
  });
  await feedback(client, {
    id: id(250),
    assessmentId: id(50),
    operationId: "decision",
    verdict: "correct",
    authority: "automatic",
    actorUserId: MEMBER,
    intent: "apply",
    correction: { present: true, value: { decision: "linked" } },
    metadata: { kind: "email_link" },
  });
  await link(51, {
    event: 40,
    purchase: 21,
    decision: "linked",
    proposedBy: null,
    status: "superseded",
    active: false,
    recordId: id(10),
    original: 110,
  });
  await feedback(client, {
    id: id(251),
    assessmentId: id(51),
    operationId: "legacy-decision",
    verdict: "ungraded",
    authority: "unknown",
    actorUserId: MEMBER,
    intent: "apply",
    correction: { present: true, value: { decision: "linked" } },
  });
  // A member dismissal, which has no other domain copy.
  await link(52, {
    event: 41,
    purchase: 21,
    decision: "dismissed",
    proposedBy: "member",
    status: "resolved",
    active: true,
    recordId: id(10),
    original: 110,
  });
  await feedback(client, {
    id: id(252),
    assessmentId: id(52),
    operationId: "decision",
    verdict: "dismissed",
    authority: "member",
    actorUserId: MEMBER,
    correction: { present: true, value: { decision: "dismissed" } },
    metadata: { kind: "email_link" },
  });
  // Decided before its Email existed: protection reaches it through the original.
  await link(53, {
    event: 42,
    purchase: 20,
    decision: "linked",
    proposedBy: "member",
    status: "resolved",
    active: true,
    recordId: null,
    original: 111,
    stateEntity: "orderMailEvent",
  });
  await feedback(client, {
    id: id(253),
    assessmentId: id(53),
    operationId: "decision",
    verdict: "correct",
    authority: "member",
    actorUserId: MEMBER,
    intent: "apply",
    correction: { present: true, value: { decision: "linked" } },
    metadata: { kind: "email_link" },
  });

  // Predictions: labelled, member-resolved, applied, observed and unrecorded.
  const prediction = async (
    n: number,
    input: {
      email: number;
      checksum: string | null;
      classification: string;
      stage: string | null;
    },
  ) => {
    await client.query(
      `INSERT INTO "EmailClassificationObservation" (id, "emailId", checksum, classification, stage)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id(n),
        id(input.email),
        input.checksum,
        input.classification,
        input.stage,
      ],
    );
    await publish(client, {
      id: id(n + 100),
      family: "email_relevance",
      publicationKey: `email-observation:${id(n)}`,
      subject: {
        kind: "email_relevance",
        entity: "email",
        recordId: id(input.email),
        checksum: input.checksum,
        observationId: id(n),
      },
      judgment: { classification: input.classification, stage: input.stage },
      fingerprint: input.checksum,
      evidence: {
        checksum: input.checksum,
        provenance: null,
        originalCapture: { status: "synthetic" },
      },
      state: {
        entity: "email",
        recordId: id(input.email),
        status: "pending",
        active: true,
      },
    });
    return id(n + 100);
  };
  const labelled = await prediction(60, {
    email: 10,
    checksum: "synthetic-checksum",
    classification: "related",
    stage: "decision",
  });
  await feedback(client, {
    id: id(260),
    assessmentId: labelled,
    operationId: "synthetic-label-old",
    verdict: "wrong",
    authority: "member",
    actorUserId: MEMBER,
    correction: { present: true, value: "unrelated" },
    reason: "Synthetic older label",
    metadata: { kind: "email_label" },
    createdAt: "2026-01-01T00:00:00Z",
  });
  await feedback(client, {
    id: id(261),
    assessmentId: labelled,
    operationId: "synthetic-label-new",
    verdict: "correct",
    authority: "member",
    actorUserId: MEMBER,
    reason: "Synthetic newer label",
    metadata: { kind: "email_label" },
    createdAt: "2026-01-02T00:00:00Z",
  });
  // A grade without a label, and an explicit JSON null correction.
  await feedback(client, {
    id: id(262),
    assessmentId: labelled,
    operationId: "synthetic-uncertain",
    verdict: "uncertain",
    authority: "member",
    actorUserId: MEMBER,
    metadata: { kind: "email_label" },
    createdAt: "2026-01-03T00:00:00Z",
  });
  await feedback(client, {
    id: id(263),
    assessmentId: labelled,
    operationId: "synthetic-null-correction",
    verdict: "wrong",
    authority: "member",
    actorUserId: MEMBER,
    correction: { present: true, value: null },
    metadata: { kind: "email_label" },
    createdAt: "2026-01-04T00:00:00Z",
  });
  // Independent grades stay in the ledger only.
  await feedback(client, {
    id: id(264),
    assessmentId: labelled,
    operationId: "synthetic-grade",
    verdict: "wrong",
    authority: "evaluation",
    correction: { present: true, value: "unrelated" },
    metadata: { kind: "email_accuracy" },
  });
  const staleChecksum = await prediction(61, {
    email: 11,
    checksum: "synthetic-other-checksum",
    classification: "uncertain",
    stage: "model",
  });
  await feedback(client, {
    id: id(265),
    assessmentId: staleChecksum,
    operationId: "synthetic-other-original",
    verdict: "correct",
    authority: "member",
    actorUserId: MEMBER,
    correction: { present: true, value: "related" },
    metadata: { kind: "email_label" },
  });
  const applied = await prediction(62, {
    email: 12,
    checksum: "synthetic-checksum",
    classification: "unrelated",
    stage: "decision",
  });
  await feedback(client, {
    id: id(266),
    assessmentId: applied,
    operationId: "classification-observed",
    verdict: "ungraded",
    authority: "automatic",
    metadata: { kind: "email_classification_observation" },
  });
  await feedback(client, {
    id: id(267),
    assessmentId: applied,
    operationId: "classification-applied",
    verdict: "ungraded",
    authority: "automatic",
    metadata: { kind: "email_classification_application" },
  });
  const observedOnly = await prediction(63, {
    email: 12,
    checksum: "synthetic-checksum",
    classification: "related",
    stage: "model",
  });
  await feedback(client, {
    id: id(268),
    assessmentId: observedOnly,
    operationId: "classification-observed",
    verdict: "ungraded",
    authority: "automatic",
    metadata: { kind: "email_classification_observation" },
  });
  // Not member-only: an agent's settlement resolution protects its Email.
  const settled = await prediction(64, {
    email: 11,
    checksum: "synthetic-checksum",
    classification: "unrelated",
    stage: "resolution",
  });
  await feedback(client, {
    id: id(269),
    assessmentId: settled,
    operationId: "resolution",
    verdict: "correct",
    authority: "automatic",
    actorUserId: MEMBER,
    intent: "apply",
    correction: { present: true, value: "unrelated" },
    metadata: { kind: "email_resolution" },
  });
  await prediction(65, {
    email: 12,
    checksum: "synthetic-checksum",
    classification: "uncertain",
    stage: "decision",
  });
  // Its only protection is an agent's settlement.
  const onlyResolved = await prediction(66, {
    email: 13,
    checksum: "synthetic-checksum",
    classification: "unrelated",
    stage: "resolution",
  });
  await feedback(client, {
    id: id(273),
    assessmentId: onlyResolved,
    operationId: "resolution",
    verdict: "correct",
    authority: "automatic",
    actorUserId: MEMBER,
    intent: "apply",
    correction: { present: true, value: "unrelated" },
    metadata: { kind: "email_resolution" },
  });

  // A resolved finding, a dismissed one with unknown authority, an open one.
  const finding = async (
    n: number,
    input: {
      status: string;
      kind: string;
      proposedFix?: unknown;
      expiresAt?: string | null;
      runId?: string | null;
    },
  ) =>
    publish(client, {
      id: id(n),
      family: "run_finding",
      publicationKey: `run_finding:v1:${party}:purchase:${id(20)}:${input.kind}:evidence-${n}`,
      subject: {
        kind: "run_finding",
        entity: "purchase",
        recordId: id(20),
        ledgerPartyId: party,
      },
      judgment: {
        kind: input.kind,
        summary: `Synthetic finding ${n}`,
        proposedFix: input.proposedFix ?? null,
        probability: 0.5,
      },
      fingerprint: `evidence-${n}`,
      state: {
        entity: "purchase",
        recordId: id(20),
        status: input.status,
        active: true,
        runId: input.runId === undefined ? id(2) : input.runId,
        ledgerPartyId: party,
        data: {
          kind: input.kind,
          summary: `Synthetic finding ${n}`,
          proposedFix: input.proposedFix ?? null,
          probability: 0.5,
          expiresAt: input.expiresAt ?? null,
        },
      },
    });
  await finding(70, { status: "applied", kind: "arrived" });
  await feedback(client, {
    id: id(270),
    assessmentId: id(70),
    operationId: "resolution",
    verdict: "correct",
    authority: "member",
    actorUserId: MEMBER,
    intent: "apply",
  });
  await finding(71, { status: "rejected", kind: "other", runId: null });
  await feedback(client, {
    id: id(271),
    assessmentId: id(71),
    operationId: "legacy-resolution",
    verdict: "dismissed",
    authority: "unknown",
  });
  await feedback(client, {
    id: id(272),
    assessmentId: id(71),
    operationId: "projection:synthetic",
    verdict: "ungraded",
    authority: "system",
    intent: "projection",
    projection: { status: "rejected" },
  });
  await finding(72, {
    status: "pending",
    kind: "refund",
    proposedFix: { kind: "create_refund", purchaseId: "PUR-SYN20", amount: 1 },
    expiresAt: "2030-01-01T00:00:00.000Z",
  });

  // Settled twice on one checksum: the transaction timestamp names each receipt.
  await settlementReceipt(client, 81, "unresolved", "2026-02-01T00:00:00Z");
  await settlementReceipt(client, 80, "completed", "2026-02-02T00:00:00Z");
  await settledOutcome(
    client,
    90,
    { kind: "unresolved", reason: "Synthetic gap" },
    "2026-02-01T00:00:00Z",
  );
  await settledOutcome(
    client,
    91,
    { kind: "linked", event: "placed", purchases: [] },
    "2026-02-02T00:00:00Z",
  );
  await feedback(client, {
    id: id(290),
    assessmentId: id(91),
    operationId: "synthetic-grade",
    verdict: "wrong",
    authority: "member",
    actorUserId: MEMBER,
  });
}

/** A predecessor settlement's receipt; without a time, its transaction's. */
const settlementReceipt = (
  client: Db,
  n: number,
  state: string,
  createdAt?: string,
) =>
  client.query(
    `INSERT INTO "RunOperation" (id, "runId", "operationId", kind, state, "inputFingerprint", "completedAt", "createdAt", result)
     VALUES ($1, $2, $3, 'target_outcome', 'completed', 'synthetic', COALESCE($4::timestamp, now()), COALESCE($4::timestamp, now()), $5)`,
    [
      id(n),
      id(2),
      `mail-outcome:synthetic-${n}`,
      createdAt ?? null,
      {
        target: {
          entityKind: "email",
          entityId: id(10),
          workKey: id(110),
          state,
          outcome: "verified",
          warning: null,
          diff: null,
          completedAt: "2026-02-01T00:00:00.000Z",
          targetFingerprint: "synthetic-checksum",
        },
      },
    ],
  );

/** A predecessor settlement's outcome Assessment and current State. */
const settledOutcome = (
  client: Db,
  n: number,
  judgment: unknown,
  createdAt?: string,
) =>
  publish(client, {
    id: id(n),
    family: "mail_import_outcome",
    subject: {
      kind: "mail_import_outcome",
      entity: "email",
      recordId: id(10),
      checksum: "synthetic-checksum",
      runId: id(2),
    },
    judgment,
    fingerprint: `outcome-${n}`,
    producer: {
      kind: "agent",
      model: null,
      revision: null,
      runId: id(2),
      evaluationId: null,
    },
    evidence: { checksum: "synthetic-checksum" },
    createdAt,
    state: {
      entity: "email",
      recordId: id(10),
      status: "pending",
      active: true,
      runId: id(2),
    },
  });

async function snapshot(client: Db) {
  const rows = async (statement: string) =>
    (await client.query(statement)).rows;
  return {
    assessments: await rows(`SELECT * FROM "Assessment" ORDER BY id`),
    states: await rows(`SELECT * FROM "AssessmentState" ORDER BY id`),
    feedback: await rows(`SELECT * FROM "Feedback" ORDER BY id`),
  };
}

const migration = () =>
  readFile(
    join(import.meta.dirname, "../drizzle/0074_mail_decision_owners.sql"),
    "utf8",
  );

describe("mail decision owners migration", () => {
  it("carries every decision, label, intent and finding, leaving the ledgers untouched", async () => {
    await withMigrationDatabase(async (client) => {
      const db = drizzle(client);
      await migrateDatabase(db, { through: PREDECESSOR });
      await seedPredecessor(client);
      const before = await snapshot(client);
      const tickets = async () =>
        Number(
          (await client.query(`SELECT count(*) AS n FROM "WorkItem"`)).rows[0]
            .n,
        );
      const queued = await tickets();
      await migrateDatabase(db, { through: "0074_mail_decision_owners" });

      expect(await snapshot(client)).toEqual(before);
      const labelled = id(160);
      // Copying is not a source change: no population is enrolled.
      expect(await tickets()).toBe(queued);

      const decisions = (
        await client.query(`SELECT * FROM "EmailPurchaseDecision" ORDER BY id`)
      ).rows;
      expect(decisions).toMatchObject([
        {
          id: id(50),
          eventId: id(40),
          purchaseId: id(20),
          decision: "linked",
          proposedBy: "agent",
          authority: "automatic",
          status: "resolved",
          active: true,
          emailId: id(10),
          originalId: id(110),
        },
        {
          id: id(51),
          proposedBy: null,
          authority: "unknown",
          status: "superseded",
          active: false,
        },
        {
          id: id(52),
          decision: "dismissed",
          authority: "member",
          active: true,
        },
        { id: id(53), emailId: null, originalId: id(111), active: true },
      ]);
      // The moved one-link index holds: a second link on the event conflicts.
      await expect(
        client.query(
          `INSERT INTO "EmailPurchaseDecision" ("eventId", "purchaseId", decision, "evidenceChecksum", "decidedByUserId", authority, "originalId")
           VALUES ($1, $2, 'linked', 'synthetic-checksum', $3, 'automatic', $4)`,
          [id(40), id(21), MEMBER, id(110)],
        ),
      ).rejects.toThrow("EmailPurchaseDecision_one_link_key");

      const reviews = new Map(
        (await client.query(`SELECT * FROM "EmailReview"`)).rows.map((row) => [
          row.id,
          row,
        ]),
      );
      expect([...reviews.keys()].sort()).toEqual(
        [250, 252, 253, 260, 261, 262, 263, 265, 269, 273, 290].map(id).sort(),
      );
      expect(reviews.get(id(260))).toMatchObject({
        family: "email_relevance",
        subjectId: id(60),
        emailId: id(10),
        classification: "unrelated",
        reason: "Synthetic older label",
      });
      expect(reviews.get(id(261))).toMatchObject({ classification: "related" });
      expect(reviews.get(id(262))).toMatchObject({ classification: null });
      // JSON null stays an explicit correction, without becoming a label.
      expect(reviews.get(id(263))).toMatchObject({
        classification: null,
        correction: { present: true, value: null },
      });
      expect(reviews.get(id(253))).toMatchObject({
        family: "email_link",
        emailId: null,
        originalId: id(111),
      });
      expect(reviews.get(id(269))).toMatchObject({
        authority: "automatic",
        classification: "unrelated",
      });

      const applications = Object.fromEntries(
        (
          await client.query(
            `SELECT id, application FROM "EmailClassificationObservation"`,
          )
        ).rows.map((row) => [row.id, row.application]),
      );
      expect(applications).toMatchObject({
        [id(62)]: "applied",
        [id(63)]: "observed",
        [id(64)]: "applied",
        [id(65)]: "unverified",
      });
      expect(
        (
          await client.query(
            `SELECT publication FROM "EmailClassificationObservation" WHERE id = $1`,
            [id(62)],
          )
        ).rows,
      ).toEqual([
        { publication: { originalCapture: { status: "synthetic" } } },
      ]);

      const findings = (
        await client.query(`SELECT * FROM "RunFinding" ORDER BY id`)
      ).rows;
      expect(findings).toMatchObject([
        {
          id: id(70),
          status: "applied",
          publicationKey: `run_finding:v1:${id(1)}:purchase:${id(20)}:arrived:evidence-70`,
          resolutions: [
            { id: id(270), authority: "member", actorUserId: MEMBER },
          ],
        },
        {
          id: id(71),
          status: "rejected",
          runId: null,
          resolutions: [
            { id: id(271), authority: "unknown", verdict: "dismissed" },
          ],
        },
        {
          id: id(72),
          status: "pending",
          proposedFix: { kind: "create_refund" },
          resolutions: [],
          expiresAt: expect.any(Date),
        },
      ]);

      // Each outcome lands on the receipt its own settlement wrote.
      const outcomes = (
        await client.query(
          `SELECT "operationId", result FROM "RunOperation"
           WHERE result ? 'mailOutcome' ORDER BY result #>> '{mailOutcome,id}'`,
        )
      ).rows;
      expect(outcomes).toMatchObject([
        {
          operationId: "mail-outcome:synthetic-81",
          result: {
            mailOutcome: { id: id(90), judgment: { kind: "unresolved" } },
            target: { state: "unresolved" },
          },
        },
        {
          operationId: "mail-outcome:synthetic-80",
          result: {
            mailOutcome: { id: id(91), fingerprint: "outcome-91" },
            target: { state: "completed" },
          },
        },
      ]);

      // A stale Worker cannot keep writing what nothing reads any more.
      await expect(
        client.query(
          `UPDATE "AssessmentState" SET status = 'rejected' WHERE id = $1`,
          [id(72)],
        ),
      ).rejects.toThrow("moved to its domain owner");
      // Its review would commit where nothing reads it, even with no State change.
      const events = await client.query(`SELECT count(*) FROM "Feedback"`);
      await expect(
        feedback(client, {
          id: id(299),
          assessmentId: labelled,
          operationId: "synthetic-after-cutover",
          verdict: "uncertain",
          authority: "member",
          actorUserId: MEMBER,
        }),
      ).rejects.toThrow("moved to its domain owner");
      expect(
        (await client.query(`SELECT count(*) FROM "Feedback"`)).rows,
      ).toEqual(events.rows);
      expect(
        (
          await client.query(
            `SELECT to_regclass('"AssessmentEmailLink"') AS relation, to_regclass('pg_temp.mail_outcome_pairs') AS temp`,
          )
        ).rows,
      ).toEqual([{ relation: null, temp: null }]);
    });
  });

  // Each fault breaks one row's mapping; the deployment must abort on that check.
  const withoutCheck = (sql: string, label: string) => {
    const check = new RegExp(
      `SELECT pg_temp\\.mail_cutover_assert_same\\('${label}'[\\s\\S]*?\\$check\\$\\);`,
    );
    expect(sql).toMatch(check);
    return sql.replace(check, "");
  };
  it.each([
    {
      label: "email purchase decisions",
      patch: (sql: string) =>
        sql.replace(
          `s.data->>'proposedBy',
  COALESCE(decided.authority, 'unknown')`,
          `NULL,
  COALESCE(decided.authority, 'unknown')`,
        ),
    },
    {
      // The check a missed link depends on, independently of the row check.
      label: "Emails with an accepted association",
      patch: (sql: string) =>
        withoutCheck(sql, "email purchase decisions").replace(
          `WHERE s.family = 'email_link';`,
          `WHERE s.family = 'email_link' AND s.id <> '${id(50)}';`,
        ),
    },
    {
      label: "member relevance labels",
      patch: (sql: string) =>
        sql.replace(
          `WHERE (
    (a.family IN ('email_relevance', 'email_link')`,
          `WHERE f.id <> '${id(261)}' AND (
    (a.family IN ('email_relevance', 'email_link')`,
        ),
    },
    {
      label: "protecting intent events per Email",
      patch: (sql: string) =>
        sql.replace(
          `WHERE (
    (a.family IN ('email_relevance', 'email_link')`,
          `WHERE f.id <> '${id(273)}' AND (
    (a.family IN ('email_relevance', 'email_link')`,
        ),
    },
    {
      label: "run findings",
      patch: (sql: string) =>
        sql.replace(
          `SELECT s.id, a."publicationKey", s."runId"`,
          `SELECT s.id, a."publicationKey" || ':changed', s."runId"`,
        ),
    },
    {
      label: "retained Email reviews",
      patch: (sql: string) =>
        sql.replace(
          `f.evidence, f.intent, f.authority`,
          `f.evidence, 'apply', f.authority`,
        ),
    },
    {
      label: "run finding resolutions",
      patch: (sql: string) =>
        sql.replace(
          `'createdAt', to_char(f."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY`,
          `'createdAt', '2000-01-01T00:00:00.000Z') ORDER BY`,
        ),
    },
    {
      label: "mail import outcomes",
      patch: (sql: string) =>
        sql.replace(
          `'fingerprint', a.fingerprint, 'createdAt'`,
          `'fingerprint', NULL, 'createdAt'`,
        ),
    },
  ])("aborts on a mismatch: $label", async ({ label, patch }) => {
    expect(await abortMessage(patch)).toContain(
      `preservation failed: ${label}`,
    );
  });

  // New events in an unnamed category and unprovable pairings stop the deploy.
  it.each([
    {
      label: "Feedback accounting",
      seed: (client: Db) =>
        feedback(client, {
          id: id(298),
          assessmentId: id(50),
          operationId: "synthetic-unnamed",
          verdict: "ungraded",
          authority: "automatic",
          metadata: { kind: "synthetic_unnamed" },
        }),
    },
    {
      label: "mail import outcome pairing",
      seed: (client: Db) =>
        settledOutcome(
          client,
          92,
          { kind: "unresolved", reason: "Synthetic orphan" },
          "2026-02-03T00:00:00Z",
        ),
    },
  ])("aborts on unproven source rows: $label", async ({ label, seed }) => {
    expect(await abortMessage((sql) => `${sql} `, seed)).toContain(
      `preservation failed: ${label}`,
    );
  });

  /** The real statements with one fault; the rollback must leave no trace. */
  const abortMessage = (
    patch: (sql: string) => string,
    seed?: (client: Db) => Promise<void>,
  ) =>
    withMigrationDatabase(async (client) => {
      const db = drizzle(client);
      await migrateDatabase(db, { through: PREDECESSOR });
      await seedPredecessor(client);
      await seed?.(client);
      const before = await snapshot(client);
      const original = await migration();
      const broken = patch(original);
      expect(broken).not.toBe(original);
      await client.query("BEGIN");
      const message = await client
        .query(broken.replaceAll("--> statement-breakpoint", ""))
        .then(
          () => "The migration did not abort",
          (error: Error) => error.message,
        );
      await client.query("ROLLBACK");
      expect(await snapshot(client)).toEqual(before);
      expect(
        (
          await client.query(
            `SELECT to_regclass('"EmailPurchaseDecision"') AS relation`,
          )
        ).rows,
      ).toEqual([{ relation: null }]);
      return message;
    });

  const blockedOn = async (observer: Client, table: string) => {
    await expect
      .poll(
        async () =>
          (
            await observer.query(
              `SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND relation = $1::regclass`,
              [`"${table}"`],
            )
          ).rows[0].n,
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
  };
  const applied = async (client: Client) =>
    (
      await client.query(
        `SELECT result #>> '{mailOutcome,id}' AS id FROM "RunOperation" WHERE result ? 'mailOutcome'`,
      )
    ).rows.map((row) => row.id);

  // Settlement writes Email before the ledgers, so the migration waits at Email
  // with no ledger lock held and takes the settlement's rows when it commits.
  it("waits for a settlement already holding Email, then carries its outcome", async () => {
    await withMigrationDatabase(async (client, databaseUrl) => {
      const db = drizzle(client);
      await migrateDatabase(db, { through: PREDECESSOR });
      await seedPredecessor(client);
      const settlement = new Client({ connectionString: databaseUrl });
      await settlement.connect();
      try {
        await settlement.query("BEGIN");
        await settlement.query(
          `UPDATE "Email" SET status = 'completed' WHERE id = $1`,
          [id(10)],
        );
        const migrating = migrateDatabase(db, {
          through: "0074_mail_decision_owners",
        });
        await blockedOn(settlement, "Email");
        await settledOutcome(settlement, 93, {
          kind: "unresolved",
          reason: "Synthetic late settlement",
        });
        await settlementReceipt(settlement, 83, "unresolved");
        await settlement.query("COMMIT");
        await migrating;
      } finally {
        await settlement.end();
      }
      expect(await applied(client)).toContain(id(93));
    });
  });

  // A decision writes the ledgers before Email, the one order no sequence can
  // match. Postgres breaks the cycle; a killed migration rolls back and retries.
  it("survives a writer that reaches the ledgers before Email", async () => {
    await withMigrationDatabase(async (client, databaseUrl) => {
      const db = drizzle(client);
      await migrateDatabase(db, { through: PREDECESSOR });
      await seedPredecessor(client);
      const writer = new Client({ connectionString: databaseUrl });
      await writer.connect();
      try {
        await writer.query("BEGIN");
        await settledOutcome(writer, 94, {
          kind: "unresolved",
          reason: "Synthetic crossing writer",
        });
        const migrating = migrateDatabase(db, {
          through: "0074_mail_decision_owners",
          lockRetryDelayMs: 0,
        });
        await blockedOn(writer, "Assessment");
        // The deadlock victim is either side; an old request may fail.
        const victimCode = await writer
          .query(`UPDATE "Email" SET status = 'completed' WHERE id = $1`, [
            id(10),
          ])
          .then(async () => {
            await settlementReceipt(writer, 84, "unresolved");
            await writer.query("COMMIT");
            return null;
          })
          .catch(async (error: { code?: string }) => {
            await writer.query("ROLLBACK");
            return error.code ?? "unknown";
          });
        expect([null, "40P01"]).toContain(victimCode);
        await migrating;
        expect((await applied(client)).includes(id(94))).toBe(
          victimCode === null,
        );
      } finally {
        await writer.end();
      }
      expect(
        (await client.query(`SELECT count(*)::int AS n FROM "RunFinding"`))
          .rows,
      ).toEqual([{ n: 3 }]);
    });
  });
});
