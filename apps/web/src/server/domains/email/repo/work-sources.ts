import { emailFilters } from "@cubby/schemas/email";
import { and, sql } from "drizzle-orm";

import { householdDaySql } from "~/server/db/helpers/query";
import { email } from "~/server/db/schema";
import { buildEmailWhere } from "~/server/domains/email/repo/email";
import {
  gapDeclaration,
  gapFilters,
  gapColumns,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";
const declaration = gapDeclaration("email");
export const emailWorkSources: WorkSource[] = [
  {
    ...declaration,
    candidates: async (db, scope) => {
      const filters = gapFilters(scope, "email");
      if (!filters) return null;
      return {
        query: selectWorkCandidates(db, declaration, {
          entity: "email",
          id: sql`${email.shortcode}`,
          name: sql`coalesce("Email".subject, 'Email')`,
          owners: sql`ARRAY["Email"."ledgerPartyId"]`,
          date: householdDaySql(sql`"Email"."receivedAt"`),
          ...gapColumns(scope, "email"),
        })
          .from(email)
          .where(
            and(
              buildEmailWhere(emailFilters.parse(filters)),
              recordScope(scope, sql`${email.shortcode}`),
            ),
          ),
      };
    },
  },
];
