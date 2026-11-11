import { emailFiltersSchema } from "@cubby/schemas/email";
import {
  emailImportOutcome,
  MAIL_IMPORT_GAP_OUTCOME,
} from "@cubby/schemas/email-fields";
import { workExecutor } from "@cubby/schemas/work-queue";
import { and, eq, sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { householdDaySql } from "~/server/db/helpers/query";
import { email } from "~/server/db/schema";
import { emailScaffold } from "~/server/domains/email/repo/email";
import { cachedEmailAcceptedSql } from "~/server/domains/email/repo/email-purchase-links";
import { emailImportOutcomeSql } from "~/server/domains/email/repo/import-outcome";
import {
  gapDeclaration,
  gapPublicationRead,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";
const declaration = gapDeclaration("email", "dynamic");
const { human, agent, automatic } = workExecutor.enum;
const OUTCOME = emailImportOutcome.enum;

/**
 * Each Email a Mail import left unresolved is its own item, routed by who
 * settles its gap: an agent researches it, or only the member decides. Gaps
 * Cubby settles by itself (a held source, a transient failure) are no item.
 */
const importGap: WorkSource = {
  id: "email:import-gap",
  family: "email",
  executor: "dynamic",
  entity: "email",
  link: { kind: "record" },
  reasons: [{ key: "email:import-gap", label: "Unresolved mail import" }],
  candidates: async (db, scope) => {
    const outcome = emailImportOutcomeSql(cachedEmailAcceptedSql());
    return {
      query: selectWorkCandidates(db, importGap, {
        entity: "email",
        id: sql`${email.shortcode}`,
        name: sql`coalesce("Email".subject, 'Email')`,
        owners: sql`ARRAY["Email"."ledgerPartyId"]`,
        exclusiveOwner: sql`"Email"."ledgerPartyId"`,
        date: householdDaySql(sql`"Email"."receivedAt"`),
        executor: sql`CASE ${outcome} WHEN ${MAIL_IMPORT_GAP_OUTCOME.human} THEN ${human} ELSE ${agent} END`,
        reason: importGap.reasons[0]!.label,
        reasonKeys: [importGap.id],
      })
        .from(email)
        .where(
          and(
            // An unresolved outcome settles its Email `unsettled`.
            eq(email.status, "unsettled"),
            notDeleted(email),
            sql`${outcome} IN (${OUTCOME.needs_research}, ${OUTCOME.needs_member})`,
            recordScope(scope, sql`${email.shortcode}`),
          ),
        ),
    };
  },
};
/** Only undecided relevance needs the member. Import and preview gaps close
 * through background Mail import, and a missing original needs an agent. */
export const emailWorkSources: WorkSource[] = [
  {
    ...declaration,
    candidates: async (db, scope) => {
      const readGap = gapPublicationRead({ scope, entity: "email" });
      if (!readGap) return null;
      const baseWhere = await emailScaffold.prepareWhere(
        db,
        emailFiltersSchema.parse(readGap.filters),
      );
      const candidates = (missingInputs: boolean) =>
        selectWorkCandidates(db, declaration, {
          entity: "email",
          id: sql`${email.shortcode}`,
          name: sql`coalesce("Email".subject, 'Email')`,
          owners: sql`ARRAY["Email"."ledgerPartyId"]`,
          exclusiveOwner: sql`"Email"."ledgerPartyId"`,
          date: householdDaySql(sql`"Email"."receivedAt"`),
          // An unpublished Email may still need relevance review.
          executor: sql`CASE
            WHEN ${readGap.missingInputs} THEN ${human}
            WHEN ${readGap.failed("email_relevance_undecided")} THEN ${human}
            WHEN ${readGap.failed("email_original_missing")} THEN ${agent}
            ELSE ${automatic} END`,
          ...readGap.columns,
          ...(missingInputs ? readGap.missingColumns : {}),
        })
          .from(email)
          .leftJoin(readGap.publication, readGap.match)
          .where(
            and(
              baseWhere,
              missingInputs ? readGap.missingInputs : readGap.admission,
              recordScope(scope, sql`${email.shortcode}`),
            ),
          );
      return { query: candidates(false), missingInputs: candidates(true) };
    },
  },
  importGap,
];
