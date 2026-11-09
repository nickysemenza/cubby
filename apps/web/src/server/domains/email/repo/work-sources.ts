import { emailFiltersSchema } from "@cubby/schemas/email";
import { workExecutor } from "@cubby/schemas/work-queue";
import { and, sql } from "drizzle-orm";

import { householdDaySql } from "~/server/db/helpers/query";
import { email } from "~/server/db/schema";
import { emailScaffold } from "~/server/domains/email/repo/email";
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
          executor: sql`CASE
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
];
