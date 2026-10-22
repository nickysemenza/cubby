import {
  assessmentFamily,
  feedbackVerdict,
  feedbackAuthority,
} from "@cubby/schemas/assessment";
import {
  automaticDecisionListInput,
  automaticDecisionListOut,
  automaticDecisionRow,
} from "@cubby/schemas/automatic-decision";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { automaticApplicationRule } from "~/server/generic/assessment/repo/assessment";
import { resolveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  automaticFamilyEligibility,
  automaticAssessmentCandidate,
  automaticApplicationVerified,
  isReviewFamily,
  readAssessmentRecordRefs,
  reviewFamilyDeclarations,
  touchingAssessmentIds,
} from "./review-families";

/** Automatic history includes old pending projections, superseded decisions, and subsequent Wrong grades. */
export async function listAutomaticDecisions(
  db: Database,
  raw: z.input<typeof automaticDecisionListInput>,
) {
  const input = automaticDecisionListInput.parse(raw);
  const resolved = input.recordIds
    ? await resolveShortcodes(db, input.recordIds)
    : null;
  const rule = automaticApplicationRule(sql`a.id`);
  const touching = await touchingAssessmentIds(db, {
    records: resolved
      ? [...resolved].map(([code, record]) => ({ code, ...record }))
      : undefined,
    eligibility: sql`a.served AND ${automaticAssessmentCandidate} AND (${automaticFamilyEligibility} OR ${rule} IS NOT NULL)
      ${input.family ? sql`AND a.family = ${input.family}` : sql``}`,
  });
  if (touching?.size === 0)
    return automaticDecisionListOut.parse({
      items: [],
      totalCount: 0,
      nextOffset: null,
    });
  const where = sql`a.served AND ${automaticAssessmentCandidate} AND (
    ${automaticFamilyEligibility}
    OR ${rule} IS NOT NULL)
    ${input.family ? sql`AND a.family = ${input.family}` : sql``}
    ${touching ? sql`AND a.id = ANY(${uuidArrayParam([...touching])})` : sql``}
    ${input.reviewStatus === "wrong" ? sql`AND latest.verdict = ${feedbackVerdict.enum.wrong}` : input.reviewStatus === "unreviewed" ? sql`AND latest.id IS NULL` : input.reviewStatus === "reviewed" ? sql`AND latest.id IS NOT NULL` : sql``}`;
  const from = sql`FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id
    LEFT JOIN LATERAL (SELECT f.id, f.verdict, f."createdAt" FROM "Feedback" f
      WHERE f."assessmentId" = a.id AND f.authority = ${feedbackAuthority.enum.member} AND f."operationId" <> ${"decision"}
        AND f.metadata->>${"kind"} IS DISTINCT FROM 'assessment_application'
      ORDER BY f."createdAt" DESC, f.id DESC LIMIT 1) latest ON true`;
  const total = await unwrapDb(db).execute<{ count: number }>(
    sql`SELECT count(*)::int AS count ${from} WHERE ${where}`,
  );
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    family: unknown;
    judgment: unknown;
    createdAt: Date | string;
    fingerprint: string | null;
    automaticRule: string | null;
    verdict: unknown;
    reviewedAt: Date | string | null;
    active: boolean;
    status: string;
    applicationVerified: boolean;
  }>(sql`
    SELECT a.id, a.family, a.judgment, a."createdAt", s.fingerprint, ${rule} AS "automaticRule", ${automaticApplicationVerified} AS "applicationVerified", latest.verdict,
      latest."createdAt" AS "reviewedAt", s.active, s.status ${from} WHERE ${where}
    ORDER BY a."createdAt" DESC, a.id DESC LIMIT ${input.limit} OFFSET ${input.offset}`);
  const records = await readAssessmentRecordRefs(
    db,
    rows.map((row) => row.id),
  );
  const items = rows.map((row) => {
    const family = assessmentFamily.parse(row.family);
    if (!isReviewFamily(family))
      throw new Error(`${family} Assessments are not automatic decisions`);
    const declaration = reviewFamilyDeclarations[family];
    return automaticDecisionRow.parse({
      id: row.id,
      family,
      records: records.get(row.id) ?? [],
      decision: row.judgment,
      applicationVerified: row.applicationVerified,
      summary:
        "summarize" in declaration
          ? declaration.summarize(z.json().parse(row.judgment))
          : declaration.label,
      createdAt: new Date(row.createdAt).toISOString(),
      fingerprint: row.fingerprint,
      automaticRule: row.automaticRule,
      verdict: row.verdict === null ? null : feedbackVerdict.parse(row.verdict),
      reviewedAt: row.reviewedAt
        ? new Date(row.reviewedAt).toISOString()
        : null,
      correction:
        row.active && row.status !== "applied" && "correction" in declaration
          ? declaration.correction
          : null,
    });
  });
  const totalCount = total.rows[0]?.count ?? 0;
  return automaticDecisionListOut.parse({
    items,
    totalCount,
    nextOffset:
      input.offset + items.length < totalCount
        ? input.offset + items.length
        : null,
  });
}
