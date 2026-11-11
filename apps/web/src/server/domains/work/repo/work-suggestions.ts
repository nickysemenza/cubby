import { suggestionStatus } from "@cubby/schemas/ai";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { suggestionListFamily } from "@cubby/schemas/suggestion-list";
import { and, getTableName, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { outer } from "~/server/db/helpers/related";
import { entityIdentity } from "~/server/db/schema";
import { workRecordFactsFor } from "~/server/domains/work/repo/record-facts";
import { workSourceAuthority } from "~/server/domains/work/repo/record-owners";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { SHORTCODE_TABLE } from "~/server/generic/shortcode/repo/shortcode-tables";
import { touchingSuggestionIds } from "~/server/generic/suggestions/repo/suggestion-touching";
import {
  pendingSuggestionRecordsSql,
  UNAPPLIED_CORRECTION_REASON,
} from "~/server/generic/suggestions/repo/suggestion-work-tokens";
import { recordScope } from "~/server/generic/work-queue/repo/work-declarations";
import {
  admittedReasons,
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const source: WorkSource = {
  id: "pending-suggestions",
  family: "suggestion",
  executor: "human",
  entity: null,
  link: { kind: "suggestions" },
  admittedReasonsOnly: true,
  reasons: Object.entries({
    field: "Pending field suggestions",
    recommendation: "Pending connection suggestions",
    statement_transaction: "Pending statement transactions",
    transfer_pair: "Pending transfer pairs",
    product_pair: "Pending product pairs",
    [UNAPPLIED_CORRECTION_REASON]: "Unapplied member correction",
  }).map(([family, label]) => ({ key: `suggestions:${family}`, label })),
  candidates: async (db, scope) => {
    // A record read discovers its own suggestions; the unscoped queue reads State.
    const ids = scope.record
      ? await touchingSuggestionIds(db, {
          entity: scope.record.entity,
          includeRelated: true,
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
          eligibility: {
            kind: "suggestions",
            families: suggestionListFamily.options,
            status: suggestionStatus.enum.pending,
          },
        })
      : null;
    if (ids?.size === 0) return null;
    const liveIdentity = sql`${notDeleted(alias(entityIdentity, "work_identity"))} AND work_identity."mergedIntoId" IS NULL`;
    const queries = await Promise.all(
      shortcodeEntities
        .filter((entity) => !scope.record || scope.record.entity === entity)
        .map(async (entity) => {
          const table = SHORTCODE_TABLE[entity];
          const query = selectWorkCandidates(db, source, {
            entity,
            id: sql`${table.shortcode}`,
            name: await labelSql(entity, `"${getTableName(table)}"`),
            reason: "Pending suggestions",
            reasonKeys: sql`pending.reason_keys`,
            ...workSourceAuthority(entity, outer(table.id)),
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
          return sql`${query}`;
        }),
    );
    return {
      query: sql.join(
        queries.map((query) => sql`(${query})`),
        sql` UNION ALL `,
      ),
      ctes: [
        {
          name: "work_suggestion_refs",
          sql: sql`SELECT family, entity, token,
            CASE WHEN token ~ ${UUID_PATTERN} THEN token::uuid END AS record_uuid
            FROM (${pendingSuggestionRecordsSql(
              ids ? [...ids] : undefined,
              new Set(
                admittedReasons(scope, source.reasons).map((reason) =>
                  reason.key.slice("suggestions:".length),
                ),
              ),
            )}) refs`,
        },
        {
          name: "work_pending_records",
          sql: sql`SELECT entity, record_id,
            array_agg(DISTINCT ('suggestions:' || family) ORDER BY ('suggestions:' || family)) AS reason_keys
          FROM (
            SELECT refs.family, work_identity.kind AS entity, work_identity.id AS record_id
            FROM work_suggestion_refs refs
            JOIN "Entity" work_identity ON work_identity.kind = refs.entity AND work_identity.id = refs.record_uuid
            WHERE ${liveIdentity}
            UNION ALL
            SELECT refs.family, work_identity.kind, work_identity.id
            FROM work_suggestion_refs refs
            JOIN "Entity" work_identity ON work_identity.kind = refs.entity AND work_identity.shortcode = refs.token
            WHERE refs.record_uuid IS NULL AND ${liveIdentity}
          ) identities
          GROUP BY entity, record_id`,
        },
      ],
    };
  },
};
export const pendingSuggestionsWorkSource = source;
