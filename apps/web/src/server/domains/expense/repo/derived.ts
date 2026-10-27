import { expenseBeneficiaryPortion } from "@cubby/schemas/expense-beneficiaries";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, inArray } from "drizzle-orm";

import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { expense } from "~/server/db/schema";
import { loadExpenseBeneficiaryPortions } from "~/server/domains/household-contribution/repo/allocation";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";

const expenseBeneficiariesCompute: DerivedCompute = async (db, ids) => {
  const live = await unwrapDb(db)
    .select({ id: expense.id })
    .from(expense)
    .where(
      and(
        inArray(
          expense.id,
          ids.map((id) => parseEntityId("expense", id)),
        ),
        notDeleted(expense),
      ),
    );
  const portions = await loadExpenseBeneficiaryPortions(
    db,
    live.map(({ id }) => id),
  );
  return new Map(
    live.map(({ id }) => [
      id,
      {
        value: {
          portions: (portions.get(id) ?? []).map((portion) =>
            expenseBeneficiaryPortion.parse(portion),
          ),
          evidence: portions.get(id) ?? [],
        },
        sort: null,
      } satisfies DerivedComputed,
    ]),
  );
};

export const expenseDerivedComputes = {
  "expense.beneficiaries": expenseBeneficiariesCompute,
};
