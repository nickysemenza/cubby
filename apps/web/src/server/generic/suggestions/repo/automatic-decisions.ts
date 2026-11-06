import {
  automaticDecisionListInput,
  automaticDecisionListOut,
  automaticDecisionRow,
} from "@cubby/schemas/automatic-decision";
import {
  suggestionFamily,
  feedbackVerdict,
  feedbackAuthority,
  mailDecisionFamily,
} from "@cubby/schemas/suggestion";
import { correctionAuthorityReceiptKinds } from "@cubby/schemas/suggestion-correction";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import {
  mailAutomaticDecisionBranches,
  mailDecisionPresentation,
} from "~/server/domains/purchase-import/repo/mail-automatic-decisions";
import { resolveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { automaticApplicationRule } from "~/server/generic/suggestions/repo/suggestion";
import { suggestionFamilies as reviewFamilyDeclarations } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import { isReviewFamily } from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import {
  readSuggestionRecordRefs,
  resolveStoredRecordRefs,
} from "~/server/generic/suggestions/repo/suggestion-reference-resolution";
import { touchingSuggestionIds } from "~/server/generic/suggestions/repo/suggestion-touching";
import { automaticSuggestionEligibility } from "~/server/generic/suggestions/repo/suggestion-work-tokens";

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
  const suggestionFamilyFilter =
    input.family && isReviewFamily(input.family) ? input.family : undefined;
  const includesSuggestions = !mailFamily;
  const rule = automaticApplicationRule(sql`s.id`);
  const touching = includesSuggestions
    ? await touchingSuggestionIds(db, {
        records,
        eligibility: {
          kind: "automatic",
          family: suggestionFamilyFilter,
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
  if (includesSuggestions && touching?.size !== 0) {
    // Record-scoped discovery has already proved automatic admission. Repeating
    // it here validates the same correction receipts for the count and page.
    const admission = touching
      ? sql`s.id = ANY(${uuidArrayParam([...touching])})`
      : sql`${automaticSuggestionEligibility(rule)}
        ${suggestionFamilyFilter ? sql`AND s.family = ${suggestionFamilyFilter}` : sql``}`;
    const from = sql`FROM "Suggestion" s
      LEFT JOIN LATERAL (SELECT f.id, f.verdict, f."createdAt"
        FROM jsonb_to_recordset(s.decisions) f(id text, verdict text, "createdAt" text, authority text, "operationId" text, metadata jsonb)
        WHERE f.authority = ${feedbackAuthority.enum.member} AND f."operationId" <> ${"decision"}
          AND f.metadata->>${"kind"} IS DISTINCT FROM ${correctionAuthorityReceiptKinds.enum.assessment_application}
        ORDER BY f."createdAt" DESC, f.id DESC LIMIT 1) latest ON true`;
    branches.push({
      page: sql`SELECT s.id, s.family::text AS family, s.judgment, s."createdAt", s.fingerprint,
        ${rule} AS "automaticRule", true AS "applicationVerified", latest.verdict,
        (latest."createdAt"::timestamptz AT TIME ZONE 'UTC') AS "reviewedAt", s.active, s.status,
        s."createdAt" AS "sortAt", NULL::jsonb AS refs
        ${from} WHERE ${admission} ${reviewFilter}`,
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
  const suggestionIds = rows
    .filter((row) => row.refs === null)
    .map((row) => row.id);
  const stored = await readSuggestionRecordRefs(db, suggestionIds);
  const mailRefs = await resolveStoredRecordRefs(
    db,
    rows.flatMap((row) =>
      row.refs === null ? [] : [{ id: row.id, refs: row.refs }],
    ),
  );
  const items = rows.map((row) => {
    const family = suggestionFamily.parse(row.family);
    const mail = mailDecisionFamily.safeParse(family).data;
    if (!mail && !isReviewFamily(family))
      throw new Error(`${family} Suggestions are not automatic decisions`);
    const presentation = mail
      ? mailDecisionPresentation[mail]
      : isReviewFamily(family)
        ? reviewFamilyDeclarations[family]
        : null;
    const summary =
      presentation && "summarize" in presentation && presentation.summarize
        ? presentation.summarize(z.json().parse(row.judgment))
        : isReviewFamily(family)
          ? reviewFamilyDeclarations[family].label
          : family;
    return automaticDecisionRow.parse({
      id: row.id,
      family,
      records: (mail ? mailRefs : stored).get(row.id) ?? [],
      decision: row.judgment,
      applicationVerified: row.applicationVerified,
      summary,
      createdAt: new Date(row.createdAt).toISOString(),
      fingerprint: row.fingerprint,
      automaticRule: row.automaticRule,
      verdict: row.verdict === null ? null : feedbackVerdict.parse(row.verdict),
      reviewedAt: row.reviewedAt
        ? new Date(row.reviewedAt).toISOString()
        : null,
      correction:
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
