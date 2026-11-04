import {
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { and, getTableName, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { outer } from "~/server/db/helpers/related";
import { entityIdentity } from "~/server/db/schema";
import { workExpenseSourceOwners } from "~/server/domains/expense/repo/work-owners";
import { financialTransactionWorkOwners } from "~/server/domains/financial-transaction/repo/work-facts";
import {
  workImageOwners,
  workImageIsShared,
} from "~/server/domains/image/repo/work-owners";
import { workPurchaseSourceOwners } from "~/server/domains/purchase/repo/work-owners";
import { workRunReviewOwners } from "~/server/domains/run/repo/work-owners";
import { workRecordFactsFor } from "~/server/domains/work/repo/record-facts";
import {
  publishedAssessmentRecordRefsSql,
  publishedAssessmentCoverageSql,
  type AssessmentPublishedScope,
} from "~/server/generic/assessment/repo/read-publication";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { SHORTCODE_TABLE } from "~/server/generic/shortcode/repo/shortcode-tables";
import { recordScope } from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

const recordAuthority = (entity: ShortcodeEntity, id: SQL) => {
  switch (entity) {
    case "purchase":
      return { owners: workPurchaseSourceOwners(id), shared: false };
    case "expense":
      return { owners: workExpenseSourceOwners(id), shared: false };
    case "image":
      return { owners: workImageOwners(id), shared: workImageIsShared(id) };
    case "run":
      return { owners: workRunReviewOwners(id), shared: false };
    case "financialTransaction":
      return { owners: financialTransactionWorkOwners(id), shared: false };
    case "financialAccount":
      return {
        owners: sql`ARRAY["FinancialAccount"."ledgerPartyId"]`,
        shared: false,
      };
    case "vendorAccount":
      return {
        owners: sql`ARRAY["VendorAccount"."ledgerPartyId"]`,
        shared: false,
      };
    case "email":
      return { owners: sql`ARRAY["Email"."ledgerPartyId"]`, shared: false };
    default:
      return { owners: sql`ARRAY[]::uuid[]`, shared: true };
  }
};

const source: WorkSource = {
  id: "pending-suggestions",
  family: "suggestion",
  executor: "human",
  entity: null,
  inputLabel: "Assessment review coverage",
  link: { kind: "suggestions" },
  reasons: Object.entries({
    field: "Pending field suggestions",
    image_description: "Pending image descriptions",
    recommendation: "Pending connection suggestions",
    statement_transaction: "Pending statement transactions",
    transfer_pair: "Pending transfer pairs",
    product_pair: "Pending product pairs",
  }).map(([family, label]) => ({ key: `suggestions:${family}`, label })),
  candidates: async (db, scope) => {
    const selection: AssessmentPublishedScope = scope.record
      ? {
          entity: scope.record.entity,
          records: [
            {
              entity: scope.record.entity,
              id: await resolveOrThrow(
                db,
                scope.record.entity,
                scope.record.id,
              ),
              code: scope.record.id,
            },
          ],
        }
      : {};
    const identity = alias(entityIdentity, "work_identity");
    const queries = shortcodeEntities
      .filter((entity) => !scope.record || scope.record.entity === entity)
      .map((entity) => {
        const table = SHORTCODE_TABLE[entity];
        return selectWorkCandidates(db, source, {
          entity,
          id: sql`${table.shortcode}`,
          name: labelSql(entity, `"${getTableName(table)}"`),
          reason: "Pending suggestions",
          reasonKeys: sql`pending.reason_keys`,
          ...recordAuthority(entity, outer(table.id)),
          ...workRecordFactsFor(entity),
        })
          .from(table)
          .innerJoin(
            sql`work_pending_records pending`,
            sql`pending.entity = ${entity} AND pending.record_id = ${table.id}`,
          )
          .where(
            and(
              "deletedAt" in table ? notDeleted(table) : undefined,
              recordScope(scope, sql`${table.shortcode}`),
            ),
          );
      });
    return {
      query: sql.join(
        queries.map((query) => sql`(${query})`),
        sql` UNION ALL `,
      ),
      // Global conservative flags have no record count and must share this statement's snapshot.
      inputCoverage: sql`SELECT concat_ws(' ', ${"Global Assessment coverage:"}::text,
        CASE WHEN missing THEN ${"Some open Assessment reviews have no publication."}::text END,
        CASE WHEN stale THEN ${"Published Assessment reviews may be out of date."}::text END,
        CASE WHEN unresolved THEN ${"Review dependencies or memberships remain unresolved."}::text END,
        CASE WHEN failed THEN ${"Assessment refresh work has failed."}::text END
      ) AS message FROM (${publishedAssessmentCoverageSql()}) coverage
      WHERE missing OR stale OR unresolved OR failed`,
      ctes: [
        {
          name: "work_published_suggestion_refs",
          sql: publishedAssessmentRecordRefsSql(selection),
        },
        {
          name: "work_pending_records",
          sql: sql`SELECT work_identity.kind AS entity, work_identity.id AS record_id,
          array_agg(DISTINCT ('suggestions:' || family) ORDER BY ('suggestions:' || family)) AS reason_keys
          FROM work_published_suggestion_refs refs
          JOIN "Entity" work_identity ON work_identity.kind = refs.entity AND work_identity.shortcode = refs."recordCode"
          CROSS JOIN LATERAL unnest(refs.families) family
          WHERE ${notDeleted(identity)} AND work_identity."mergedIntoId" IS NULL
          GROUP BY work_identity.kind, work_identity.id`,
        },
      ],
    };
  },
};
export const pendingSuggestionsWorkSource = source;
