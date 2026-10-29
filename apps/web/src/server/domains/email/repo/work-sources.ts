import { dataCheck, type DataCheck } from "@cubby/schemas/data-quality";
import { entityQualityCheckState } from "@cubby/schemas/data-quality-shape";
import { emailFiltersSchema } from "@cubby/schemas/email";
import { oneOrManyValues } from "@cubby/schemas/pagination";
import { and, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { householdDaySql } from "~/server/db/helpers/query";
import { derivedValue } from "~/server/db/retained-tables";
import { email } from "~/server/db/schema";
import { emailScaffold } from "~/server/domains/email/repo/email";
import { storedPublicationMatch } from "~/server/generic/derived/repo/read";
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
const quality = alias(derivedValue, "work_email_quality");
const publishedGap = (check: DataCheck) =>
  sql`coalesce(${quality.value}->'checks'->>${check} = ${entityQualityCheckState.enum.gap}, false)`;
export const emailWorkSources: WorkSource[] = [
  {
    ...declaration,
    candidates: async (db, scope) => {
      const filters = gapFilters(scope, "email");
      if (!filters) return null;
      const { dataGap, ...otherFilters } = filters;
      const admittedChecks = (oneOrManyValues(dataGap) ?? []).map((check) =>
        dataCheck.parse(check),
      );
      return {
        query: selectWorkCandidates(db, declaration, {
          entity: "email",
          id: sql`${email.shortcode}`,
          name: sql`coalesce("Email".subject, 'Email')`,
          owners: sql`ARRAY["Email"."ledgerPartyId"]`,
          date: householdDaySql(sql`"Email"."receivedAt"`),
          ...gapColumns(scope, "email", publishedGap),
        })
          .from(email)
          .leftJoin(
            quality,
            storedPublicationMatch(quality, {
              entity: declaration.entity,
              id: email.id,
              key: "dataQuality",
            }),
          )
          .where(
            and(
              await emailScaffold.prepareWhere(
                db,
                emailFiltersSchema.parse(otherFilters),
              ),
              admittedChecks.length
                ? or(...admittedChecks.map(publishedGap))
                : undefined,
              recordScope(scope, sql`${email.shortcode}`),
            ),
          ),
      };
    },
  },
];
