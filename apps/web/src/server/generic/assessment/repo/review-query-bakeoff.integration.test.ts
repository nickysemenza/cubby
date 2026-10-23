import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  assessmentProducer,
  feedbackAuthority,
} from "@cubby/schemas/assessment";
import { mailboxClassificationStage } from "@cubby/schemas/mailbox-research";
import { sql, type SQL } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { unwrapDb, withTransactionDatabase } from "~/server/db/helpers";
import { assessment, assessmentState, feedback } from "~/server/db/schema";

import {
  EMAIL_APPLICATION_RECEIPT,
  EMAIL_OBSERVATION_RECEIPT,
} from "./assessment-email";
import {
  touchingAssessmentQuery,
  reviewFamilyDeclarations,
  touchingAssessmentIds,
} from "./review-families";

const ctx = withTestDb();
const metadataKeys = { rule: "rule" };
type Scope = Parameters<typeof touchingAssessmentIds>[1];

/** Frozen eligibility control must not reuse the rewritten admission helpers. */
function originalEligibility(eligibility: Scope["eligibility"]) {
  if (eligibility.kind === "suggestions")
    return sql`a.served AND s.family IN (${sql.join(
      eligibility.families.map((f) => sql`${f}`),
      sql`, `,
    )}) AND s.status = ${eligibility.status} ${eligibility.status === "pending" ? sql`AND s.active` : sql``} ${eligibility.runCode ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${eligibility.runCode})` : sql``}`;
  const application = sql`EXISTS (SELECT 1 FROM "Feedback" receipt WHERE receipt."assessmentId"=a.id AND receipt.authority=${feedbackAuthority.enum.automatic} AND (receipt.metadata->>${assessmentProducer.keyof().enum.kind}=${EMAIL_APPLICATION_RECEIPT} OR receipt."operationId"=${mailboxClassificationStage.enum.resolution}))`;
  const emailAudit = sql`NOT EXISTS (SELECT 1 FROM "Feedback" member_resolution WHERE member_resolution."assessmentId"=a.id AND member_resolution."operationId"=${mailboxClassificationStage.enum.resolution} AND member_resolution.authority=${feedbackAuthority.enum.member}) AND (${application} OR NOT EXISTS (SELECT 1 FROM "Feedback" observed WHERE observed."assessmentId"=a.id AND observed.metadata->>${assessmentProducer.keyof().enum.kind}=${EMAIL_OBSERVATION_RECEIPT}))`;
  const rule = sql`(SELECT (f.metadata->${metadataKeys.rule}->>'key') || '@' || (f.metadata->${metadataKeys.rule}->>'revision') FROM "Feedback" f WHERE f."assessmentId"=a.id AND f.authority=${feedbackAuthority.enum.automatic} AND f.metadata->>${assessmentProducer.keyof().enum.kind}='assessment_application' LIMIT 1)`;
  const families = Object.keys(reviewFamilyDeclarations);
  const automatic = Object.entries(reviewFamilyDeclarations).flatMap(
    ([f, d]) => (d.kind === "automatic_decision" ? [f] : []),
  );
  return sql`a.served AND a.family IN (${sql.join(
    families.map((f) => sql`${f}`),
    sql`, `,
  )}) AND (a.family IN (${sql.join(
    automatic.map((f) => sql`${f}`),
    sql`, `,
  )}) OR s.status <> ${suggestionStatus.enum.pending}) AND ((a.family=${assessmentFamily.enum.email_relevance} AND ${emailAudit}) OR (a.family=${assessmentFamily.enum.email_link} AND EXISTS (SELECT 1 FROM "Feedback" original WHERE original."assessmentId"=a.id AND original."operationId"=${mailboxClassificationStage.enum.decision} AND original.authority=${feedbackAuthority.enum.automatic})) OR a.family=${assessmentFamily.enum.mail_import_outcome} OR ${rule} IS NOT NULL) ${eligibility.family ? sql`AND a.family=${eligibility.family}` : sql``}`;
}

/** Frozen pre-spike control, sharing only the unchanged family reference declarations. */
function originalQuery(scope: Scope): SQL {
  const requested = scope.entity
    ? [scope.entity]
    : scope.records?.map((r) => r.entity);
  const refs = sql`CASE ${sql.join(
    Object.entries(reviewFamilyDeclarations).map(
      ([family, spec]) =>
        sql`WHEN a.family = ${family} THEN ${requested && "recordsFor" in spec ? spec.recordsFor(requested) : spec.records}`,
    ),
    sql` `,
  )} ELSE '[]'::jsonb END`;
  const records = scope.records
    ? sql`AND (${sql.join(
        scope.records.map(
          (r) =>
            sql`(r->>'entity' = ${r.entity} AND r->>'id' IN (${r.id}, ${r.code}))`,
        ),
        sql` OR `,
      )})`
    : sql``;
  return sql`WITH eligible AS MATERIALIZED (SELECT a.id, ${refs} AS refs FROM "Assessment" a JOIN "AssessmentState" s ON s.id=a.id WHERE ${originalEligibility(scope.eligibility)}) SELECT id FROM eligible WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(refs) r WHERE r->>'id' IS NOT NULL ${scope.entity ? sql`AND r->>'entity' = ${scope.entity}` : sql``} ${records})`;
}

// Differential coverage earns retention: dropping a secondary reference, admitting
// unserved/superseded proposals, or losing member Email exclusions changes review counts.
it("preserves scoped assessment identities and transaction visibility", async () => {
  const count = Number(process.env.CUBBY_ASSESSMENT_PERF ?? 96);
  const setupStart = performance.now();
  const target = crypto.randomUUID();
  const secondary = crypto.randomUUID();
  const rows: (typeof assessment.$inferInsert)[] = [];
  const states: (typeof assessmentState.$inferInsert)[] = [];
  const grades: (typeof feedback.$inferInsert)[] = [];
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    const recordId = i % 101 === 0 ? target : crypto.randomUUID();
    const base = {
      id,
      publicationKey: `synthetic:bakeoff:${i}`,
      served: i % 11 !== 0,
    };
    const variant = i % 4;
    const row: typeof assessment.$inferInsert =
      variant === 0
        ? {
            ...base,
            family: "email_relevance",
            subject: {
              kind: "email_relevance",
              entity: "email",
              recordId,
              checksum: null,
              observationId: null,
            },
            judgment: "related",
          }
        : variant === 1
          ? {
              ...base,
              family: "recommendation",
              subject: {
                kind: "recommendation",
                entity: "product",
                recordId,
                scope: "product.related",
                candidateKey: `synthetic:${i}`,
              },
              judgment: { candidateKey: `synthetic:${i}` },
              evidence: {
                records: [
                  { entity: "product", id: secondary },
                  { entity: "product", id: "PROD-SYNTHETIC" },
                  { entity: "product", id: null },
                ],
              },
            }
          : variant === 2
            ? {
                ...base,
                family: "image_description",
                subject: {
                  kind: "image_description",
                  entity: "image",
                  recordId,
                  contentHash: null,
                },
                judgment: "Synthetic image",
              }
            : {
                ...base,
                family: "field",
                subject: {
                  kind: "field",
                  entity: "product",
                  recordId,
                  field: "name",
                  draft: false,
                },
                judgment: { value: "Synthetic item" },
              };
    rows.push(row);
    states.push({
      id,
      family: row.family,
      entity: variant === 0 ? "email" : variant === 2 ? "image" : "product",
      recordId,
      field: variant === 3 ? "name" : "",
      status: i % 3 === 0 ? "applied" : "pending",
      active: i % 7 !== 0,
      suggestedValue: variant === 3 ? "Synthetic item" : sql`'null'::jsonb`,
    });
    grades.push({
      assessmentId: id,
      operationId: i % 5 === 0 ? "resolution" : `synthetic:${i}`,
      verdict: "correct",
      correction: { present: false },
      intent: "history",
      authority: i % 5 === 0 ? "member" : "automatic",
      metadata: {
        kind:
          Math.floor(i / 4) % 3 === 0
            ? "email_classification_application"
            : "email_classification_observation",
      },
    });
  }
  // Volume-only fixture: typed stored rows, real constraints, no write-path claim.
  for (let offset = 0; offset < count; offset += 500) {
    await unwrapDb(ctx.db)
      .insert(assessment)
      .values(rows.slice(offset, offset + 500));
    await unwrapDb(ctx.db)
      .insert(assessmentState)
      .values(states.slice(offset, offset + 500));
    await unwrapDb(ctx.db)
      .insert(feedback)
      .values(grades.slice(offset, offset + 500));
  }
  await unwrapDb(ctx.db).execute(
    sql`ANALYZE "Assessment", "AssessmentState", "Feedback"`,
  );
  const setupMs = performance.now() - setupStart;
  const pending: Scope["eligibility"] = {
    kind: "suggestions",
    families: [
      "field",
      "recommendation",
      "image_description",
      "email_relevance",
    ],
    status: "pending",
  };
  const automatic: Scope["eligibility"] = { kind: "automatic" };
  const scopes: [string, Scope][] = [
    ["pending-entity", { entity: "product", eligibility: pending }],
    [
      "pending-record",
      {
        records: [{ entity: "product", id: target, code: "PROD-SYNTHETIC" }],
        eligibility: pending,
      },
    ],
    [
      "secondary-record",
      {
        records: [{ entity: "product", id: secondary, code: "PROD-SYNTHETIC" }],
        eligibility: pending,
      },
    ],
    [
      "automatic-record",
      {
        records: [{ entity: "email", id: target, code: "EML-SYNTHETIC" }],
        eligibility: automatic,
      },
    ],
    ["automatic-entity", { entity: "email", eligibility: automatic }],
  ];
  const evidence: unknown[] = [{ count, setupMs }];
  for (const [name, scope] of scopes) {
    const original = originalQuery(scope);
    const expected = new Set(
      (await unwrapDb(ctx.db).execute<{ id: string }>(original)).rows.map(
        (r) => r.id,
      ),
    );
    expect(await touchingAssessmentIds(ctx.db, scope)).toEqual(expected);
    if (process.env.CUBBY_ASSESSMENT_PERF) {
      const plans = [];
      for (let repeat = 0; repeat < 3; repeat++)
        plans.push({
          old: (
            await unwrapDb(ctx.db).execute(
              sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${original}`,
            )
          ).rows,
          drizzle: (
            await unwrapDb(ctx.db).execute(
              sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${touchingAssessmentQuery(ctx.db, scope)}`,
            )
          ).rows,
        });
      evidence.push({ name, matches: expected.size, plans });
    }
  }
  await expect(
    withTransactionDatabase(ctx.db, async (tx) => {
      const id = crypto.randomUUID();
      await unwrapDb(tx)
        .insert(assessment)
        .values({
          id,
          publicationKey: "synthetic:transaction",
          family: "image_description",
          subject: {
            kind: "image_description",
            entity: "image",
            recordId: target,
            contentHash: null,
          },
          judgment: "Synthetic transaction",
        });
      await unwrapDb(tx).insert(assessmentState).values({
        id,
        family: "image_description",
        entity: "image",
        recordId: target,
      });
      expect(
        await touchingAssessmentIds(tx, {
          entity: "image",
          eligibility: pending,
        }),
      ).toContain(id);
      throw new Error("synthetic rollback");
    }),
  ).rejects.toThrow("synthetic rollback");
  expect(
    await touchingAssessmentIds(ctx.db, { eligibility: pending }),
  ).toBeNull();
  expect(
    await touchingAssessmentIds(ctx.db, { records: [], eligibility: pending }),
  ).toEqual(new Set());
  if (process.env.CUBBY_ASSESSMENT_PERF) {
    const directory = join(process.cwd(), "../../artifacts");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "assessment-bakeoff-plans.json"),
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify({ count, setupMs, scopes: scopes.length }));
  }
}, 180_000);
