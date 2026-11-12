import { entitySchema } from "@cubby/schemas/entity";
import { eq, sql } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import { related } from "~/server/db/helpers/related";
import { expense, purchase } from "~/server/db/schema";

/** Defer every family before counts. An empty purchase has unknown intent. */
export const plannedPurchaseWorkDeferral = () =>
  sql`work.entity = ${entitySchema.enum.purchase} AND ${related(
    purchase,
    (planned) => sql`${planned.shortcode} = work.id`,
  )
    .where(
      (planned) =>
        sql`${planned.date} > ${householdLocalDate(new Date())}::date OR (${related(expense, (line) => eq(line.purchaseId, planned.id)).exists()} AND NOT ${related(
          expense,
          (line) => eq(line.purchaseId, planned.id),
        )
          .where((line) => sql`${line.future} = false`)
          .exists()})`,
    )
    .exists()}`;
