import {
  assessmentFamily,
  feedbackVerdict,
  feedbackAuthority,
  mailDecisionFamily,
} from "@cubby/schemas/assessment";
import {
  automaticDecisionListInput,
  automaticDecisionListOut,
  automaticDecisionRow,
} from "@cubby/schemas/automatic-decision";
import { correctionAuthorityReceiptKinds } from "@cubby/schemas/suggestion-correction";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import {
  mailAutomaticDecisionBranches,
  mailDecisionPresentation,
} from "~/server/domains/purchase-import/repo/mail-automatic-decisions";
import { automaticApplicationRule } from "~/server/generic/assessment/repo/assessment";
import { readCorrectionOutcomes } from "~/server/generic/assessment/repo/correction-outcomes";
import { correctionOutcomeExists } from "~/server/generic/assessment/repo/correction-receipt";
import { resolveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  automaticAssessmentEligibility,
  isReviewFamily,
  readAssessmentRecordRefs,
  resolveStoredRecordRefs,
  reviewFamilyDeclarations,
  touchingAssessmentIds,
} from "./review-families";

/**
 * Automatic history includes old pending projections, superseded decisions, and
 * subsequent Wrong grades. Mail decisions read from their domain owners.
 */
export async function listAutomaticDecisions(
  db: Database,
  raw: z.input<typeof automaticDecisionListInput>,
) {
  const input = automaticDecisionListInput.parse(raw);
  const resolved = input.recordIds
    ? await resolveShortcodes(db, input.recordIds)
    : null;
  const records = resolved
    ? [...resolved].map(([code, record]) => ({ code, ...record }))
    : undefined;
  const mailFamily = mailDecisionFamily.safeParse(input.family).data;
  const assessmentFamilyFilter =
    input.family && isReviewFamily(input.family) ? input.family : undefined;
  const includesAssessments = !mailFamily;
  const rule = automaticApplicationRule(sql`a.id`);
  const touching = includesAssessments
    ? await touchingAssessmentIds(db, {
        records,
        eligibility: {
          kind: "automatic",
          family: assessmentFamilyFilter,
          appliedRule: automaticApplicationRule,
        },
      })
    : null;
  const reviewFilter =
    input.reviewStatus === "wrong"
      ? sql`AND latest.verdict = ${feedbackVerdict.enum.wrong}`
      : input.reviewStatus === "unreviewed"
        ? sql`AND latest.id IS NULL`
        : input.reviewStatus === "reviewed"
          ? sql`AND latest.id IS NOT NULL`
          : sql``;
  const branches: { page: SQL; count: SQL }[] = [];
  if (includesAssessments && touching?.size !== 0) {
    // Record-scoped discovery has already proved automatic admission. Repeating
    // it here validates the same correction receipts for the count and page.
    const admission = touching
      ? sql`a.id = ANY(${uuidArrayParam([...touching])})`
      : sql`a.served AND ${automaticAssessmentEligibility(rule)}
        ${assessmentFamilyFilter ? sql`AND a.family = ${assessmentFamilyFilter}` : sql``}`;
    const from = sql`FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id
      LEFT JOIN LATERAL (SELECT f.id, f.verdict, f."createdAt" FROM "Feedback" f
        WHERE f."assessmentId" = a.id AND f.authority = ${feedbackAuthority.enum.member} AND f."operationId" <> ${"decision"}
          AND f.metadata->>${"kind"} IS DISTINCT FROM ${correctionAuthorityReceiptKinds.enum.assessment_application}
        ORDER BY f."createdAt" DESC, f.id DESC LIMIT 1) latest ON true`;
    const correctionOrder = sql`LEFT JOIN LATERAL (SELECT c."createdAt" FROM "Feedback" c
        WHERE c."assessmentId" = a.id AND ${correctionOutcomeExists(sql`a.id`, sql`c.id`, true)}
        ORDER BY c."createdAt" DESC, c.id DESC LIMIT 1) latest_correction ON true`;
    branches.push({
      page: sql`SELECT a.id, a.family::text AS family, a.judgment, a."createdAt", s.fingerprint,
        ${rule} AS "automaticRule", true AS "applicationVerified", latest.verdict,
        latest."createdAt" AS "reviewedAt", s.active, s.status,
        coalesce(latest_correction."createdAt", a."createdAt") AS "sortAt", NULL::jsonb AS refs
        ${from} ${correctionOrder} WHERE ${admission} ${reviewFilter}`,
      count: sql`SELECT count(*)::int AS count ${from} WHERE ${admission} ${reviewFilter}`,
    });
  }
  if (mailFamily || !input.family)
    for (const branch of mailAutomaticDecisionBranches({
      family: mailFamily,
      scope: records
        ? {
            emailIds: records
              .filter((record) => record.entity === "email")
              .map((record) => record.id),
            purchaseIds: records
              .filter((record) => record.entity === "purchase")
              .map((record) => record.id),
          }
        : null,
      reviewFilter,
    }))
      branches.push({
        page: branch,
        count: sql`SELECT count(*)::int AS count FROM (${branch}) mail_decisions`,
      });
  if (!branches.length)
    return automaticDecisionListOut.parse({
      items: [],
      totalCount: 0,
      nextOffset: null,
    });
  const totals = await Promise.all(
    branches.map(({ count }) => unwrapDb(db).execute<{ count: number }>(count)),
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
    refs: unknown;
  }>(sql`
    SELECT * FROM (${sql.join(
      branches.map(({ page }) => sql`(${page})`),
      sql` UNION ALL `,
    )}) decisions
    ORDER BY "sortAt" DESC, id DESC LIMIT ${input.limit} OFFSET ${input.offset}`);
  const assessmentIds = rows
    .filter((row) => row.refs === null)
    .map((row) => row.id);
  const stored = await readAssessmentRecordRefs(db, assessmentIds);
  const mailRefs = await resolveStoredRecordRefs(
    db,
    rows.flatMap((row) =>
      row.refs === null ? [] : [{ id: row.id, refs: row.refs }],
    ),
  );
  const corrections = await readCorrectionOutcomes(db, assessmentIds);
  const items = rows.map((row) => {
    const family = assessmentFamily.parse(row.family);
    const mail = mailDecisionFamily.safeParse(family).data;
    if (!mail && !isReviewFamily(family))
      throw new Error(`${family} Assessments are not automatic decisions`);
    const presentation = mail
      ? mailDecisionPresentation[mail]
      : isReviewFamily(family)
        ? reviewFamilyDeclarations[family]
        : null;
    const correction = corrections.get(row.id);
    const originalSummary =
      presentation && "summarize" in presentation
        ? presentation.summarize(z.json().parse(row.judgment))
        : isReviewFamily(family)
          ? reviewFamilyDeclarations[family].label
          : family;
    const summary =
      correction?.outcome.status === "applied"
        ? `Automatically corrected to ${JSON.stringify(correction.correctedValue)}`
        : correction?.outcome.status === "held"
          ? `Automatic correction held: ${correction.outcome.reason}`
          : correction?.outcome.status === "unchanged"
            ? "Automatic correction required no change"
            : originalSummary;
    return automaticDecisionRow.parse({
      id: row.id,
      family,
      records: (mail ? mailRefs : stored).get(row.id) ?? [],
      decision: row.judgment,
      applicationVerified:
        correction?.outcome.status === "held" && row.automaticRule === null
          ? false
          : row.applicationVerified,
      correctionAttempt: correction?.attempt ?? null,
      summary,
      createdAt: new Date(row.createdAt).toISOString(),
      fingerprint: row.fingerprint,
      automaticRule: row.automaticRule,
      verdict: row.verdict === null ? null : feedbackVerdict.parse(row.verdict),
      reviewedAt: row.reviewedAt
        ? new Date(row.reviewedAt).toISOString()
        : null,
      correction:
        correction?.outcome.status !== "held" &&
        row.active &&
        row.status !== "applied" &&
        presentation &&
        "correction" in presentation
          ? presentation.correction
          : null,
    });
  });
  const totalCount = totals.reduce(
    (sum, total) => sum + (total.rows[0]?.count ?? 0),
    0,
  );
  return automaticDecisionListOut.parse({
    items,
    totalCount,
    nextOffset:
      input.offset + items.length < totalCount
        ? input.offset + items.length
        : null,
  });
}
